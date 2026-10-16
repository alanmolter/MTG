"""Add the decaying BC KL term to IMPALA's learner loss.

The legacy stack (``enable_rl_module_and_learner=False``) computes that loss
in ``ImpalaTorchPolicy.loss``. ``--bc-kl-coeff`` used to land only in
``custom_model_config`` and was never read again. This module subclasses that
policy so the term is part of the tensor the optimizer steps on.

``bc_kl`` in the policy stats is the weighted term. It follows
``kl_coeff_for_iter`` and is 0 once the training iteration is at least
``bc_kl_iters``. ``--bc-kl-iters`` counts Tune training iterations. IMPALA's
learner may run several optimizer steps inside one of those iterations, so
the schedule must not read ``num_grad_updates``.

One-iteration lag
-----------------
The legacy IMPALA stack does not optimize the batch inside the same
``training_step`` that enqueues it. The learner thread steps that batch on
a later call, usually the next one, and ``loss()`` reads the stamp from
that later call. The coefficient on a sample is therefore one training
iteration after the iteration that collected it. Tune increments
``training_iteration`` after ``step()`` returns, so a logged iteration ``k``
was optimized with schedule index ``k - 1`` (index 0 on the first step).
That lag is not an extra gradient update: every optimizer step inside one
``training_step`` still shares one coefficient.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from ml_engine.bc.regularize import kl_coeff_for_iter


logger = logging.getLogger("ml_engine.ray_cluster.bc_kl_policy")

# Last iteration ``publish_bc_kl_training_iteration`` observed. ``loss()``
# uses it to notice a missing stamp after training has already moved on.
_last_publish_iteration: Optional[int] = None


def apply_bc_kl_to_loss(base_loss: Any, penalty: Any) -> Any:
    if isinstance(base_loss, (list, tuple)):
        updated = list(base_loss)
        updated[0] = updated[0] + penalty
        return updated
    return base_loss + penalty


def _as_int(value: Any) -> Optional[int]:
    """Integers only. ``bool`` is a subclass of ``int`` and is not a counter."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def read_training_iteration(algorithm: Any) -> int:
    """Completed Tune training iterations, the unit of ``--bc-kl-iters``.

    ``Trainable.step`` runs while ``iteration`` is still the number of
    finished iterations, then increments it. The first training step is
    therefore 0, which is full KL weight in ``kl_coeff_for_iter``.
    """

    for name in ("training_iteration", "iteration", "_iteration"):
        found = _as_int(getattr(algorithm, name, None))
        if found is not None:
            return found
    return 0


def local_policies(algorithm: Any) -> list:
    """Policies on the learner worker. Remote rollout workers do not own the loss."""

    workers = []
    for attr in ("env_runner", "local_worker"):
        worker = getattr(algorithm, attr, None)
        if worker is not None:
            workers.append(worker)
    for group_name in ("workers", "env_runner_group"):
        group = getattr(algorithm, group_name, None)
        if group is None:
            continue
        local = getattr(group, "local_worker", None)
        if callable(local):
            try:
                workers.append(local())
            except Exception:
                continue
        elif local is not None:
            workers.append(local)
    policies = []
    seen = set()
    for worker in workers:
        policy_map = getattr(worker, "policy_map", None)
        if not isinstance(policy_map, dict):
            continue
        for policy in policy_map.values():
            if id(policy) in seen:
                continue
            seen.add(id(policy))
            policies.append(policy)
    return policies


def reset_bc_kl_publish_state_for_tests() -> None:
    global _last_publish_iteration
    _last_publish_iteration = None


def publish_bc_kl_training_iteration(algorithm: Any) -> int:
    """Stamp the current training iteration onto every learner policy.

    An empty policy list, or a policy that still has no stamp after the
    first training iteration, leaves the coefficient at its maximum. Both
    cases are logged. A missing stamp on iteration 0 is the state before
    the first publish and is not warned about.
    """

    global _last_publish_iteration
    iteration = read_training_iteration(algorithm)
    policies = local_policies(algorithm)
    if not policies:
        logger.warning(
            "bc_kl: local_policies() returned no learner policy at training "
            "iteration %s; the KL coefficient stays at full weight",
            iteration,
        )
    for policy in policies:
        if _as_int(getattr(policy, "bc_kl_training_iteration", None)) is None and iteration >= 1:
            logger.warning(
                "bc_kl: training iteration %s has no KL stamp; the coefficient "
                "stays at full weight",
                iteration,
            )
        policy.bc_kl_training_iteration = iteration
    _last_publish_iteration = iteration
    return iteration


