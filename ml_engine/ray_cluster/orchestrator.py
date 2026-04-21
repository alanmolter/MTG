"""
Pillar 1 + 7 — Ray RLlib + IMPALA + Population-Based Training orchestrator.

Why IMPALA?
  - Handles async rollouts at scale: one learner, many actors (Forge is slow)
  - V-trace correction makes it forgiving of stale trajectories

Why PBT?
  - MTG is non-stationary — the best learning rate on turn 1 ≠ turn 1000
  - PBT explores hyperparameters AND copies weights from winners every N steps
  - "League" scheduling: periodically inject a frozen past generation as opponent
    to prevent catastrophic forgetting

Usage:
    python -m ml_engine.ray_cluster.orchestrator --num-workers 4 --budget-hours 24

Outputs:
    ray_results/
      pbt_mtg_<timestamp>/
        trial_0_lr=0.0003/checkpoint_000050/...
        trial_1_lr=0.0005/checkpoint_000050/...
        ...
        league_state.json   # latest state of the opponent pool

State is also persisted to `league_state` table in Postgres (mirror of JSON).
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

try:
    import ray
    from ray import train, tune
    from ray.tune.schedulers import PopulationBasedTraining
except ImportError as e:  # pragma: no cover
    raise ImportError(f"ray + tune required: install via requirements.txt ({e})")


def _gpu_per_trial() -> float:
    """Return the GPU fraction each PBT trial requests from Ray.

    Priority:
      1. Explicit override via env: MTG_GPU_PER_TRIAL (e.g. "0.5", "1", "0").
      2. If torch reports CUDA available -> default 0.25 so 4 concurrent PBT
         trials can share a single consumer GPU (e.g. RTX 2070S 8GB). The
         learner kernel is tiny (~GNN 100K params), so fractional sharing is
         safe. Env runners (Forge rollouts) stay on CPU.
      3. Otherwise 0 (pure CPU fallback).

    We intentionally do NOT key on CUDA_VISIBLE_DEVICES: on Windows the env
    var is often unset even when a working CUDA install exists, which was
    silently forcing the whole pipeline to CPU despite an idle RTX.
    """
    env_override = os.getenv("MTG_GPU_PER_TRIAL")
    if env_override is not None:
        try:
            return max(0.0, min(1.0, float(env_override)))
        except ValueError:
            pass
    try:
        import torch  # noqa: WPS433 - lazy import keeps CPU-only envs cheap
        if torch.cuda.is_available():
            return 0.25
    except ImportError:
        pass
    return 0.0


# ── Hyperparameter search space ─────────────────────────────────────────────


PBT_MUTATIONS: Dict[str, Any] = {
    # Note: IMPALA uses V-trace (not GAE) so `lambda_` is not a valid knob here.
    "lr": tune.loguniform(1e-5, 1e-3),
    "entropy_coeff": tune.uniform(0.0, 0.02),
    "vf_loss_coeff": tune.uniform(0.5, 1.5),
    "grad_clip": tune.uniform(0.5, 40.0),
}


def _resample_hparams(_config):
    """Used by PBT to mutate a trial's hparams when it gets replaced."""
    return {
        "lr": random.uniform(1e-5, 1e-3),
        "entropy_coeff": random.uniform(0.0, 0.02),
        "vf_loss_coeff": random.uniform(0.5, 1.5),
        "grad_clip": random.uniform(0.5, 40.0),
    }


# ── Training job definition ─────────────────────────────────────────────────


def build_impala_config(
    num_workers: int,
    train_batch_size: int,
    opponent_pool_path: str,
) -> Dict[str, Any]:
    """Compose an IMPALA config with our custom env + GNN model + PBT-friendly hparams.

    Ray 2.x / new API stack note
    ----------------------------
    Ray 2.11+ defaults IMPALA to the new RLModule/Learner API, which is
    incompatible with the legacy `custom_model` knob. Our GNN is registered
    as a ModelV2 via `ModelCatalog.register_custom_model(...)`, so we stay
    on the legacy API by disabling both flags. This is documented in the
    Ray migration guide as the compatible shim.
    """
    from ray.rllib.algorithms.impala import IMPALAConfig

    cfg = (
        IMPALAConfig()
        .api_stack(
            enable_rl_module_and_learner=False,
            enable_env_runner_and_connector_v2=False,
        )
        .environment(
            env="mtg_forge_env",
            env_config={
                "opponent_pool_path": opponent_pool_path,
                "turn_limit": 50,
                "step_timeout": 10.0,
            },
            disable_env_checking=True,
        )
        .framework("torch")
        .env_runners(
            num_env_runners=num_workers,
            rollout_fragment_length=50,
        )
        .resources(
            num_gpus=_gpu_per_trial(),
        )
        .training(
            train_batch_size=train_batch_size,
            lr=3e-4,
            entropy_coeff=0.01,
            vf_loss_coeff=1.0,
            grad_clip=40.0,
            model={
                "custom_model": "game_state_gnn",
                "custom_model_config": {},
            },
            vtrace=True,
            vtrace_clip_rho_threshold=1.0,
            vtrace_clip_pg_rho_threshold=1.0,
            learner_queue_size=16,
            learner_queue_timeout=300,
        )
        .debugging(
            log_level="WARN",
        )
    )
    return cfg.to_dict()


