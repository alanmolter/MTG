"""Add the decaying BC KL term to IMPALA's learner loss.

The legacy stack (``enable_rl_module_and_learner=False``) computes that loss
in ``ImpalaTorchPolicy.loss``. ``--bc-kl-coeff`` used to land only in
``custom_model_config`` and was never read again. This module subclasses that
policy so the term is part of the tensor the optimizer steps on.

``bc_kl`` in the policy stats is the weighted term. It follows
``kl_coeff_for_iter`` and is 0 once ``iteration >= bc_kl_iters``.
"""

from __future__ import annotations

from typing import Any


def apply_bc_kl_to_loss(base_loss: Any, penalty: Any) -> Any:
    if isinstance(base_loss, (list, tuple)):
        updated = list(base_loss)
        updated[0] = updated[0] + penalty
        return updated
    return base_loss + penalty


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
            iteration = int(getattr(self, "num_grad_updates", 0) or 0)
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

    return BcAnchoredIMPALA
