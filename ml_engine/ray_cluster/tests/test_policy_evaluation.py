"""Regression tests for the frozen-policy evaluation/promotion contract."""

from __future__ import annotations

from typing import Any, Mapping

import numpy as np

from ml_engine.ray_cluster.policy_evaluation import (
    AlwaysPassPolicy,
    EvaluationThresholds,
    HeldoutMatchup,
    LegalRandomPolicy,
    aggregate_episode_results,
    blocked_report,
    build_report,
    evaluate_policy,
    run_episode,
)


def _observation() -> dict[str, np.ndarray]:
    return {"action_mask": np.asarray([1, 1, 0, 0], dtype=np.int8)}


class _PlayWinningAction:
    name = "play_winning_action"

    def select_action(self, observation: Mapping[str, Any], *, state: Mapping[str, Any]) -> int:
        return 1


class _IllegalPolicy:
    name = "illegal"

    def select_action(self, observation: Mapping[str, Any], *, state: Mapping[str, Any]) -> int:
        return 3


class _FakeEnv:
    """One-step Forge-shaped environment whose action determines outcome."""

    def __init__(self) -> None:
        self.closed = False

    def reset(self, *, seed: int):
        return _observation(), {"state": {"policy_controlled": True}}

    def step(self, action: int):
        legal = action in (0, 1)
        winner = action == 1
        state = {
            "policy_controlled": True,
            "policy_action_applied": legal,
            "illegal_action": not legal,
            "terminal": True,
            "outcome": 1 if winner else -1,
            "life_you": 25 if winner else 10,
            "life_opp": 10 if winner else 25,
        }
        return _observation(), 1.0 if winner else -1.0, True, False, {"state": state}

    def close(self):
        self.closed = True


class _ErrorInfoEnv(_FakeEnv):
    def step(self, action: int):
        return _observation(), -0.05, True, False, {"error": "forge_step_timeout"}


def _matchup() -> HeldoutMatchup:
    return HeldoutMatchup(
        identifier="heldout-red-vs-blue",
        seed=123,
        agent_deck="4 Lightning Bolt\n56 Mountain",
        opponent_deck="4 Counterspell\n56 Island",
        declared_heldout=True,
    )


def _factory(matchup: HeldoutMatchup) -> _FakeEnv:
    return _FakeEnv()


def _permissive_thresholds(**changes: Any) -> EvaluationThresholds:
    values: dict[str, Any] = {
        "min_completed_episodes": 1,
        "min_terminal_episode_rate": 1.0,
        "min_action_legality_rate": 1.0,
        "min_action_applied_rate": 1.0,
        "min_candidate_win_rate": 1.0,
        "min_candidate_win_rate_lower_bound_95": 0.0,
        "min_win_rate_delta_vs_legal_random": 0.0,
        "min_life_difference_delta_vs_legal_random": 0.0,
        "require_declared_heldout_matchups": True,
    }
    values.update(changes)
    return EvaluationThresholds(**values)


def test_run_episode_records_bridge_legality_application_and_life_delta():
    result = run_episode(
        _FakeEnv(), _PlayWinningAction(), _matchup(), max_steps=3
    )

    assert result.completed is True
    assert result.terminal is True
    assert result.outcome == 1
    assert result.actions_attempted == 1
    assert result.selected_legal_actions == 1
    assert result.bridge_legal_actions == 1
    assert result.actions_applied == 1
    assert result.policy_controlled_steps == 1
    assert result.final_life_difference == 15.0


def test_illegal_action_is_visible_in_integrity_metrics():
    result = run_episode(_FakeEnv(), _IllegalPolicy(), _matchup(), max_steps=3)
    metrics = aggregate_episode_results([result])

    assert metrics.action_selected_legal_rate == 0.0
    assert metrics.action_legality_rate == 0.0
    assert metrics.action_applied_rate == 0.0
    assert metrics.system_errors == 0


def test_info_error_is_not_misclassified_as_a_legal_completed_game():
    result = run_episode(_ErrorInfoEnv(), _PlayWinningAction(), _matchup(), max_steps=3)
    metrics = aggregate_episode_results([result])

    assert result.completed is False
    assert result.error == "env_error:forge_step_timeout"
    assert metrics.system_errors == 1
    assert metrics.bridge_legal_actions == 0
    assert metrics.action_legality_rate == 0.0


def test_evaluate_policy_repeats_matchup_with_reproducible_seed_offsets():
    metrics, episodes = evaluate_policy(
        _PlayWinningAction(),
        _factory,
        [_matchup()],
        episodes_per_matchup=3,
        max_steps=2,
    )

    assert [episode.seed for episode in episodes] == [123, 124, 125]
    assert metrics.episodes == 3
    assert metrics.completed_episodes == 3
    assert metrics.win_rate == 1.0
    assert metrics.action_legality_rate == 1.0
    assert metrics.action_applied_rate == 1.0


