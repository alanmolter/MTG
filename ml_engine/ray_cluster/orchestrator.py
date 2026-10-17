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
import csv
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import ray
    from ray import train, tune
    from ray.tune.schedulers import PopulationBasedTraining
except ImportError as e:  # pragma: no cover
    raise ImportError(f"ray + tune required: install via requirements.txt ({e})")


def _available_gpu_count() -> int:
    """Return CUDA devices visible to this Python process, never raising."""
    try:
        import torch  # noqa: WPS433 - lazy import keeps CPU-only envs cheap
        return torch.cuda.device_count() if torch.cuda.is_available() else 0
    except ImportError:
        return 0


def _unsupported_cuda_devices() -> List[str]:
    """Describe visible GPUs whose compute capability has no PyTorch kernel.

    Allocating such a device to Ray makes the learner die much later with the
    opaque `cudaErrorNoKernelImageForDevice`.  Detect it before Ray starts so
    the terminal tells the operator exactly which CUDA_VISIBLE_DEVICES value to
    use while upgrading PyTorch.
    """
    try:
        import torch  # noqa: WPS433
        if not torch.cuda.is_available():
            return []
        supported = set(torch.cuda.get_arch_list())
        bad: List[str] = []
        for idx in range(torch.cuda.device_count()):
            major, minor = torch.cuda.get_device_capability(idx)
            arch = f"sm_{major}{minor}"
            if arch not in supported:
                bad.append(f"cuda:{idx} {torch.cuda.get_device_name(idx)} ({arch}; torch supports {sorted(supported)})")
        return bad
    except (ImportError, RuntimeError):
        return []


def _gpu_per_trial(num_trials: Optional[int] = None) -> float:
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
    gpu_count = _available_gpu_count()
    if gpu_count:
        # One complete GPU per trial is the safest default when the population
        # fits the available devices. For a larger PBT population Ray receives
        # an honest fractional request and schedules it across all devices.
        if num_trials and num_trials > gpu_count:
            return max(0.25, min(1.0, gpu_count / num_trials))
        return 1.0
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


DEFAULT_TURN_LIMIT_FOR_TRAINING = 50


