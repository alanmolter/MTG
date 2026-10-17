"""PBT / promotion metric selection that does not import Ray.

The training signal used to be shaped episode return. That return can be
gamed by the potential, so the default objective is the decisive-game win
rate logged as ``custom_metrics/win_mean``. ``reward`` keeps the old
objective for a run that explicitly asks for it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional, Sequence, Tuple


WIN_RATE_KEYS: Tuple[str, ...] = ("custom_metrics/win_mean",)
REWARD_KEYS: Tuple[str, ...] = (
    "env_runners/episode_reward_mean",
    "env_runners/episode_return_mean",
    "episode_reward_mean",
    "episode_return_mean",
)
NUMERIC_EPISODE_METRICS: Tuple[str, ...] = (
    "win",
    "truncated",
    "steps",
    "passes",
    "lands_played_per_turn",
    "steps_per_sec",
    "forge_matches_enqueued",
    "forge_matches_written",
    "forge_matches_dropped",
    "ai_fallback_decisions",
    "policy_decisions",
)


@dataclass(frozen=True)
class PbtMetric:
    mode: str
    primary_key: str
    history_keys: Tuple[str, ...]


def resolve_pbt_metric(mode: Optional[str]) -> PbtMetric:
    """Map the config flag onto the Ray metric name PBT and promotion read."""

    selected = (mode or "win_rate").strip().lower()
    if selected == "win_rate":
        return PbtMetric("win_rate", WIN_RATE_KEYS[0], WIN_RATE_KEYS)
    if selected == "reward":
        return PbtMetric("reward", REWARD_KEYS[0], REWARD_KEYS)
    raise ValueError(f"pbt_metric must be 'win_rate' or 'reward', got {mode!r}")


def numeric_custom_metrics(info: Optional[Mapping]) -> dict:
    """Copy finite per-episode numbers onto an RLlib custom-metrics dict.

    ``win`` is omitted for truncations and draws so the mean is the win rate
    over decisive games only. Seed and deck hashes stay in the log line; they
    are not averages.
    """

    if not isinstance(info, Mapping):
        return {}
    metrics = info.get("episode_metrics")
    if not isinstance(metrics, Mapping):
        return {}
    copied = {}
    for key in NUMERIC_EPISODE_METRICS:
        value = metrics.get(key)
        if value is None:
            continue
        copied[key] = float(value)
    by_kind = metrics.get("ai_fallback_by_kind")
    if isinstance(by_kind, Mapping):
        for key, value in by_kind.items():
            try:
                copied[f"ai_fallback_{key}"] = float(value)
            except (TypeError, ValueError):
                continue
    return copied


def promotion_decision(
    score: Optional[float],
    previous: Optional[Mapping],
    mode: str,
) -> dict:
    """Decide whether ``score`` replaces the stored champion.

    Same-mode comparisons use the previous metric value. A legacy champion
    file that only stored ``reward`` is treated as reward-mode. Switching
    the objective to win rate does not compare a win rate against a shaped
    return; the new run must win more than half of its decisive games.
    """

    previous = dict(previous or {})
    if score is None:
        return {"promoted": False, "reason": "missing_metric", "baseline": 0.0}

    prev_mode = previous.get("metric_mode")
    same_mode = prev_mode == mode or (
        mode == "reward" and prev_mode is None and "reward" in previous
    )
    if same_mode:
        if mode == "reward" and prev_mode is None:
            baseline = float(previous.get("reward") or 0.0)
        else:
            baseline = float(previous.get("metric_value", previous.get("reward", 0.0)) or 0.0)
        promoted = score > 0.0 and score > baseline
        reason = (
            "strictly_beats_positive_stable_baseline"
            if promoted else "did_not_beat_positive_stable_baseline"
        )
        return {"promoted": promoted, "reason": reason, "baseline": baseline}

    if previous and mode == "win_rate":
        baseline = 0.5
        promoted = score > baseline
        reason = (
            "beats_even_odds_under_new_metric"
            if promoted else "did_not_beat_baseline_under_new_metric"
        )
        return {"promoted": promoted, "reason": reason, "baseline": baseline}

    promoted = score > 0.0
    return {
        "promoted": promoted,
        "reason": "strictly_beats_positive_stable_baseline" if promoted else "did_not_beat_positive_stable_baseline",
        "baseline": 0.0,
    }


def history_keys_for(mode: Optional[str]) -> Sequence[str]:
    return resolve_pbt_metric(mode).history_keys
