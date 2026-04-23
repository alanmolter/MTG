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


# ── Config constants ────────────────────────────────────────────────────────
#
# These defaults have been validated against the IMPALA V-trace implementation.
# `train_batch_size` MUST be an integer multiple of `rollout_fragment_length`,
# otherwise `_make_time_major` inside ray.rllib.algorithms.impala.impala_torch_policy
# tries to reshape a [train_batch_size, ...] tensor into [B, T, ...] where
# B = train_batch_size // rollout_fragment_length and T = rollout_fragment_length.
# Misalignment raises `ValueError: shape '[B, T]' is invalid for input of size
# train_batch_size`, which kills the learner thread on iteration 1.
#
# See TRAINING_TROUBLESHOOTING.md → "shape '[B,T]' is invalid for input of size N"
# for the full postmortem + user-facing fix.

DEFAULT_ROLLOUT_FRAGMENT_LENGTH = 50

# Memory-budget gate: RLlib pre-allocates a dummy batch of shape
# [min(max(rollout_fragment_length*4, 32), train_batch_size), flat_obs_dim].
# Our flat_obs_dim with max_cards=128 is ~53,406 floats → ~41 MiB per allocation.
# With 4 trials × 4 workers concurrently initializing, this can exhaust RAM on
# laptops. `max_cards=64` halves the dim and avoids the trap.
DEFAULT_MAX_CARDS_FOR_TRAINING = 64


def _validate_batch_alignment(train_batch_size: int, rollout_fragment_length: int) -> None:
    """Raise a clear error if the IMPALA config would deadlock on reshape.

    Must be called *before* we hand the config to Ray/tune.run(); otherwise the
    failure surfaces as an opaque "The learner thread died while training!"
    inside a daemon thread, with the real stack trace buried in trial logs.
    """
    if rollout_fragment_length <= 0:
        raise ValueError(
            f"rollout_fragment_length must be > 0, got {rollout_fragment_length}"
        )
    if train_batch_size % rollout_fragment_length != 0:
        suggested_batch = (train_batch_size // rollout_fragment_length + 1) * rollout_fragment_length
        # Find the largest divisor of train_batch_size that is <= rollout_fragment_length
        # (so we never suggest a value that itself would be misaligned).
        suggested_rfl = next(
            (d for d in range(rollout_fragment_length, 0, -1) if train_batch_size % d == 0),
            1,
        )
        raise ValueError(
            f"IMPALA misconfig: train_batch_size ({train_batch_size}) must be an "
            f"integer multiple of rollout_fragment_length ({rollout_fragment_length}). "
            f"Suggested: train_batch_size={suggested_batch} (next multiple) or "
            f"rollout_fragment_length={suggested_rfl} (largest divisor of {train_batch_size} ≤ {rollout_fragment_length})."
            "\nSee TRAINING_TROUBLESHOOTING.md → 'shape [B,T] invalid for N'."
        )


def build_impala_config(
    num_workers: int,
    train_batch_size: int,
    opponent_pool_path: str,
    rollout_fragment_length: int = DEFAULT_ROLLOUT_FRAGMENT_LENGTH,
    max_cards: int = DEFAULT_MAX_CARDS_FOR_TRAINING,
) -> Dict[str, Any]:
    """Compose an IMPALA config with our custom env + GNN model + PBT-friendly hparams.

    Raises:
        ValueError: when train_batch_size is not a multiple of
            rollout_fragment_length. See `_validate_batch_alignment` for the
            rationale (IMPALA's `_make_time_major` reshape contract).

    Ray 2.x / new API stack note
    ----------------------------
    Ray 2.11+ defaults IMPALA to the new RLModule/Learner API, which is
    incompatible with the legacy `custom_model` knob. Our GNN is registered
    as a ModelV2 via `ModelCatalog.register_custom_model(...)`, so we stay
    on the legacy API by disabling both flags. This is documented in the
    Ray migration guide as the compatible shim.
    """
    _validate_batch_alignment(train_batch_size, rollout_fragment_length)

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
                # Cap obs size to avoid the 40 MiB×N_workers dummy-batch
                # allocation storm on memory-constrained systems. See
                # TRAINING_TROUBLESHOOTING.md → "Unable to allocate 40 MiB".
                "max_cards": max_cards,
            },
            disable_env_checking=True,
        )
        .framework("torch")
        .env_runners(
            num_env_runners=num_workers,
            rollout_fragment_length=rollout_fragment_length,
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


def _align_batch_size(train_batch_size: int, rollout_fragment_length: int) -> int:
    """Bump train_batch_size up to the next multiple of rollout_fragment_length.

    We prefer to bump UP (never down) so the user's intent for at-least-this-many
    samples-per-grad-step is honored. Emits a warning when alignment is needed so
    the user sees what changed.
    """
    if train_batch_size % rollout_fragment_length == 0:
        return train_batch_size
    aligned = ((train_batch_size // rollout_fragment_length) + 1) * rollout_fragment_length
    print(
        f"[orchestrator] train_batch_size={train_batch_size} not divisible by "
        f"rollout_fragment_length={rollout_fragment_length}; bumping to {aligned} "
        f"(see TRAINING_TROUBLESHOOTING.md).",
        file=sys.stderr,
    )
    return aligned


def run(
    num_workers: int = 4,
    num_trials: int = 4,
    budget_hours: float = 24.0,
    train_batch_size: int = 2000,
    checkpoint_freq: int = 10,
    perturbation_interval: int = 20,
    rollout_fragment_length: int = DEFAULT_ROLLOUT_FRAGMENT_LENGTH,
    max_cards: int = DEFAULT_MAX_CARDS_FOR_TRAINING,
):
    """Kick off the PBT + IMPALA job."""
    # Auto-align the batch size BEFORE ray.init so the user sees the warning
    # before any subprocesses spin up.
    train_batch_size = _align_batch_size(train_batch_size, rollout_fragment_length)

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
        rollout_fragment_length=rollout_fragment_length,
        max_cards=max_cards,
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
    p.add_argument(
        "--batch-size",
        type=int,
        default=500,
        help="train batch size (must be multiple of rollout-fragment-length; auto-bumped if not)",
    )
    p.add_argument("--checkpoint-freq", type=int, default=10)
    p.add_argument("--perturbation-interval", type=int, default=20)
    p.add_argument(
        "--rollout-fragment-length",
        type=int,
        default=DEFAULT_ROLLOUT_FRAGMENT_LENGTH,
        help="IMPALA rollout fragment length (T in B×T reshape)",
    )
    p.add_argument(
        "--max-cards",
        type=int,
        default=DEFAULT_MAX_CARDS_FOR_TRAINING,
        help="cap on card nodes in obs; lower = less RAM per worker",
    )
    args = p.parse_args()
    run(
        num_workers=args.num_workers,
        num_trials=args.num_trials,
        budget_hours=args.budget_hours,
        train_batch_size=args.batch_size,
        checkpoint_freq=args.checkpoint_freq,
        perturbation_interval=args.perturbation_interval,
        rollout_fragment_length=args.rollout_fragment_length,
        max_cards=args.max_cards,
    )


if __name__ == "__main__":
    main()