def build_impala_config(
    num_workers: int,
    train_batch_size: int,
    opponent_pool_path: str,
    rollout_fragment_length: int = DEFAULT_ROLLOUT_FRAGMENT_LENGTH,
    max_cards: int = DEFAULT_MAX_CARDS_FOR_TRAINING,
    arena_only: Optional[bool] = None,
    deck_seed: Optional[int] = None,
    turn_limit: int = DEFAULT_TURN_LIMIT_FOR_TRAINING,
    gpu_per_trial: Optional[float] = None,
    shaping_weight: float = 1.0,
    shaping_weight_final: float = 0.0,
    shaping_anneal_episodes: int = 0,
    bc_checkpoint: Optional[str] = None,
    bc_kl_coeff: float = 0.0,
    bc_kl_iters: int = 0,
    deck_pool_version: Optional[str] = None,
) -> Dict[str, Any]:
    """Compose an IMPALA config with our custom env + GNN model + PBT-friendly hparams.

    Raises:
        ValueError: when train_batch_size is not a multiple of
            rollout_fragment_length. See `_validate_batch_alignment` for the
            rationale (IMPALA's `_make_time_major` reshape contract).

    Arena pool plumbing
    -------------------
    When `arena_only` is True (or `TRAINING_POOL_ARENA_ONLY=1` is set in the
    environment if the arg is left at None), we resolve a pair of decks from
    the train split via `arena_pool.resolve_decks_for_training()` and stuff
    them into `env_config["agent_deck"]` / `["opponent_deck"]`. Each episode
    then resamples that split. Holdout lists are not used here.

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
    from ml_engine.ray_cluster.arena_pool import (
        is_arena_only_training,
        resolve_decks_for_training,
    )

    if arena_only is None:
        arena_only = is_arena_only_training()
    if deck_pool_version:
        os.environ["DECK_POOL_VERSION"] = str(deck_pool_version)

    env_config: Dict[str, Any] = {
        "opponent_pool_path": opponent_pool_path,
        "turn_limit": turn_limit,
        "step_timeout": 12.0,
        # Java must emit truncated before Python kills the JVM. See
        # env.java_step_timeout_seconds.
        "java_step_timeout_seconds": 8,
        # Cap obs size to avoid the 40 MiB×N_workers dummy-batch
        # allocation storm on memory-constrained systems. See
        # TRAINING_TROUBLESHOOTING.md → "Unable to allocate 40 MiB".
        "max_cards": max_cards,
        # A reward is meaningful only when the Ray policy controls Forge.
        # Train on the dynamically masked discrete action set for now: pass
        # plus the spell abilities Forge exposes as legal at this decision.
        # It is dramatically more sample-efficient than an unmasked 65k
        # autoregressive Cartesian product. The native triple remains
        # available for the future combat/target-aware policy.
        "use_autoregressive_actions": False,
        "require_policy_control": True,
        # Potential-based shaping weight. 0 anneal episodes keeps it constant.
        "shaping_weight": shaping_weight,
        "shaping_weight_final": shaping_weight_final,
        "shaping_anneal_episodes": shaping_anneal_episodes,
    }

    if arena_only:
        agent_deck, opponent_deck = resolve_decks_for_training(
            arena_only=True, seed=deck_seed
        )
        # Only set keys when we got real decklists — leaving them at None
        # makes the bridge fall back to its hardcoded decks, defeating the
        # whole purpose of arena_only=True.
        if agent_deck:
            env_config["agent_deck"] = agent_deck
        if opponent_deck:
            env_config["opponent_deck"] = opponent_deck
        env_config["arena_only"] = True

    cfg = (
        IMPALAConfig()
        .api_stack(
            enable_rl_module_and_learner=False,
            enable_env_runner_and_connector_v2=False,
        )
        .environment(
            env="mtg_forge_env",
            env_config=env_config,
            disable_env_checking=True,
        )
        .framework("torch")
        .env_runners(
            num_env_runners=num_workers,
            rollout_fragment_length=rollout_fragment_length,
        )
        .resources(num_gpus=_gpu_per_trial() if gpu_per_trial is None else gpu_per_trial)
        .training(
            train_batch_size=train_batch_size,
            lr=3e-4,
            entropy_coeff=0.01,
            vf_loss_coeff=1.0,
            grad_clip=40.0,
            model={
                "custom_model": "game_state_gnn",
                "custom_model_config": {
                    "bc_checkpoint": bc_checkpoint,
                    "bc_kl_coeff": bc_kl_coeff,
                    "bc_kl_iters": bc_kl_iters,
                },
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
        .callbacks(_episode_metrics_callback())
    )
    return cfg.to_dict()


def _episode_metrics_callback():
    """Import the callback lazily so config helpers stay importable with Ray."""
    from ml_engine.ray_cluster.episode_metrics import MtgEpisodeMetrics
    return MtgEpisodeMetrics


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


def _is_under_onedrive(path: str) -> bool:
    """Return True if `path` resolves into a OneDrive-synced directory.

    OneDrive holds files open during sync, which races Ray Tune's PBT exploit
    step (copy + reopen of result.json) and crashes the orchestrator with
    WinError 32 / Errno 13. We detect by looking for "OneDrive" anywhere in
    the path components and by checking the documented OneDrive env vars.
    """
    try:
        norm = os.path.normcase(os.path.abspath(path))
    except Exception:
        return False
    parts = norm.replace("\\", "/").split("/")
    if any("onedrive" in p for p in parts):
        return True
    for var in ("OneDrive", "OneDriveCommercial", "OneDriveConsumer"):
        root = os.environ.get(var)
        if not root:
            continue
        try:
            root_norm = os.path.normcase(os.path.abspath(root))
        except Exception:
            continue
        if norm == root_norm or norm.startswith(root_norm + os.sep):
            return True
    return False


def _resolve_storage_path() -> str:
    """Pick a Ray Tune storage_path that is safe from OneDrive file locks.

    Priority:
      1. RAY_RESULTS_DIR env var (explicit override always wins, but we warn
         loudly if the user pointed it back into OneDrive).
      2. If cwd is under OneDrive on Windows, default to
         %LOCALAPPDATA%\\mtg-deck-mvp\\ray_results (outside any sync root).
      3. Otherwise ./ray_results next to the project.
    """
    override = os.getenv("RAY_RESULTS_DIR")
    if override:
        resolved = os.path.abspath(override)
        if _is_under_onedrive(resolved):
            print(
                f"[orchestrator] WARNING: RAY_RESULTS_DIR={resolved!r} is under "
                "OneDrive. PBT runs WILL crash mid-training when OneDrive locks "
                "result.json (WinError 32). Move it outside any synced folder.",
                file=sys.stderr,
            )
        return resolved

    default = os.path.abspath("./ray_results")
    if sys.platform == "win32" and _is_under_onedrive(default):
        local_app = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local")
        safe = os.path.join(local_app, "mtg-deck-mvp", "ray_results")
        print(
            f"[orchestrator] cwd is under OneDrive; redirecting ray_results to "
            f"{safe} to avoid sync-induced file locks. Override with RAY_RESULTS_DIR.",
            file=sys.stderr,
        )
        return safe
    return default


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


def _find_latest_experiment(storage_path: str) -> Optional[str]:
    """Return the newest `pbt_mtg_*` experiment dir name under storage_path.

    Used by `--resume latest` so the user doesn't have to copy-paste a
    timestamp. Returns None if storage_path doesn't exist or has no matches.
    """
    root = Path(storage_path)
    if not root.is_dir():
        return None
    candidates = [p for p in root.iterdir() if p.is_dir() and p.name.startswith("pbt_mtg_")]
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0].name


def _read_metric(result: Dict[str, Any], key: str) -> Optional[float]:
    """Read a Ray metric stored either as a flattened slash-key or nested dict."""
    value: Any = result.get(key)
    if value is None:
        value = result
        for part in key.split("/"):
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(part)
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _trial_metric_history(trial: Any, metric_keys: List[str]) -> List[float]:
    """Read a trial's recorded reward history, independent of Ray version."""
    local_path = getattr(trial, "local_path", None) or getattr(trial, "logdir", None)
    if not local_path:
        return []
    progress = Path(str(local_path)) / "progress.csv"
    if not progress.is_file():
        return []
    values: List[float] = []
    try:
        with progress.open("r", encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                for key in metric_keys:
                    raw = row.get(key)
                    try:
                        if raw not in (None, ""):
                            values.append(float(raw))
                            break
                    except (TypeError, ValueError):
                        continue
    except OSError:
        return []
    return values


def _stable_tail_score(history: List[float], window: int = 20) -> Optional[float]:
    """Conservative score: mean of the latest completed reward windows."""
    if not history:
        return None
    tail = history[-max(1, window):]
    return sum(tail) / len(tail)


def _select_stable_trial(trials: List[Any], metric_keys: List[str]) -> tuple[Any, Optional[float], List[Dict[str, Any]]]:
    """Return the trial with the best sustained tail, plus audit summaries."""
    best_trial: Any = None
    best_score: Optional[float] = None
    summaries: List[Dict[str, Any]] = []
    for trial in trials:
        history = _trial_metric_history(trial, metric_keys)
        score = _stable_tail_score(history)
        summaries.append({
            "trial_id": getattr(trial, "trial_id", "unknown"),
            "observations": len(history),
            "tail_score": score,
            "last_reward": history[-1] if history else None,
        })
        if score is not None and (best_score is None or score > best_score):
            best_trial, best_score = trial, score
    return best_trial, best_score, summaries


def run(
    num_workers: int = 4,
    num_trials: int = 4,
    budget_hours: float = 24.0,
    train_batch_size: int = 2000,
    checkpoint_freq: int = 10,
    perturbation_interval: int = 20,
    rollout_fragment_length: int = DEFAULT_ROLLOUT_FRAGMENT_LENGTH,
    max_cards: int = DEFAULT_MAX_CARDS_FOR_TRAINING,
    arena_only: Optional[bool] = None,
    deck_seed: Optional[int] = None,
    resume: Optional[str] = None,
    turn_limit: int = DEFAULT_TURN_LIMIT_FOR_TRAINING,
    archetypes: Optional[str] = None,
    gpu_per_trial: Optional[float] = None,
    pbt_metric: str = "win_rate",
    shaping_weight: float = 1.0,
    shaping_weight_final: float = 0.0,
    shaping_anneal_episodes: int = 0,
    bc_checkpoint: Optional[str] = None,
    bc_kl_coeff: float = 0.0,
    bc_kl_iters: int = 0,
    deck_pool_version: Optional[str] = None,
):
    """Kick off the PBT + IMPALA job."""
    unsupported = _unsupported_cuda_devices()
    if unsupported:
        raise SystemExit(
            "[orchestrator] refusing unsafe GPU allocation:\n  - "
            + "\n  - ".join(unsupported)
            + "\nSet CUDA_VISIBLE_DEVICES to a compatible GPU or install a PyTorch build "
              "that supports this compute capability before training."
        )
    # Auto-align the batch size BEFORE ray.init so the user sees the warning
    # before any subprocesses spin up.
    train_batch_size = _align_batch_size(train_batch_size, rollout_fragment_length)
    available_gpus = _available_gpu_count()
    allocated_gpu = _gpu_per_trial(num_trials) if gpu_per_trial is None else gpu_per_trial
    print(
        f"[orchestrator] GPU plan: visible={available_gpus}, trials={num_trials}, "
        f"gpu_per_trial={allocated_gpu}. "
        + ("Ray will schedule across the visible CUDA devices." if allocated_gpu > 0 else
           "CPU fallback; install a CUDA-enabled PyTorch build to enable GPUs."),
        file=sys.stderr,
    )

    # Curriculum: --archetypes feeds the env var that arena_pool reads.
    # Done here (not in main()) so programmatic callers benefit too.
    if deck_pool_version:
        os.environ["DECK_POOL_VERSION"] = str(deck_pool_version)
        print(
            f"[orchestrator] deck pool version: {deck_pool_version}",
            file=sys.stderr,
        )
    if archetypes:
        os.environ["TRAINING_ARCHETYPES"] = archetypes
        print(
            f"[orchestrator] curriculum mode: restricting archetypes to {archetypes}",
            file=sys.stderr,
        )

    # Surface the active pool BEFORE ray spins up so a misconfigured run is
    # obvious in the first 10 lines of stdout. We import here (not at module
    # top) to keep `import ml_engine.ray_cluster.orchestrator` fast in tests
    # that only need the config helpers.
    from ml_engine.ray_cluster.arena_pool import (
        is_arena_only_training,
        describe_training_pool,
    )
    if arena_only is None:
        arena_only = is_arena_only_training()
    print(
        f"[orchestrator] training pool: {describe_training_pool()} "
        f"(TRAINING_POOL_ARENA_ONLY={'1' if arena_only else '0'})",
        file=sys.stderr,
    )

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

    storage_path = _resolve_storage_path()
    Path(storage_path).mkdir(parents=True, exist_ok=True)
    opponent_pool_path = os.path.join(storage_path, "league_state.json")

    # Default objective is decisive-game win rate. Shaped return remains
    # available with pbt_metric="reward" for a comparison run. Ray 2.40 renamed
    # reward_mean to return_mean; the reward mode still reads both.
    from ml_engine.ray_cluster.training_metrics import promotion_decision, resolve_pbt_metric
    selected_metric = resolve_pbt_metric(pbt_metric)
    metric_key = selected_metric.primary_key
    metric_key_alt = selected_metric.history_keys[-1]
    # A two-member population should immediately replace a persistently losing
    # member with a mutated copy of the leader. Larger populations retain more
    # exploration rather than collapsing into the first apparent winner.
    pbt_resample_probability = 1.0 if num_trials <= 2 else 0.25
    pbt = PopulationBasedTraining(
        time_attr="training_iteration",
        metric=metric_key,
        mode="max",
        perturbation_interval=perturbation_interval,
        resample_probability=pbt_resample_probability,
        hyperparam_mutations=PBT_MUTATIONS,
    )

    config = build_impala_config(
        num_workers=num_workers,
        train_batch_size=train_batch_size,
        opponent_pool_path=opponent_pool_path,
        rollout_fragment_length=rollout_fragment_length,
        max_cards=max_cards,
        arena_only=arena_only,
        deck_seed=deck_seed,
        turn_limit=turn_limit,
        gpu_per_trial=allocated_gpu,
        shaping_weight=shaping_weight,
        shaping_weight_final=shaping_weight_final,
        shaping_anneal_episodes=shaping_anneal_episodes,
        bc_checkpoint=bc_checkpoint,
        bc_kl_coeff=bc_kl_coeff,
        bc_kl_iters=bc_kl_iters,
        deck_pool_version=deck_pool_version,
    )

    if resume:
        if resume == "latest":
            experiment_name = _find_latest_experiment(storage_path)
            if experiment_name is None:
                raise SystemExit(
                    f"[orchestrator] --resume latest: no pbt_mtg_* experiments under "
                    f"{storage_path}. Start a fresh run or copy an existing experiment "
                    f"directory there first."
                )
        else:
            experiment_name = resume
            if not (Path(storage_path) / experiment_name).is_dir():
                raise SystemExit(
                    f"[orchestrator] --resume {experiment_name!r}: directory not found "
                    f"under {storage_path}. Did you copy the old experiment over?"
                )
        print(
            f"[orchestrator] resuming experiment {experiment_name} from {storage_path}",
            file=sys.stderr,
        )
    else:
        experiment_name = f"pbt_mtg_{int(time.time())}"

    tune_kwargs: Dict[str, Any] = dict(
        name=experiment_name,
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
    if resume:
        tune_kwargs["resume"] = "AUTO"

    algorithm: Any = "IMPALA"
    if bc_kl_coeff > 0:
        if not bc_checkpoint:
            raise SystemExit(
                "[orchestrator] --bc-kl-coeff requires --bc-checkpoint; "
                "the KL term anchors the learner to those weights."
            )
        from ml_engine.ray_cluster.bc_kl_policy import load_bc_anchored_impala
        algorithm = load_bc_anchored_impala()
        print(
            "[orchestrator] IMPALA loss includes KL(current || BC) "
            f"coeff={bc_kl_coeff} for {bc_kl_iters} training iterations",
            file=sys.stderr,
        )
    analysis = tune.run(algorithm, **tune_kwargs)

    metric_keys = list(selected_metric.history_keys)
    best, stable_score, trial_summaries = _select_stable_trial(list(analysis.trials), metric_keys)
    if best:
        # Ray reports the metric under different keys depending on version
        # (reward_mean -> return_mean rename). Try both before falling back to
        # 0.0 so the print isn't a misleading "reward=0.000" when the trial
        # actually returned non-zero (e.g. the +0.229 we saw on trial 00003
        # while the print said 0.000).
        last = best.last_result or {}
        reward = stable_score
        if reward is None:
            reward = _read_metric(last, metric_key)
        if reward is None:
            reward = _read_metric(last, metric_key_alt)
        if reward is None:
            reward = 0.0
        checkpoint = str(best.checkpoint) if best.checkpoint else None
        print(f"[orchestrator] stable best trial: {best.trial_id} tail_reward={reward:.3f}")
        print(f"[orchestrator] checkpoint: {checkpoint}")

        # A champion is only a *candidate* for serving. The Node quality gate
        # additionally requires clean deck data and recorded Forge labels.
        champion_path = Path(storage_path) / "ray_champion.json"
        previous = {}
        try:
            previous = json.loads(champion_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
        decision = promotion_decision(
            None if checkpoint is None else reward,
            previous,
            selected_metric.mode,
        )
        promoted = bool(decision["promoted"]) and checkpoint is not None
        baseline = float(decision["baseline"])
        report = {
            "trial_id": best.trial_id,
            "reward": reward,
            "metric_mode": selected_metric.mode,
            "metric_value": reward,
            "selection_metric": selected_metric.primary_key,
            "selection_window": "mean_of_last_20_recorded_windows",
            "trial_summaries": trial_summaries,
            "baseline_reward": baseline,
            "checkpoint": checkpoint,
            "promoted": promoted,
            "reason": decision["reason"] if checkpoint is not None else "missing_checkpoint",
            "visible_gpus": available_gpus,
            "gpu_per_trial": allocated_gpu,
            "pbt_resample_probability": pbt_resample_probability,
            "created_at": time.time(),
        }
        (Path(storage_path) / experiment_name / "promotion_report.json").write_text(
            json.dumps(report, indent=2), encoding="utf-8"
        )
        if promoted:
            champion_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print("[orchestrator] PROMOTED: checkpoint passed Ray baseline gate; run training quality gate before serving.")
        else:
            print("[orchestrator] NOT PROMOTED: checkpoint retained only as an experiment artifact.")
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
    p.add_argument(
        "--gpu-per-trial",
        type=float,
        default=None,
        help="Ray GPU reservation per trial. Default: one GPU per trial when possible; use 0 for CPU.",
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
    # Arena pool toggle. Three states encoded so a CLI flag can override the
    # env var both ways:
    #   --arena-only            → force arena_only=True
    #   --no-arena-only         → force arena_only=False
    #   (neither flag passed)   → fall back to TRAINING_POOL_ARENA_ONLY env var
    arena_group = p.add_mutually_exclusive_group()
    arena_group.add_argument(
        "--arena-only",
        dest="arena_only",
        action="store_true",
        default=None,
        help="restrict the card pool to MTG Arena-legal cards "
             "(overrides TRAINING_POOL_ARENA_ONLY env var)",
    )
    arena_group.add_argument(
        "--no-arena-only",
        dest="arena_only",
        action="store_false",
        help="force the full paper catalog (overrides "
             "TRAINING_POOL_ARENA_ONLY env var)",
    )
    p.add_argument(
        "--deck-seed",
        type=int,
        default=None,
        help="seed for the Arena-only archetype matchup picker (deterministic when set)",
    )
    p.add_argument(
        "--resume",
        type=str,
        default=None,
        metavar="EXPERIMENT",
        help="resume a previous PBT run by experiment dir name (e.g. pbt_mtg_1778128357), "
             "or 'latest' to pick the newest under storage_path",
    )
    p.add_argument(
        "--turn-limit",
        type=int,
        default=DEFAULT_TURN_LIMIT_FOR_TRAINING,
        help="max turns per episode before truncation (default: 50). "
             "Lower (e.g. 30) reduces episode-length variance and speeds throughput.",
    )
    p.add_argument(
        "--pbt-metric",
        choices=("win_rate", "reward"),
        default="win_rate",
        help="objective PBT perturbs on and promotion compares. "
             "win_rate (default) is custom_metrics/win_mean over decisive games. "
             "reward is the legacy shaped episode return.",
    )
    p.add_argument(
        "--shaping-weight",
        type=float,
        default=1.0,
        help="initial multiplier on potential-based shaping (gamma*Phi' - Phi)",
    )
    p.add_argument(
        "--shaping-anneal-episodes",
        type=int,
        default=0,
        help="episodes over which shaping_weight decays to 0. 0 keeps it constant.",
    )
    p.add_argument(
        "--bc-checkpoint",
        default=None,
        help="behavior-cloning weights to copy into the GNN before IMPALA starts",
    )
    p.add_argument(
        "--deck-pool-version",
        choices=("1", "2"),
        default=None,
        help="deck pool manifest version. Sets DECK_POOL_VERSION for this process "
             "and the Ray workers. Default is v1 unless the env var is already set.",
    )
    p.add_argument(
        "--bc-kl-coeff",
        type=float,
        default=0.0,
        help="KL(current || BC) weight for the first --bc-kl-iters training "
             "iterations, then linearly decayed to 0. Counts Tune training "
             "iterations, not gradient updates. Requires --bc-checkpoint.",
    )
    p.add_argument(
        "--bc-kl-iters",
        type=int,
        default=0,
        help="training iterations that keep the BC KL term; it then drops to 0",
    )
    p.add_argument(
        "--archetypes",
        type=str,
        default=None,
        metavar="LIST",
        help="comma-separated curriculum subset of arena archetypes "
             "(e.g. aggro_red,control_uw,midrange_bg). Sets TRAINING_ARCHETYPES; "
             "default samples all 15.",
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
        arena_only=args.arena_only,
        deck_seed=args.deck_seed,
        resume=args.resume,
        turn_limit=args.turn_limit,
        archetypes=args.archetypes,
        gpu_per_trial=args.gpu_per_trial,
        pbt_metric=args.pbt_metric,
        shaping_weight=args.shaping_weight,
        shaping_anneal_episodes=args.shaping_anneal_episodes,
        bc_checkpoint=args.bc_checkpoint,
        bc_kl_coeff=args.bc_kl_coeff,
        bc_kl_iters=args.bc_kl_iters,
        deck_pool_version=args.deck_pool_version,
    )


if __name__ == "__main__":
    main()
