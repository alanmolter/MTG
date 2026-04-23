"""
check_learning_progress — quick sanity report on Ray training runs.

Scans `ray_results/` for PBT experiments, reads each trial's `progress.csv`
and `error.txt`, and prints:

  • Whether any trials are still alive / how many iterations completed
  • Latest env_runners/episode_reward_mean per trial
  • First line of each error.txt (if the trial died)
  • Config snapshot so the user can verify train_batch_size / rollout_fragment
    alignment at a glance (root cause of the #1 trap documented in
    TRAINING_TROUBLESHOOTING.md)

Usage:
    python -m ml_engine.scripts.check_learning_progress
    python -m ml_engine.scripts.check_learning_progress --results-dir ./ray_results
    python -m ml_engine.scripts.check_learning_progress --experiment pbt_mtg_1776822742
    python -m ml_engine.scripts.check_learning_progress --tail 3   # only 3 newest runs

Outputs plain text so it works from PowerShell / cmd without extra deps.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _read_last_csv_row(path: Path) -> Optional[Dict[str, str]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            last: Optional[Dict[str, str]] = None
            for row in reader:
                last = row
            return last
    except Exception:
        return None


def _read_first_error_line(path: Path) -> Optional[str]:
    """Return the most informative line from a Ray error.txt.

    Ray dumps banners like `Failure # 1 (occurred at ...)` as the first line,
    which hides the actual exception. Prefer a line containing an
    exception-like token; fall back to the first non-blank line.
    """
    if not path.exists():
        return None
    try:
        first_non_blank: Optional[str] = None
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.strip()
                if not line:
                    continue
                if first_non_blank is None:
                    first_non_blank = line
                # Prefer the actual exception type / message.
                low = line.lower()
                if ("error" in low and "failure" not in low) or "exception" in low:
                    return line
        return first_non_blank
    except Exception:
        return None


def _find_trial_dirs(experiment_dir: Path) -> List[Path]:
    return sorted(
        [p for p in experiment_dir.iterdir() if p.is_dir() and p.name.startswith("IMPALA_")]
    )


def _find_experiments(results_dir: Path, tail: Optional[int]) -> List[Path]:
    if not results_dir.exists():
        return []
    exps = sorted(
        [p for p in results_dir.iterdir() if p.is_dir() and p.name.startswith("pbt_mtg_")],
        key=lambda p: p.stat().st_mtime,
    )
    if tail and tail > 0:
        exps = exps[-tail:]
    return exps


def _summarize_config(params_json: Optional[Dict[str, Any]]) -> str:
    if not params_json:
        return "(config unavailable)"
    tbs = params_json.get("train_batch_size", "?")
    rfl = params_json.get("rollout_fragment_length", "?")
    num_workers = params_json.get("num_env_runners") or params_json.get("num_workers", "?")
    aligned = "ok"
    try:
        if isinstance(tbs, int) and isinstance(rfl, int) and rfl > 0 and tbs % rfl != 0:
            aligned = f"MISALIGNED ({tbs}%{rfl}={tbs % rfl})"
    except Exception:
        pass
    return f"tbs={tbs} rfl={rfl} workers={num_workers} {aligned}"


def _summarize_trial(trial_dir: Path) -> Dict[str, Any]:
    progress = _read_last_csv_row(trial_dir / "progress.csv")
    params = _read_json(trial_dir / "params.json")
    err_line = _read_first_error_line(trial_dir / "error.txt")

    iters = None
    reward = None
    if progress:
        try:
            iters = int(progress.get("training_iteration", 0) or 0)
        except Exception:
            iters = None
        # Ray 2.11+ uses nested metric names in the flat CSV (env_runners/...)
        for key in (
            "env_runners/episode_reward_mean",
            "episode_reward_mean",
            "env_runners/episode_return_mean",
        ):
            if key in progress:
                try:
                    reward = float(progress[key])
                    break
                except Exception:
                    reward = None

    status = "ALIVE" if (iters and not err_line) else ("DEAD" if err_line else "IDLE")

    return {
        "trial": trial_dir.name,
        "status": status,
        "iters": iters,
        "reward": reward,
        "config": _summarize_config(params),
        "error": err_line,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1].strip())
    parser.add_argument(
        "--results-dir",
        default=os.getenv("RAY_RESULTS_DIR", "./ray_results"),
        help="where PBT experiments live (default: ./ray_results or $RAY_RESULTS_DIR)",
    )
    parser.add_argument(
        "--experiment",
        default=None,
        help="specific pbt_mtg_<timestamp> dir (default: all)",
    )
    parser.add_argument(
        "--tail",
        type=int,
        default=3,
        help="only inspect the N newest experiments (default: 3)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="machine-readable output for scripts",
    )
    args = parser.parse_args(argv)

    results_dir = Path(args.results_dir).resolve()
    if args.experiment:
        exp_dirs = [results_dir / args.experiment]
        exp_dirs = [d for d in exp_dirs if d.exists()]
    else:
        exp_dirs = _find_experiments(results_dir, args.tail)

    if not exp_dirs:
        print(f"[check_learning_progress] no experiments under {results_dir}")
        return 1

    report: List[Dict[str, Any]] = []
    for exp in exp_dirs:
        trials = _find_trial_dirs(exp)
        trial_reports = [_summarize_trial(t) for t in trials]
        report.append({"experiment": exp.name, "trials": trial_reports})

    if args.json:
        json.dump(report, sys.stdout, indent=2)
        print()
        return 0

    any_alive = False
    any_dead = False
    for exp_block in report:
        print(f"\n=== {exp_block['experiment']} ===")
        if not exp_block["trials"]:
            print("  (no trials)")
            continue
        for t in exp_block["trials"]:
            reward_str = f"{t['reward']:.3f}" if isinstance(t["reward"], float) else "—"
            print(
                f"  [{t['status']:5}] {t['trial'][:60]:<60}  "
                f"iters={t['iters'] or 0:<5} reward={reward_str:<8}  {t['config']}"
            )
            if t["error"]:
                print(f"           error: {t['error']}")
            if t["status"] == "ALIVE":
                any_alive = True
            elif t["status"] == "DEAD":
                any_dead = True

    print()
    if any_alive:
        print("[check_learning_progress] at least one trial is making progress.")
    elif any_dead:
        print(
            "[check_learning_progress] every inspected trial died. "
            "Read `error.txt` and check TRAINING_TROUBLESHOOTING.md."
        )
    else:
        print("[check_learning_progress] no trials with progress.csv yet (just started?).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
