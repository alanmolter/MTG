"""``--bc-kl-iters`` follows Tune training iterations. Ray is not imported."""

from __future__ import annotations

import inspect

import pytest

from ml_engine.bc.regularize import kl_coeff_for_iter
from ml_engine.ray_cluster.bc_kl_policy import (
    bc_kl_schedule_index,
    bc_kl_schedule_stats,
    load_bc_anchored_impala,
    publish_bc_kl_training_iteration,
    read_training_iteration,
    reset_bc_kl_publish_state_for_tests,
)

_LOG = "ml_engine.ray_cluster.bc_kl_policy"


@pytest.fixture(autouse=True)
def _reset_publish_state():
    reset_bc_kl_publish_state_for_tests()
    yield
    reset_bc_kl_publish_state_for_tests()


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
    assert "bc_kl_schedule_stats" in source
    assert "bc_kl_iter" in source
    assert "num_grad_updates" not in source
    assert "publish_bc_kl_training_iteration" in source


def test_fake_algorithm_warns_when_no_policy_or_stamp_is_missing(caplog):
    class _Empty:
        training_iteration = 2

        def __init__(self):
            self.env_runner = type("W", (), {"policy_map": {}})()

    with caplog.at_level("WARNING", logger=_LOG):
        assert publish_bc_kl_training_iteration(_Empty()) == 2
    assert "local_policies()" in caplog.text

    caplog.clear()
    policy = _Policy()

    class _Late:
        training_iteration = 1

        def __init__(self):
            self.env_runner = type("W", (), {"policy_map": {"default_policy": policy}})()

    with caplog.at_level("WARNING", logger=_LOG):
        publish_bc_kl_training_iteration(_Late())
    assert "no KL stamp" in caplog.text
    assert policy.bc_kl_training_iteration == 1

    caplog.clear()
    first = _Policy()

    class _First:
        training_iteration = 0

        def __init__(self):
            self.env_runner = type("W", (), {"policy_map": {"default_policy": first}})()

    with caplog.at_level("WARNING", logger=_LOG):
        publish_bc_kl_training_iteration(_First())
    assert "no KL stamp" not in caplog.text
    assert first.bc_kl_training_iteration == 0


def test_missing_stamp_after_the_first_iteration_keeps_full_weight_and_logs(caplog):
    class _Empty:
        training_iteration = 3

        def __init__(self):
            self.env_runner = type("W", (), {"policy_map": {}})()

    publish_bc_kl_training_iteration(_Empty())
    orphan = _Policy()
    with caplog.at_level("WARNING", logger=_LOG):
        stats = bc_kl_schedule_stats(orphan, bc_kl_coeff=1.0, bc_kl_iters=10)
    assert stats == {"bc_kl_iter": 0.0, "bc_kl_coeff": 1.0}
    assert "stamp is None" in caplog.text
    caplog.clear()
    assert bc_kl_schedule_stats(orphan, bc_kl_coeff=1.0, bc_kl_iters=10)["bc_kl_coeff"] == 1.0
    assert caplog.text == ""


def test_schedule_stats_report_the_effective_coefficient():
    policy = _Policy()
    policy.bc_kl_training_iteration = 2
    assert bc_kl_schedule_stats(policy, bc_kl_coeff=1.0, bc_kl_iters=10) == {
        "bc_kl_iter": 2.0,
        "bc_kl_coeff": 0.8,
    }
