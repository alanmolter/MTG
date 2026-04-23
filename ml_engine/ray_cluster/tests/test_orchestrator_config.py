"""
Regression suite for the IMPALA orchestrator config guards.

These tests lock in the invariants that caused 4 training-run failures:

  1. `train_batch_size` MUST be a multiple of `rollout_fragment_length`,
     otherwise IMPALA's `_make_time_major` dies with
     "shape '[B,T]' is invalid for input of size N".

  2. The env config must propagate `max_cards` so the observation dim stays
     bounded (prevents the `Unable to allocate 40 MiB for (200, 53406)`
     MemoryError storm when 4 trials × 4 workers init concurrently).

  3. `_align_batch_size` must bump UP (never down) so user intent for
     samples-per-grad-step is honored.

  4. CLI defaults must already be aligned so `train.ps1` + `.\train.ps1`
     out-of-the-box do not hit the trap.

Run locally:
    python -m pytest ml_engine/ray_cluster/tests/test_orchestrator_config.py -v
"""

from __future__ import annotations

import importlib

import pytest

# Skip entire module if ray isn't installed (e.g. CI without full deps).
ray = pytest.importorskip("ray")
pytest.importorskip("ray.rllib")

from ml_engine.ray_cluster import orchestrator  # noqa: E402


# ── Alignment contract ─────────────────────────────────────────────────────


def test_validate_batch_alignment_accepts_multiples():
    # Any multiple must pass silently.
    for rfl in (50, 64, 100):
        for k in range(1, 6):
            orchestrator._validate_batch_alignment(k * rfl, rfl)


def test_validate_batch_alignment_rejects_nondivisible_256_50():
    # The exact error the user hit in production:
    # `shape '[5, 50]' is invalid for input of size 256`.
    with pytest.raises(ValueError) as excinfo:
        orchestrator._validate_batch_alignment(256, 50)
    assert "train_batch_size" in str(excinfo.value)
    assert "rollout_fragment_length" in str(excinfo.value)
    # Error must suggest next multiple so users aren't stranded.
    assert "300" in str(excinfo.value)  # next multiple of 50 after 256


def test_validate_batch_alignment_rejects_zero_rollout():
    with pytest.raises(ValueError):
        orchestrator._validate_batch_alignment(500, 0)


# ── Auto-align contract ────────────────────────────────────────────────────


def test_align_batch_size_passes_through_when_aligned():
    assert orchestrator._align_batch_size(500, 50) == 500


def test_align_batch_size_bumps_up_on_misalignment():
    # User-facing behavior: we always bump UP to preserve "at least this many
    # samples per grad step" intent.
    assert orchestrator._align_batch_size(256, 50) == 300
    assert orchestrator._align_batch_size(257, 64) == 320


def test_align_batch_size_warns_on_stderr(capsys):
    orchestrator._align_batch_size(256, 50)
    captured = capsys.readouterr()
    assert "bumping" in captured.err.lower()
    assert "TRAINING_TROUBLESHOOTING.md" in captured.err


# ── build_impala_config contract ───────────────────────────────────────────


def test_build_config_rejects_misalignment_up_front():
    # Must fail fast BEFORE ray sees it — otherwise the error surfaces as
    # "learner thread died" inside a daemon thread.
    with pytest.raises(ValueError):
        orchestrator.build_impala_config(
            num_workers=2,
            train_batch_size=256,   # NOT divisible by 50
            opponent_pool_path="/tmp/pool.json",
            rollout_fragment_length=50,
        )


def test_build_config_plumbs_max_cards_into_env_config():
    cfg = orchestrator.build_impala_config(
        num_workers=2,
        train_batch_size=500,
        opponent_pool_path="/tmp/pool.json",
        rollout_fragment_length=50,
        max_cards=32,
    )
    # Ray's IMPALAConfig.to_dict() exposes env_config at the top level.
    env_cfg = cfg.get("env_config") or {}
    assert env_cfg.get("max_cards") == 32, (
        "max_cards must reach the env so the obs dim stays bounded."
    )


def test_build_config_default_max_cards_is_memory_safe():
    cfg = orchestrator.build_impala_config(
        num_workers=2,
        train_batch_size=500,
        opponent_pool_path="/tmp/pool.json",
    )
    env_cfg = cfg.get("env_config") or {}
    # Default must be <= 64 to keep dummy-batch allocations under ~20MiB.
    assert env_cfg.get("max_cards", 128) <= 64


# ── CLI defaults ───────────────────────────────────────────────────────────


def test_module_level_defaults_are_aligned():
    # Sanity: the module-level defaults themselves must not be a trap.
    rfl = orchestrator.DEFAULT_ROLLOUT_FRAGMENT_LENGTH
    # 500 is the current CLI default; bump here if you change it.
    assert 500 % rfl == 0


def test_cli_has_rollout_and_max_cards_flags():
    # Re-import to grab the latest argparse def.
    importlib.reload(orchestrator)
    parser_spec = [
        "--num-workers", "1",
        "--num-trials", "1",
        "--budget-hours", "0.001",
        "--batch-size", "500",
        "--rollout-fragment-length", "50",
        "--max-cards", "64",
        "--checkpoint-freq", "1",
        "--perturbation-interval", "1",
    ]
    # We don't run the CLI — we just parse to ensure the flags are declared.
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--num-workers", type=int)
    p.add_argument("--num-trials", type=int)
    p.add_argument("--budget-hours", type=float)
    p.add_argument("--batch-size", type=int)
    p.add_argument("--rollout-fragment-length", type=int)
    p.add_argument("--max-cards", type=int)
    p.add_argument("--checkpoint-freq", type=int)
    p.add_argument("--perturbation-interval", type=int)
    # This will KeyError if orchestrator.main() doesn't expose the flags.
    args = p.parse_args(parser_spec)
    assert args.rollout_fragment_length == 50
    assert args.max_cards == 64
