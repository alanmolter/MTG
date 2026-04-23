"""
Smoke test for ml_engine.scripts.check_learning_progress.

Verifies:
  - Importable and runnable via `python -m`.
  - Produces sane output against a synthetic ray_results/ tree (dead + alive
    trial dirs with progress.csv / error.txt / params.json).
  - Detects misaligned train_batch_size / rollout_fragment_length in the
    config snapshot so the user sees the root cause at a glance.
"""

from __future__ import annotations

import io
import json
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from ml_engine.scripts import check_learning_progress as clp


def _write_trial(
    dirpath: Path,
    *,
    iters: int = 0,
    reward: float = 0.0,
    params: dict | None = None,
    error: str | None = None,
):
    dirpath.mkdir(parents=True, exist_ok=True)
    # progress.csv (at least one row)
    if iters > 0:
        (dirpath / "progress.csv").write_text(
            "training_iteration,env_runners/episode_reward_mean\n"
            f"{iters},{reward}\n",
            encoding="utf-8",
        )
    # params.json
    if params is not None:
        (dirpath / "params.json").write_text(json.dumps(params), encoding="utf-8")
    # error.txt
    if error is not None:
        (dirpath / "error.txt").write_text(error, encoding="utf-8")


def test_clp_reports_alive_and_dead_trials(tmp_path: Path, capsys):
    exp = tmp_path / "pbt_mtg_12345"
    # Trial 0 — alive, 10 iters, reward 1.5, aligned config
    _write_trial(
        exp / "IMPALA_env_abc_00000_0",
        iters=10,
        reward=1.5,
        params={"train_batch_size": 500, "rollout_fragment_length": 50, "num_env_runners": 4},
    )
    # Trial 1 — dead (error.txt present), misaligned config (the classic trap)
    _write_trial(
        exp / "IMPALA_env_abc_00001_1",
        iters=1,
        reward=0.0,
        params={"train_batch_size": 256, "rollout_fragment_length": 50, "num_env_runners": 4},
        error="Failure #1\nRuntimeError: The learner thread died while training!",
    )

    rc = clp.main(["--results-dir", str(tmp_path), "--tail", "5"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "pbt_mtg_12345" in out
    assert "ALIVE" in out
    assert "DEAD" in out
    # Config snapshot must flag the misalignment loudly
    assert "MISALIGNED" in out
    # First line of the error.txt must be surfaced
    assert "learner thread died" in out


def test_clp_json_output(tmp_path: Path, capsys):
    exp = tmp_path / "pbt_mtg_99999"
    _write_trial(
        exp / "IMPALA_env_xyz_00000_0",
        iters=5,
        reward=0.25,
        params={"train_batch_size": 500, "rollout_fragment_length": 50},
    )
    rc = clp.main(["--results-dir", str(tmp_path), "--json"])
    assert rc == 0
    out = capsys.readouterr().out
    data = json.loads(out)
    assert isinstance(data, list)
    assert data[0]["experiment"] == "pbt_mtg_99999"
    assert data[0]["trials"][0]["iters"] == 5
    assert data[0]["trials"][0]["reward"] == pytest.approx(0.25)


def test_clp_handles_empty_results_dir(tmp_path: Path, capsys):
    rc = clp.main(["--results-dir", str(tmp_path)])
    assert rc == 1
    out = capsys.readouterr().out
    assert "no experiments" in out


def test_clp_entrypoint_is_discoverable():
    # Must be runnable as `python -m ml_engine.scripts.check_learning_progress`
    # — this is what the user-facing weekly runbook promises.
    import importlib.util
    spec = importlib.util.find_spec("ml_engine.scripts.check_learning_progress")
    assert spec is not None
    # And `main` callable exists
    assert callable(getattr(clp, "main"))
