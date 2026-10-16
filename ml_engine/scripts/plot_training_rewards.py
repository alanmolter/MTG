"""Export an honest reward-vs-time chart from one Ray Tune experiment.

The chart plots every recorded Ray episode return mean; it never interpolates
or smooths values.  The accompanying CSV and JSON manifest make the rendered
figure auditable and easy to reuse outside the terminal.

Usage:
    python -m ml_engine.scripts.plot_training_rewards
    python -m ml_engine.scripts.plot_training_rewards --experiment pbt_mtg_123
    python -m ml_engine.scripts.plot_training_rewards --output-dir C:/reports
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional


REWARD_COLUMNS = (
    "env_runners/episode_return_mean",
    "env_runners/episode_reward_mean",
    "episode_return_mean",
    "episode_reward_mean",
)
TIME_COLUMN = "time_total_s"


def default_results_dir() -> Path:
    """Match the orchestrator's OneDrive-safe Ray results location."""
    configured = os.getenv("RAY_RESULTS_DIR")
    if configured:
        return Path(configured).expanduser()

    local_app_data = os.getenv("LOCALAPPDATA")
    safe_dir = (
        Path(local_app_data) / "mtg-deck-mvp" / "ray_results"
        if local_app_data
        else None
    )
    if safe_dir and safe_dir.exists():
        return safe_dir
    return Path("ray_results")


def find_experiment(results_dir: Path, experiment: Optional[str]) -> Path:
    if experiment:
        selected = results_dir / experiment
        if not selected.is_dir():
            raise FileNotFoundError(f"experimento não encontrado: {selected}")
        return selected

    candidates = [p for p in results_dir.glob("pbt_mtg_*") if p.is_dir()]
    if not candidates:
        raise FileNotFoundError(f"nenhum experimento pbt_mtg_* em {results_dir}")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def _number(row: dict[str, str], keys: Iterable[str]) -> Optional[float]:
    for key in keys:
        raw = row.get(key)
        if raw in (None, "", "nan", "NaN"):
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
        if value == value:  # reject NaN while retaining valid negative rewards
            return value
    return None


def read_trial_rows(trial_dir: Path) -> list[dict[str, Any]]:
    """Read usable observations while preserving gaps as omitted observations."""
    progress_path = trial_dir / "progress.csv"
    if not progress_path.exists():
        return []

    rows: list[dict[str, Any]] = []
    with progress_path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            reward = _number(row, REWARD_COLUMNS)
            seconds = _number(row, (TIME_COLUMN,))
            iteration = _number(row, ("training_iteration",))
            if reward is None or seconds is None or iteration is None:
                continue
            rows.append(
                {
                    "trial": trial_dir.name,
                    "training_iteration": int(iteration),
                    "elapsed_hours": seconds / 3600.0,
                    "reward": reward,
                    "source": str(progress_path),
                }
            )
    return rows


def collect_rows(experiment_dir: Path) -> list[dict[str, Any]]:
    observations: list[dict[str, Any]] = []
    for trial_dir in sorted(experiment_dir.glob("IMPALA_*")):
        if trial_dir.is_dir():
            observations.extend(read_trial_rows(trial_dir))
    return observations


def _atomic_text(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="", dir=path.parent, delete=False
    ) as handle:
        handle.write(content)
        temporary_path = Path(handle.name)
    temporary_path.replace(path)


def write_data_exports(output_dir: Path, rows: list[dict[str, Any]], experiment: Path) -> None:
    csv_path = output_dir / "training_rewards.csv"
    lines = ["trial,training_iteration,elapsed_hours,reward,source\n"]
    for row in rows:
        lines.append(
            f'"{row["trial"]}",{row["training_iteration"]},{row["elapsed_hours"]:.9f},'
            f'{row["reward"]:.9f},"{row["source"]}"\n'
        )
    _atomic_text(csv_path, "".join(lines))

    manifest = {
        "experiment": str(experiment),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "metric_precedence": list(REWARD_COLUMNS),
        "x_axis": "time_total_s / 3600 (hours)",
        "transformations": "none; rows missing time, reward, or iteration are omitted",
        "observations": len(rows),
        "trials": sorted({row["trial"] for row in rows}),
        "data_csv": str(csv_path),
    }
    _atomic_text(
        output_dir / "training_rewards.manifest.json",
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
    )


def render_chart(output_dir: Path, rows: list[dict[str, Any]], experiment: Path) -> list[Path]:
    # Import lazily so `--help` and the parser stay usable without Matplotlib.
    import matplotlib.pyplot as plt

    by_trial: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_trial.setdefault(row["trial"], []).append(row)

    with plt.style.context("default"):
        figure, axis = plt.subplots(figsize=(11, 6.5), layout="constrained")
        palette = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9"]
        markers = ["o", "s", "^", "D", "v", "P"]
        for index, (trial, points) in enumerate(sorted(by_trial.items())):
            points.sort(key=lambda point: (point["elapsed_hours"], point["training_iteration"]))
            every = max(1, len(points) // 18)
            label = trial.replace("IMPALA_mtg_forge_env_", "trial ")
            axis.plot(
                [point["elapsed_hours"] for point in points],
                [point["reward"] for point in points],
                label=label,
                color=palette[index % len(palette)],
                marker=markers[index % len(markers)],
                markevery=every,
                linewidth=1.8,
                markersize=4,
            )

        axis.axhline(0, color="#4D4D4D", linewidth=1, linestyle="--", label="baseline (0)")
        axis.set(
            title=f"Ray training reward over time\n{experiment.name}",
            xlabel="Training time (hours)",
            ylabel="Episode return mean (raw Ray metric)",
        )
        axis.grid(True, color="#D9D9D9", linewidth=0.8)
        axis.legend(loc="best", fontsize=8)
        axis.text(
            0.01,
            0.01,
            "Each point is a recorded Ray result. No smoothing or interpolation.",
            transform=axis.transAxes,
            fontsize=8,
            color="#444444",
            va="bottom",
        )

        outputs = [output_dir / "training_rewards.png", output_dir / "training_rewards.svg"]
        for target in outputs:
            temporary = target.with_suffix(f".tmp{target.suffix}")
            figure.savefig(temporary, dpi=160, facecolor="white")
            temporary.replace(target)
        plt.close(figure)
    return outputs


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results-dir", type=Path, default=default_results_dir())
    parser.add_argument("--experiment", help="pbt_mtg_* name; newest experiment is the default")
    parser.add_argument("--output-dir", type=Path, help="destination; defaults to <experiment>/training_report")
    args = parser.parse_args(argv)

    try:
        experiment = find_experiment(args.results_dir.expanduser(), args.experiment)
        rows = collect_rows(experiment)
        if not rows:
            raise RuntimeError("nenhuma métrica de reward disponível ainda; aguarde a primeira iteração")

        output_dir = args.output_dir.expanduser() if args.output_dir else experiment / "training_report"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_data_exports(output_dir, rows, experiment)
        images = render_chart(output_dir, rows, experiment)
    except (FileNotFoundError, RuntimeError) as exc:
        print(f"[plot_training_rewards] {exc}", file=sys.stderr)
        return 1

    print(f"[plot_training_rewards] experiment: {experiment.name}")
    print(f"[plot_training_rewards] observations: {len(rows)}")
    for image in images:
        print(f"[plot_training_rewards] written: {image}")
    print(f"[plot_training_rewards] data: {output_dir / 'training_rewards.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
