"""``--bc-kl-iters`` follows Tune training iterations. Ray is not imported."""

from __future__ import annotations

import inspect

from ml_engine.bc.regularize import kl_coeff_for_iter
from ml_engine.ray_cluster.bc_kl_policy import (
    bc_kl_schedule_index,
    load_bc_anchored_impala,
    publish_bc_kl_training_iteration,
    read_training_iteration,
)


class _Policy:
    def __init__(self) -> None:
        self.num_grad_updates = 0
        self.bc_kl_training_iteration = None


def test_schedule_ignores_gradient_updates_inside_one_training_iteration():
    policy = _Policy()
    policy.bc_kl_training_iteration = 0
    policy.num_grad_updates = 0
    coeffs = []
    for _ in range(8):
        coeffs.append(
            kl_coeff_for_iter(
                bc_kl_schedule_index(policy),
                bc_kl_coeff=1.0,
                bc_kl_iters=5,
            )
        )
        policy.num_grad_updates += 1
    assert coeffs == [1.0] * 8
    # The old counter would already have expired this schedule.
    assert kl_coeff_for_iter(policy.num_grad_updates, bc_kl_coeff=1.0, bc_kl_iters=5) == 0.0
    policy.bc_kl_training_iteration = 5
    assert kl_coeff_for_iter(
        bc_kl_schedule_index(policy), bc_kl_coeff=1.0, bc_kl_iters=5,
    ) == 0.0


def test_publish_stamps_learner_policies_from_the_training_iteration():
    first = _Policy()
    first.num_grad_updates = 40
    second = _Policy()
    second.num_grad_updates = 40

    class _Worker:
        def __init__(self, policies):
            self.policy_map = policies

    class _Workers:
        def local_worker(self):
            return _Worker({"default_policy": first})

    class _Algo:
        training_iteration = 0
        iteration = 99

        def __init__(self):
            self.env_runner = _Worker({"default_policy": first, "other": second})
            self.workers = _Workers()

    algo = _Algo()
    assert read_training_iteration(algo) == 0
    assert publish_bc_kl_training_iteration(algo) == 0
    assert bc_kl_schedule_index(first) == 0
    assert bc_kl_schedule_index(second) == 0
    assert kl_coeff_for_iter(bc_kl_schedule_index(first), bc_kl_coeff=1.0, bc_kl_iters=10) == 1.0
    assert kl_coeff_for_iter(40, bc_kl_coeff=1.0, bc_kl_iters=10) == 0.0

    algo.training_iteration = 2
    assert publish_bc_kl_training_iteration(algo) == 2
    assert first.bc_kl_training_iteration == 2
    assert second.bc_kl_training_iteration == 2
    assert kl_coeff_for_iter(
        bc_kl_schedule_index(first), bc_kl_coeff=1.0, bc_kl_iters=10,
    ) == 0.8


def test_missing_stamp_does_not_read_num_grad_updates():
    policy = _Policy()
    policy.num_grad_updates = 100
    assert bc_kl_schedule_index(policy) == 0


def test_loss_hook_uses_the_training_iteration_schedule():
    source = inspect.getsource(load_bc_anchored_impala)
    assert "bc_kl_schedule_index" in source
    assert "num_grad_updates" not in source
    assert "publish_bc_kl_training_iteration" in source