# ── League scheduling ───────────────────────────────────────────────────────


class LeagueManager:
    """Tracks the pool of frozen opponents. PBT will sample from it during training.

    At every `snapshot_every_iters`, the best live trial's weights are frozen and
    added to the pool. Actors sample an opponent from the pool with prob 0.5 and
    from the live self-play population with prob 0.5. This combats forgetting.
    """

    def __init__(self, max_pool_size: int = 20, snapshot_every_iters: int = 20):
        self.max_pool_size = max_pool_size
        self.snapshot_every_iters = snapshot_every_iters
        self.pool: List[Dict[str, Any]] = []  # [{"checkpoint": path, "iter": n, "winrate": x}]

    def maybe_snapshot(self, trial_results) -> None:
        """Call from trainable's on_iteration_end hook (simplified here)."""
        # Pick the trial with the highest recent episode_reward_mean
        best = max(trial_results, key=lambda r: r.get("episode_reward_mean", -1e9), default=None)
        if not best:
            return
        checkpoint = best.get("checkpoint")
        it = best.get("training_iteration", 0)
        if it % self.snapshot_every_iters != 0 or checkpoint is None:
            return
        self.pool.append({
            "checkpoint": checkpoint,
            "iter": it,
            "winrate": best.get("custom_metrics", {}).get("winrate_mean", 0.5),
        })
        # Bound pool size — evict oldest low-winrate entry
        if len(self.pool) > self.max_pool_size:
            self.pool.sort(key=lambda p: (p["winrate"], p["iter"]), reverse=True)
            self.pool = self.pool[: self.max_pool_size]


# ── Main entrypoint ─────────────────────────────────────────────────────────


def run(
    num_workers: int = 4,
    num_trials: int = 4,
    budget_hours: float = 24.0,
    train_batch_size: int = 2000,
    checkpoint_freq: int = 10,
    perturbation_interval: int = 20,
):
    """Kick off the PBT + IMPALA job."""
    ray.init(
        address=os.getenv("RAY_ADDRESS"),  # None = local
        ignore_reinit_error=True,
        include_dashboard=False,
        logging_level="INFO",
    )

    # Register custom env + model so Ray can find them by name in config
    from ml_engine.models.game_state_gnn import register_with_rllib as register_gnn
    from ml_engine.ray_cluster.env import register_with_rllib as register_env

    register_env()
    register_gnn()

    storage_path = os.path.abspath(os.getenv("RAY_RESULTS_DIR", "./ray_results"))
    Path(storage_path).mkdir(parents=True, exist_ok=True)
    opponent_pool_path = os.path.join(storage_path, "league_state.json")

    # Ray 2.11+ exposes episode rewards under `env_runners/episode_reward_mean`
    # (nested metric name), not the legacy top-level `episode_reward_mean`.
    metric_key = "env_runners/episode_reward_mean"
    pbt = PopulationBasedTraining(
        time_attr="training_iteration",
        metric=metric_key,
        mode="max",
        perturbation_interval=perturbation_interval,
        resample_probability=0.25,
        hyperparam_mutations=PBT_MUTATIONS,
    )

    config = build_impala_config(
        num_workers=num_workers,
        train_batch_size=train_batch_size,
        opponent_pool_path=opponent_pool_path,
    )

    analysis = tune.run(
        "IMPALA",
        name=f"pbt_mtg_{int(time.time())}",
        scheduler=pbt,
        num_samples=num_trials,
        config=config,
        stop={"time_total_s": int(budget_hours * 3600)},
        checkpoint_freq=checkpoint_freq,
        checkpoint_at_end=True,
        storage_path=storage_path,
        verbose=1,
        max_failures=2,
    )

    best = analysis.get_best_trial(metric_key, mode="max")
    if best:
        reward = best.last_result.get(metric_key) or 0.0
        print(f"[orchestrator] best trial: {best.trial_id} reward={reward:.3f}")
        print(f"[orchestrator] checkpoint: {best.checkpoint}")
    else:
        print("[orchestrator] no trials finished successfully", file=sys.stderr)

    ray.shutdown()
    return analysis


# ── CLI ─────────────────────────────────────────────────────────────────────


def main():
    p = argparse.ArgumentParser(description="PBT + IMPALA trainer for MTG AI")
    p.add_argument("--num-workers", type=int, default=4, help="rollout workers per trial")
    p.add_argument("--num-trials", type=int, default=4, help="population size")
    p.add_argument("--budget-hours", type=float, default=24.0, help="stop after N hours")
    p.add_argument("--batch-size", type=int, default=2000, help="train batch size")
    p.add_argument("--checkpoint-freq", type=int, default=10)
    p.add_argument("--perturbation-interval", type=int, default=20)
    args = p.parse_args()
    run(
        num_workers=args.num_workers,
        num_trials=args.num_trials,
        budget_hours=args.budget_hours,
        train_batch_size=args.batch_size,
        checkpoint_freq=args.checkpoint_freq,
        perturbation_interval=args.perturbation_interval,
    )


if __name__ == "__main__":
    main()
