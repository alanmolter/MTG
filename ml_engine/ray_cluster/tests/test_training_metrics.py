"""PBT metric selection and episode-metric copying, without Ray."""

import pytest

from ml_engine.ray_cluster.training_metrics import (
    numeric_custom_metrics,
    promotion_decision,
    resolve_pbt_metric,
)


def test_default_pbt_metric_is_win_rate():
    metric = resolve_pbt_metric(None)
    assert metric.mode == "win_rate"
    assert metric.primary_key == "custom_metrics/win_mean"


def test_reward_metric_keeps_the_legacy_keys():
    metric = resolve_pbt_metric("reward")
    assert metric.primary_key == "env_runners/episode_reward_mean"
    assert "episode_return_mean" in metric.history_keys


def test_unknown_pbt_metric_is_rejected():
    with pytest.raises(ValueError, match="pbt_metric"):
        resolve_pbt_metric("shaped")


def test_custom_metrics_skip_missing_win_on_truncation():
    copied = numeric_custom_metrics({
        "episode_metrics": {
            "win": None,
            "truncated": 1,
            "steps": 12,
            "passes": 4,
            "lands_played_per_turn": 0.5,
            "steps_per_sec": 3.0,
            "seed": 7,
            "agent_deck_id": "q06_mono_red_burn",
            "agent_deck_sha256": "abc",
        }
    })
    assert "win" not in copied
    assert copied["truncated"] == 1.0
    assert copied["steps"] == 12.0
    assert "seed" not in copied
    assert "agent_deck_id" not in copied
    assert "agent_deck_sha256" not in copied


def test_custom_metrics_copy_forge_match_counters():
    copied = numeric_custom_metrics({
        "episode_metrics": {
            "win": 1,
            "forge_matches_enqueued": 4,
            "forge_matches_written": 3,
            "forge_matches_dropped": 1,
        }
    })
    assert copied["forge_matches_enqueued"] == 4.0
    assert copied["forge_matches_written"] == 3.0
    assert copied["forge_matches_dropped"] == 1.0


def test_custom_metrics_keep_a_decisive_loss():
    copied = numeric_custom_metrics({"episode_metrics": {"win": 0, "truncated": 0, "steps": 1}})
    assert copied["win"] == 0.0


def test_win_rate_promotion_beats_a_previous_win_rate():
    decision = promotion_decision(0.62, {"metric_mode": "win_rate", "metric_value": 0.55}, "win_rate")
    assert decision["promoted"] is True
    assert decision["baseline"] == pytest.approx(0.55)


def test_win_rate_does_not_treat_a_shaped_reward_champion_as_a_win_rate():
    decision = promotion_decision(0.2, {"metric_mode": "reward", "metric_value": 0.4, "reward": 0.4}, "win_rate")
    assert decision["promoted"] is False
    assert decision["baseline"] == pytest.approx(0.5)
    better = promotion_decision(0.7, {"metric_mode": "reward", "reward": 1.2}, "win_rate")
    assert better["promoted"] is True


def test_legacy_reward_champion_still_compares_reward():
    decision = promotion_decision(0.3, {"reward": 0.2}, "reward")
    assert decision["promoted"] is True
    assert decision["baseline"] == pytest.approx(0.2)
    worse = promotion_decision(-0.1, {"reward": 0.2}, "reward")
    assert worse["promoted"] is False