def bc_kl_schedule_index(policy: Any) -> int:
    """Training iteration the KL decay should see.

    A missing stamp stays at 0. Falling back to ``num_grad_updates`` is what
    made ``--bc-kl-iters`` expire after a handful of optimizer steps. After
    the first published iteration, a missing stamp is logged: full weight
    with no log line is how a stuck schedule used to hide.
    """

    stamped = _as_int(getattr(policy, "bc_kl_training_iteration", None))
    if stamped is None:
        if (
            _last_publish_iteration is not None
            and _last_publish_iteration >= 1
            and not getattr(policy, "_bc_kl_missing_stamp_warned", False)
        ):
            logger.warning(
                "bc_kl: KL stamp is None after training iteration %s; the "
                "coefficient stays at full weight",
                _last_publish_iteration,
            )
            try:
                policy._bc_kl_missing_stamp_warned = True
            except Exception:
                pass
        return 0
    return stamped


def bc_kl_schedule_stats(
    policy: Any,
    *,
    bc_kl_coeff: float,
    bc_kl_iters: int,
) -> dict[str, float]:
    """``bc_kl_iter`` and the coefficient ``loss()`` actually applies."""

    iteration = bc_kl_schedule_index(policy)
    return {
        "bc_kl_iter": float(iteration),
        "bc_kl_coeff": float(kl_coeff_for_iter(
            iteration, bc_kl_coeff=bc_kl_coeff, bc_kl_iters=bc_kl_iters,
        )),
    }


def load_bc_anchored_impala():
    """Return an IMPALA subclass whose torch loss includes the BC KL term.

    Raises ImportError when this Ray build no longer ships
    ``ImpalaTorchPolicy``. Callers that passed ``--bc-kl-coeff`` should fail
    instead of training without the regularizer.
    """

    from ray.rllib.algorithms.impala import IMPALA
    from ray.rllib.algorithms.impala.impala_torch_policy import ImpalaTorchPolicy

    class BcAnchoredImpalaTorchPolicy(ImpalaTorchPolicy):
        def loss(self, model, dist_class, train_batch):
            base = super().loss(model, dist_class, train_batch)
            iteration = bc_kl_schedule_index(self)
            penalty, metrics = model.bc_kl_penalty(train_batch, iteration)
            produced = dict(metrics or {})
            schedule = bc_kl_schedule_stats(
                self,
                bc_kl_coeff=float(getattr(model, "_bc_kl_coeff", 0.0) or 0.0),
                bc_kl_iters=int(getattr(model, "_bc_kl_iters", 0) or 0),
            )
            # Keep the penalty's coefficient when the model already computed
            # the term. Always publish the iteration the schedule used.
            produced.setdefault("bc_kl_coeff", schedule["bc_kl_coeff"])
            produced["bc_kl_iter"] = schedule["bc_kl_iter"]
            self._bc_kl_metrics = produced
            return apply_bc_kl_to_loss(base, penalty)

        def stats_fn(self, train_batch):
            stats = {}
            parent = getattr(super(), "stats_fn", None)
            if callable(parent):
                produced = parent(train_batch)
                if isinstance(produced, dict):
                    stats.update(produced)
            metrics = getattr(self, "_bc_kl_metrics", None) or {}
            stats.update(metrics)
            return stats

    class BcAnchoredIMPALA(IMPALA):
        @classmethod
        def get_default_policy_class(cls, config):
            framework = getattr(config, "framework_str", None)
            if framework is None and hasattr(config, "get"):
                framework = config.get("framework")
            if framework == "torch":
                return BcAnchoredImpalaTorchPolicy
            return super().get_default_policy_class(config)

        def training_step(self):
            publish_bc_kl_training_iteration(self)
            return super().training_step()

        def _training_step_old_api_stack(self):
            publish_bc_kl_training_iteration(self)
            return super()._training_step_old_api_stack()

    return BcAnchoredIMPALA