def test_promotion_report_passes_only_when_candidate_beats_controls():
    candidate, candidate_episodes = evaluate_policy(
        _PlayWinningAction(), _factory, [_matchup()], episodes_per_matchup=1, max_steps=2
    )
    # Pass is a deliberate loss in _FakeEnv.  Use an explicit losing policy as
    # the legal-random control so the comparison remains deterministic.
    passed, pass_episodes = evaluate_policy(
        AlwaysPassPolicy(), _factory, [_matchup()], episodes_per_matchup=1, max_steps=2
    )
    random_control = passed
    report = build_report(
        checkpoint="C:/checkpoints/candidate",
        candidate_metrics=candidate,
        pass_metrics=passed,
        random_metrics=random_control,
        matchups=[_matchup()],
        thresholds=_permissive_thresholds(
            min_win_rate_delta_vs_legal_random=1.0,
            min_life_difference_delta_vs_legal_random=30.0,
            require_forge_ai_baseline=False,
            require_verified_disjoint_holdout=False,
        ),
        candidate_episodes=candidate_episodes,
        pass_episodes=pass_episodes,
        random_episodes=pass_episodes,
        candidate_errors=candidate_episodes,
        checkpoint_sha256="ab" * 32,
        checkpoint_hash_algorithm="relative_posix_path_NUL_file_sha256_LF",
        checkpoint_file_count=1,
        generated_at="2026-10-15T00:00:00+00:00",
    )

    assert report["schema_version"] == "1.0"
    assert report["status"] == "passed"
    assert report["pass"] is True
    assert report["baselines"]["always_pass"]["status"] == "passed"
    assert report["baselines"]["legal_random"]["status"] == "passed"
    assert report["baselines"]["forge_ai"]["status"] == "blocked"
    assert report["heldout_matchups"][0]["declared_heldout"] is True
    assert report["comparisons"]["candidate_vs_legal_random"]["win_rate_delta"] == 1.0


def test_promotion_report_fails_closed_for_unapplied_policy_actions():
    candidate_result = run_episode(_FakeEnv(), _IllegalPolicy(), _matchup(), max_steps=2)
    candidate = aggregate_episode_results([candidate_result])
    control_result = run_episode(_FakeEnv(), AlwaysPassPolicy(), _matchup(), max_steps=2)
    control = aggregate_episode_results([control_result])
    report = build_report(
        checkpoint="candidate",
        candidate_metrics=candidate,
        pass_metrics=control,
        random_metrics=control,
        matchups=[_matchup()],
        thresholds=_permissive_thresholds(),
        candidate_errors=[candidate_result],
    )

    assert report["pass"] is False
    assert report["gates"]["minimum_action_legality_rate"] is False
    assert report["gates"]["minimum_action_applied_rate"] is False
    assert "minimum_action_legality_rate" in report["reasons"]
    assert "minimum_action_applied_rate" in report["reasons"]


def test_verified_holdout_requires_disjoint_training_hashes_when_requested():
    candidate, episodes = evaluate_policy(
        _PlayWinningAction(), _factory, [_matchup()], episodes_per_matchup=1, max_steps=2
    )
    control, _ = evaluate_policy(
        AlwaysPassPolicy(), _factory, [_matchup()], episodes_per_matchup=1, max_steps=2
    )
    report = build_report(
        checkpoint="candidate",
        candidate_metrics=candidate,
        pass_metrics=control,
        random_metrics=control,
        matchups=[_matchup()],
        thresholds=_permissive_thresholds(
            min_win_rate_delta_vs_legal_random=1.0,
            min_life_difference_delta_vs_legal_random=30.0,
            require_verified_disjoint_holdout=True,
        ),
        # Same hash as the agent deck proves this matchup is not disjoint.
        training_deck_hashes=[_matchup().agent_deck_sha256 or ""],
        candidate_errors=episodes,
    )

    assert report["pass"] is False
    assert report["gates"]["verified_disjoint_holdout"] is False
    assert "verified_disjoint_holdout" in report["reasons"]


def test_blocked_report_is_schema_valid_and_fail_closed():
    report = blocked_report(checkpoint="missing", reason="checkpoint_load_failed")

    assert report["schema_version"] == "1.0"
    assert report["status"] == "blocked"
    assert report["pass"] is False
    assert report["baselines"]["forge_ai"]["status"] == "blocked"
