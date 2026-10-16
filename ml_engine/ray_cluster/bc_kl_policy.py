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
"""

from __future__ import annotations

from typing import Any, Optional


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


def publish_bc_kl_training_iteration(algorithm: Any) -> int:
    """Stamp the current training iteration onto every learner policy."""

    iteration = read_training_iteration(algorithm)
    for policy in local_policies(algorithm):
        policy.bc_kl_training_iteration = iteration
    return iteration


def bc_kl_schedule_index(policy: Any) -> int:
    """Training iteration the KL decay should see.

    A missing stamp stays at 0. Falling back to ``num_grad_updates`` is what
    made ``--bc-kl-iters`` expire after a handful of optimizer steps.
    """

    stamped = _as_int(getattr(policy, "bc_kl_training_iteration", None))
    if stamped is None:
        return 0
    return stamped


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
            self._bc_kl_metrics = metrics
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
