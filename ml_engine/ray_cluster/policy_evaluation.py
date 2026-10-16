"""Policy evaluation harness and fail-closed promotion gates for Forge RL.

Training reward is useful for optimization but is not evidence that a policy
plays Magic well.  This module evaluates a *frozen* policy on a fixed suite of
matchups and compares it with simple, reproducible controls:

* ``always_pass``: a deliberately weak lower bound;
* ``legal_random``: uniformly samples only actions exposed by Forge's legal
  action mask;
* ``forge_ai``: the same player/deck is delegated to Forge's built-in AI, so
  the baseline faces the same Forge-AI opponent on the same seeds.  Unlike
  the externally controlled policies, its game finishes during ``reset``.

The public artifact is a JSON document with ``schema_version == "1.0"``.  It
is intentionally independent from Ray Tune's reward files so a promotion
consumer can fail closed when the evaluation is missing, malformed, or weak.
The core functions take an ``env_factory`` and are unit-testable without
starting Forge or Ray.
"""

from __future__ import annotations

import hashlib
import math
import random
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Mapping, Optional, Protocol, Sequence

import numpy as np


SCHEMA_VERSION = "1.0"
FORGE_AI_BASELINE_REASON = "forge_ai_controlled_baseline_not_evaluated"


class EvaluationPolicy(Protocol):
    """Minimal policy protocol used by the evaluator.

    Implementations must return a scalar discrete action.  The production
    learner currently trains on the masked ``Discrete(512)`` action space;
    evaluation deliberately rejects a tuple/MultiDiscrete action instead of
    accidentally judging a differently encoded action space.
    """

    name: str

    def select_action(
        self,
        observation: Mapping[str, Any],
        *,
        state: Mapping[str, Any],
    ) -> int:
        """Choose one action for the supplied observation."""


@dataclass(frozen=True)
class HeldoutMatchup:
    """A deterministic evaluation matchup.

    Deck text remains out of the report by default.  Hashes let a training
    manifest prove that its deck pool and evaluation deck pool are disjoint
    without placing complete decklists in a promotion artifact.
    """

    identifier: str
    seed: int
    agent_deck: Optional[str] = None
    opponent_deck: Optional[str] = None
    declared_heldout: bool = False
    source: str = "manifest"

    @property
    def agent_deck_sha256(self) -> Optional[str]:
        return _text_sha256(self.agent_deck)

    @property
    def opponent_deck_sha256(self) -> Optional[str]:
        return _text_sha256(self.opponent_deck)

    def report_dict(self, *, verified_disjoint: bool = False) -> Dict[str, Any]:
        return {
            "id": self.identifier,
            "seed": self.seed,
            "source": self.source,
            "declared_heldout": self.declared_heldout,
            "verified_disjoint_from_training": verified_disjoint,
            "agent_deck_sha256": self.agent_deck_sha256,
            "opponent_deck_sha256": self.opponent_deck_sha256,
        }


@dataclass(frozen=True)
class EvaluationThresholds:
    """Promotion thresholds, emitted verbatim into every report.

    Values are conservative defaults rather than claims about a mature
    competitive benchmark.  They force evidence of legal execution and an
    improvement over random legal play, while callers may raise them for a
    specific format or ladder target.
    """

    min_completed_episodes: int = 6
    min_terminal_episode_rate: float = 0.80
    min_action_legality_rate: float = 0.98
    min_action_applied_rate: float = 0.98
    min_candidate_win_rate: float = 0.50
    min_candidate_win_rate_lower_bound_95: float = 0.25
    min_win_rate_delta_vs_legal_random: float = 0.05
    min_life_difference_delta_vs_legal_random: float = 1.0
    min_win_rate_delta_vs_always_pass: float = 0.05
    min_life_difference_delta_vs_always_pass: float = 1.0
    min_win_rate_delta_vs_forge_ai: float = 0.0
    min_life_difference_delta_vs_forge_ai: float = 0.0
    min_win_rate_delta_vs_incumbent: float = 0.0
    min_life_difference_delta_vs_incumbent: float = 0.0
    min_paired_win_delta_lower_bound_95: float = 0.0
    min_paired_life_delta_lower_bound_95: float = 0.0
    require_declared_heldout_matchups: bool = True
    require_verified_disjoint_holdout: bool = True
    require_forge_ai_baseline: bool = True
    require_episode_evidence: bool = True


@dataclass
class EpisodeResult:
    matchup_id: str
    seed: int
    policy_name: str
    completed: bool = False
    terminal: bool = False
    truncated: bool = False
    outcome: Optional[int] = None
    final_life_difference: Optional[float] = None
    episode_return: float = 0.0
    actions_attempted: int = 0
    selected_legal_actions: int = 0
    bridge_legal_actions: int = 0
    actions_applied: int = 0
    policy_controlled_steps: int = 0
    error: Optional[str] = None


@dataclass
class AggregateMetrics:
    episodes: int
    completed_episodes: int
    terminal_episodes: int
    truncated_episodes: int
    decisive_episodes: int
    wins: int
    losses: int
    draws: int
    action_attempts: int
    selected_legal_actions: int
    bridge_legal_actions: int
    actions_applied: int
    policy_controlled_steps: int
    system_errors: int
    win_rate: Optional[float]
    win_rate_lower_bound_95: Optional[float]
    mean_life_difference: Optional[float]
    mean_episode_return: Optional[float]
    action_selected_legal_rate: Optional[float]
    action_legality_rate: Optional[float]
    action_applied_rate: Optional[float]
    policy_controlled_rate: Optional[float]
    terminal_episode_rate: Optional[float]

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


class AlwaysPassPolicy:
    name = "always_pass"

    def select_action(
        self, observation: Mapping[str, Any], *, state: Mapping[str, Any]
    ) -> int:
        return 0


class LegalRandomPolicy:
    """Reproducible random policy over the bridge-provided legal mask."""

    name = "legal_random"

    def __init__(self, seed: int = 0) -> None:
        self._rng = random.Random(seed)

    def select_action(
        self, observation: Mapping[str, Any], *, state: Mapping[str, Any]
    ) -> int:
        legal = legal_action_ids(observation)
        return self._rng.choice(legal) if legal else 0


class RayCheckpointPolicy:
    """Thin inference adapter around a frozen RLlib Algorithm checkpoint."""

    name = "ray_checkpoint"

    def __init__(self, algorithm: Any, checkpoint: str) -> None:
        self._algorithm = algorithm
        self.checkpoint = str(Path(checkpoint).resolve())

    @classmethod
    def load(cls, checkpoint: str) -> "RayCheckpointPolicy":
        # Registration happens before restore.  A fresh evaluation process
        # otherwise cannot resolve the custom environment/model identifiers
        # serialized in a Tune checkpoint.
        from ml_engine.models.game_state_gnn import register_with_rllib as register_model
        from ml_engine.ray_cluster.env import register_with_rllib as register_env

        register_env()
        register_model()
        from ray.rllib.algorithms.algorithm import Algorithm

        algorithm = Algorithm.from_checkpoint(checkpoint)
        return cls(algorithm, checkpoint)

    def select_action(
        self, observation: Mapping[str, Any], *, state: Mapping[str, Any]
    ) -> int:
        result = self._algorithm.compute_single_action(
            observation, explore=False
        )
        # RLlib has returned both a scalar and `(action, state, info)` across
        # versions/configurations.  Only a scalar is valid for this evaluator.
        action = result[0] if isinstance(result, tuple) else result
        return _coerce_discrete_action(action)

    def close(self) -> None:
        stop = getattr(self._algorithm, "stop", None)
        if callable(stop):
            stop()


EnvFactory = Callable[[HeldoutMatchup], Any]


def legal_action_ids(observation: Mapping[str, Any]) -> list[int]:
    """Return legal discrete action IDs from a Gym/RLlib observation."""

    raw_mask = observation.get("action_mask")
    if raw_mask is None:
        return []
    values = np.asarray(raw_mask).reshape(-1)
    return [int(index) for index, value in enumerate(values) if bool(value)]


def run_episode(
    env: Any,
    policy: EvaluationPolicy,
    matchup: HeldoutMatchup,
    *,
    max_steps: int,
) -> EpisodeResult:
    """Run one evaluation episode and retain action-integrity telemetry.

    Any exception becomes a failed episode rather than a process crash.  This
    makes timeout/control failures visible to promotion gates as system errors.
    """

    result = EpisodeResult(
        matchup_id=matchup.identifier,
        seed=matchup.seed,
        policy_name=policy.name,
    )
    try:
        observation, info = env.reset(seed=matchup.seed)
        state = _state_from_info(info)
        if not state or state.get("policy_controlled") is not True:
            result.error = "policy_control_not_confirmed_on_reset"
            return result
        for _ in range(max_steps):
            legal_ids = legal_action_ids(observation)
            if not legal_ids:
                result.error = "empty_or_missing_legal_action_mask"
                return result
            action = _coerce_discrete_action(
                policy.select_action(observation, state=state)
            )
            result.actions_attempted += 1
            if action in legal_ids:
                result.selected_legal_actions += 1

            observation, reward, terminated, truncated, info = env.step(action)
            result.episode_return += _safe_float(reward, default=0.0)
            state = _state_from_info(info)

            # MtgForgeEnv reports subprocess/control failures in `info`
            # instead of necessarily raising.  Never misclassify that dummy
            # transition as a legal terminal game (or count it toward a rate).
            if isinstance(info, Mapping) and info.get("error"):
                result.error = f"env_error:{info['error']}"
                result.final_life_difference = _life_difference(state)
                return result

            required_telemetry = (
                "policy_controlled", "policy_action_applied", "illegal_action"
            )
            missing = [key for key in required_telemetry if key not in state]
            if missing:
                result.error = "missing_bridge_telemetry:" + ",".join(missing)
                return result
            if state["policy_controlled"] is not True:
                result.error = "policy_control_lost"
                return result

            if bool(state.get("policy_controlled", False)):
                result.policy_controlled_steps += 1
            if bool(state.get("policy_action_applied", False)):
                result.actions_applied += 1
            if not bool(state.get("illegal_action", False)):
                result.bridge_legal_actions += 1

            if terminated or truncated:
                result.completed = True
                result.terminal = bool(terminated)
                result.truncated = bool(truncated)
                outcome = state.get("outcome")
                if outcome in (-1, 0, 1):
                    result.outcome = int(outcome)
                result.final_life_difference = _life_difference(state)
                if result.terminal and (
                    result.outcome is None or result.final_life_difference is None
                ):
                    result.error = "terminal_result_missing_outcome_or_life"
                    result.completed = False
                    result.terminal = False
                return result

        result.error = f"episode_step_cap_reached:{max_steps}"
        result.final_life_difference = _life_difference(state)
        return result
    except Exception as exc:  # The gate must see, not hide, bridge failures.
        result.error = f"{type(exc).__name__}: {exc}"
        return result
    finally:
        close = getattr(env, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass


def run_forge_ai_episode(env: Any, matchup: HeldoutMatchup) -> EpisodeResult:
    """Run the same deck as Forge AI; its autonomous game ends in ``reset``."""

    result = EpisodeResult(
        matchup_id=matchup.identifier, seed=matchup.seed, policy_name="forge_ai"
    )
    try:
        _, info = env.reset(seed=matchup.seed)
        state = _state_from_info(info)
        if isinstance(info, Mapping) and info.get("error"):
            result.error = f"env_error:{info['error']}"
            return result
        if state.get("agent_policy") not in (None, "forge_ai"):
            result.error = "forge_ai_baseline_controller_mismatch"
            return result
        if state.get("policy_controlled") is not False:
            result.error = "forge_ai_baseline_external_policy_still_active"
            return result
        if state.get("terminal") is not True:
            result.error = "forge_ai_baseline_not_terminal_at_reset"
            return result
        outcome = state.get("outcome")
        if outcome not in (-1, 0, 1):
            result.error = "forge_ai_baseline_missing_outcome"
            return result
        life = _life_difference(state)
        if life is None:
            result.error = "forge_ai_baseline_missing_life_difference"
            return result
        result.completed = True
        result.terminal = True
        result.outcome = int(outcome)
        result.final_life_difference = life
        return result
    except Exception as exc:
        result.error = f"{type(exc).__name__}: {exc}"
        return result
    finally:
        close = getattr(env, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass


def evaluate_policy(
    policy: EvaluationPolicy,
    env_factory: EnvFactory,
    matchups: Sequence[HeldoutMatchup],
    *,
    episodes_per_matchup: int,
    max_steps: int,
) -> tuple[AggregateMetrics, list[EpisodeResult]]:
    """Evaluate one policy over repeated, seed-controlled heldout matchups."""

    if episodes_per_matchup < 1:
        raise ValueError("episodes_per_matchup must be >= 1")
    if max_steps < 1:
        raise ValueError("max_steps must be >= 1")
    results: list[EpisodeResult] = []
    for episode_matchup in _expanded_matchups(matchups, episodes_per_matchup):
        try:
            env = env_factory(episode_matchup)
        except Exception as exc:
            results.append(
                EpisodeResult(
                    matchup_id=episode_matchup.identifier,
                    seed=episode_matchup.seed,
                    policy_name=policy.name,
                    error=f"env_factory:{type(exc).__name__}: {exc}",
                )
            )
            continue
        results.append(
            run_episode(env, policy, episode_matchup, max_steps=max_steps)
        )
    return aggregate_episode_results(results), results


def evaluate_forge_ai_baseline(
    env_factory: EnvFactory,
    matchups: Sequence[HeldoutMatchup],
    *,
    episodes_per_matchup: int,
) -> tuple[AggregateMetrics, list[EpisodeResult]]:
    """Evaluate Forge-AI agent on the exact policy-matchup/seed schedule."""

    if episodes_per_matchup < 1:
        raise ValueError("episodes_per_matchup must be >= 1")
    results: list[EpisodeResult] = []
    for episode_matchup in _expanded_matchups(matchups, episodes_per_matchup):
        try:
            env = env_factory(episode_matchup)
        except Exception as exc:
            results.append(
                EpisodeResult(
                    matchup_id=episode_matchup.identifier,
                    seed=episode_matchup.seed,
                    policy_name="forge_ai",
                    error=f"env_factory:{type(exc).__name__}: {exc}",
                )
            )
            continue
        results.append(run_forge_ai_episode(env, episode_matchup))
    return aggregate_episode_results(results), results


def _expanded_matchups(
    matchups: Sequence[HeldoutMatchup], repeats: int
) -> Iterable[HeldoutMatchup]:
    for matchup in matchups:
        for repeat in range(repeats):
            yield HeldoutMatchup(
                identifier=matchup.identifier,
                seed=matchup.seed + repeat,
                agent_deck=matchup.agent_deck,
                opponent_deck=matchup.opponent_deck,
                declared_heldout=matchup.declared_heldout,
                source=matchup.source,
            )


def aggregate_episode_results(results: Sequence[EpisodeResult]) -> AggregateMetrics:
    """Reduce raw episode telemetry into promotion-safe metrics."""

    completed = [item for item in results if item.completed and item.error is None]
    terminal = [item for item in completed if item.terminal]
    truncated = [item for item in completed if item.truncated]
    outcomes = [item.outcome for item in terminal if item.outcome in (-1, 0, 1)]
    wins = sum(1 for outcome in outcomes if outcome == 1)
    losses = sum(1 for outcome in outcomes if outcome == -1)
    draws = sum(1 for outcome in outcomes if outcome == 0)
    attempts = sum(item.actions_attempted for item in results)
    life_differences = [
        item.final_life_difference
        for item in terminal
        if item.final_life_difference is not None
    ]
    returns = [item.episode_return for item in completed]
    return AggregateMetrics(
        episodes=len(results),
        completed_episodes=len(completed),
        terminal_episodes=len(terminal),
        truncated_episodes=len(truncated),
        decisive_episodes=len(outcomes),
        wins=wins,
        losses=losses,
        draws=draws,
        action_attempts=attempts,
        selected_legal_actions=sum(item.selected_legal_actions for item in results),
        bridge_legal_actions=sum(item.bridge_legal_actions for item in results),
        actions_applied=sum(item.actions_applied for item in results),
        policy_controlled_steps=sum(item.policy_controlled_steps for item in results),
        system_errors=sum(1 for item in results if item.error is not None),
        win_rate=_ratio(wins, len(outcomes)),
        win_rate_lower_bound_95=_wilson_lower_bound(wins, len(outcomes)),
        mean_life_difference=_mean(life_differences),
        mean_episode_return=_mean(returns),
        action_selected_legal_rate=_ratio(
            sum(item.selected_legal_actions for item in results), attempts
        ),
        action_legality_rate=_ratio(
            sum(item.bridge_legal_actions for item in results), attempts
        ),
        action_applied_rate=_ratio(
            sum(item.actions_applied for item in results), attempts
        ),
        policy_controlled_rate=_ratio(
            sum(item.policy_controlled_steps for item in results), attempts
        ),
        terminal_episode_rate=_ratio(len(terminal), len(results)),
    )


def build_report(
    *,
    checkpoint: str,
    candidate_metrics: AggregateMetrics,
    pass_metrics: AggregateMetrics,
    random_metrics: AggregateMetrics,
    forge_ai_metrics: Optional[AggregateMetrics] = None,
    incumbent_metrics: Optional[AggregateMetrics] = None,
    incumbent_checkpoint: Optional[str] = None,
    matchups: Sequence[HeldoutMatchup],
    thresholds: EvaluationThresholds,
    training_deck_hashes: Iterable[str] = (),
    candidate_errors: Sequence[EpisodeResult] = (),
    candidate_episodes: Sequence[EpisodeResult] = (),
    pass_episodes: Sequence[EpisodeResult] = (),
    random_episodes: Sequence[EpisodeResult] = (),
    forge_ai_episodes: Sequence[EpisodeResult] = (),
    incumbent_episodes: Sequence[EpisodeResult] = (),
    checkpoint_sha256: Optional[str] = None,
    checkpoint_hash_algorithm: Optional[str] = None,
    checkpoint_file_count: Optional[int] = None,
    incumbent_sha256: Optional[str] = None,
    incumbent_hash_algorithm: Optional[str] = None,
    incumbent_file_count: Optional[int] = None,
    generated_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a stable, fail-closed JSON report and compute its gates."""

    training_hashes = {str(value).lower() for value in training_deck_hashes if value}
    matchup_reports: list[Dict[str, Any]] = []
    verified_count = 0
    declared_count = 0
    for matchup in matchups:
        hashes = {
            value.lower()
            for value in (matchup.agent_deck_sha256, matchup.opponent_deck_sha256)
            if value
        }
        verified = (
            matchup.agent_deck_sha256 is not None
            and matchup.opponent_deck_sha256 is not None
            and bool(training_hashes)
            and hashes.isdisjoint(training_hashes)
        )
        declared_count += int(matchup.declared_heldout)
        verified_count += int(verified)
        matchup_reports.append(matchup.report_dict(verified_disjoint=verified))

    episode_sets = {
        "candidate": candidate_episodes,
        "always_pass": pass_episodes,
        "legal_random": random_episodes,
        "forge_ai": forge_ai_episodes,
    }
    if incumbent_metrics is not None or incumbent_checkpoint is not None:
        episode_sets["incumbent"] = incumbent_episodes
    candidate_failure_messages = [
        item.error for item in (*candidate_errors, *candidate_episodes) if item.error
    ]
    pass_baseline_status = _baseline_status(pass_metrics)
    random_baseline_status = _baseline_status(random_metrics)
    forge_ai_baseline_status = (
        _baseline_status(forge_ai_metrics, require_actions=False)
        if forge_ai_metrics is not None else "blocked"
    )
    incumbent_status = (
        _baseline_status(incumbent_metrics)
        if incumbent_metrics is not None else "not_run"
    )
    comparisons = {
        "candidate_vs_always_pass": _paired_comparison(
            candidate_metrics, pass_metrics, candidate_episodes, pass_episodes
        ),
        "candidate_vs_legal_random": _paired_comparison(
            candidate_metrics, random_metrics, candidate_episodes, random_episodes
        ),
        "candidate_vs_forge_ai": _paired_comparison(
            candidate_metrics, forge_ai_metrics, candidate_episodes, forge_ai_episodes
        ),
    }
    if incumbent_metrics is not None or incumbent_checkpoint is not None:
        comparisons["candidate_vs_incumbent"] = _paired_comparison(
            candidate_metrics, incumbent_metrics, candidate_episodes, incumbent_episodes
        )
    evidence_valid = _episode_evidence_valid(episode_sets, {
        "candidate": candidate_metrics,
        "always_pass": pass_metrics,
        "legal_random": random_metrics,
        "forge_ai": forge_ai_metrics,
        "incumbent": incumbent_metrics,
    })
    comparison_specs = (
        ("always_pass", thresholds.min_win_rate_delta_vs_always_pass,
         thresholds.min_life_difference_delta_vs_always_pass),
        ("legal_random", thresholds.min_win_rate_delta_vs_legal_random,
         thresholds.min_life_difference_delta_vs_legal_random),
        ("forge_ai", thresholds.min_win_rate_delta_vs_forge_ai,
         thresholds.min_life_difference_delta_vs_forge_ai),
    )

    gates: Dict[str, bool] = {
        "checkpoint_identity_recorded": _valid_sha256(checkpoint_sha256)
        and bool(checkpoint_hash_algorithm) and bool(checkpoint_file_count),
        "candidate_has_no_system_errors": candidate_metrics.system_errors == 0,
        "candidate_completed_all_episodes": (
            candidate_metrics.episodes > 0
            and candidate_metrics.completed_episodes == candidate_metrics.episodes
        ),
        "always_pass_baseline_available": pass_baseline_status == "passed",
        "legal_random_baseline_available": random_baseline_status == "passed",
        "forge_ai_baseline_available": (
            not thresholds.require_forge_ai_baseline
            or forge_ai_baseline_status == "passed"
        ),
        "episode_evidence_complete": (
            not thresholds.require_episode_evidence or evidence_valid
        ),
        "minimum_completed_episodes": (
            candidate_metrics.completed_episodes >= thresholds.min_completed_episodes
        ),
        "minimum_terminal_episode_rate": _at_least(
            candidate_metrics.terminal_episode_rate,
            thresholds.min_terminal_episode_rate,
        ),
        "minimum_action_legality_rate": _at_least(
            candidate_metrics.action_legality_rate,
            thresholds.min_action_legality_rate,
        ),
        "minimum_action_applied_rate": _at_least(
            candidate_metrics.action_applied_rate,
            thresholds.min_action_applied_rate,
        ),
        "minimum_candidate_win_rate": _at_least(
            candidate_metrics.win_rate,
            thresholds.min_candidate_win_rate,
        ),
        "minimum_candidate_win_rate_lower_bound_95": _at_least(
            candidate_metrics.win_rate_lower_bound_95,
            thresholds.min_candidate_win_rate_lower_bound_95,
        ),
        "declared_heldout_matchups": (
            not thresholds.require_declared_heldout_matchups
            or (len(matchups) > 0 and declared_count == len(matchups))
        ),
        "verified_disjoint_holdout": (
            not thresholds.require_verified_disjoint_holdout
            or (len(matchups) > 0 and verified_count == len(matchups))
        ),
    }
    for baseline, minimum_win, minimum_life in comparison_specs:
        comparison = comparisons[f"candidate_vs_{baseline}"]
        if baseline == "forge_ai" and not thresholds.require_forge_ai_baseline:
            continue
        gates[f"beats_{baseline}_win_rate"] = _at_least(
            comparison["win_rate_delta"], minimum_win
        )
        gates[f"beats_{baseline}_life_difference"] = _at_least(
            comparison["mean_life_difference_delta"], minimum_life
        )
        gates[f"stable_{baseline}_win_rate"] = _at_least(
            comparison["win_rate_delta_lower_bound_95"],
            thresholds.min_paired_win_delta_lower_bound_95,
        )
        gates[f"stable_{baseline}_life_difference"] = _at_least(
            comparison["life_difference_delta_lower_bound_95"],
            thresholds.min_paired_life_delta_lower_bound_95,
        )
        gates[f"paired_{baseline}_episodes"] = (
            comparison["paired_terminal_episodes"] >= thresholds.min_completed_episodes
        )
    if incumbent_metrics is not None or incumbent_checkpoint is not None:
        comparison = comparisons["candidate_vs_incumbent"]
        gates["incumbent_baseline_available"] = incumbent_status == "passed"
        gates["incumbent_identity_recorded"] = _valid_sha256(incumbent_sha256)
        gates["beats_incumbent_win_rate"] = _at_least(
            comparison["win_rate_delta"], thresholds.min_win_rate_delta_vs_incumbent
        )
        gates["beats_incumbent_life_difference"] = _at_least(
            comparison["mean_life_difference_delta"],
            thresholds.min_life_difference_delta_vs_incumbent,
        )
        gates["stable_incumbent_win_rate"] = _at_least(
            comparison["win_rate_delta_lower_bound_95"],
            thresholds.min_paired_win_delta_lower_bound_95,
        )
        gates["stable_incumbent_life_difference"] = _at_least(
            comparison["life_difference_delta_lower_bound_95"],
            thresholds.min_paired_life_delta_lower_bound_95,
        )
        gates["paired_incumbent_episodes"] = (
            comparison["paired_terminal_episodes"] >= thresholds.min_completed_episodes
        )
    reasons = [name for name, passed in gates.items() if not passed]
    if candidate_failure_messages:
        reasons.extend(f"candidate_episode_error:{message}" for message in candidate_failure_messages)

    status = "passed" if not reasons else "failed"
    report = {
        "schema_version": SCHEMA_VERSION,
        "status": status,
        "pass": status == "passed",
        "generated_at": generated_at
        or datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "candidate": {
            "checkpoint": str(checkpoint),
            "checkpoint_sha256": checkpoint_sha256,
            "checkpoint_hash_algorithm": checkpoint_hash_algorithm,
            "checkpoint_file_count": checkpoint_file_count,
            "policy": "ray_checkpoint",
            "metrics": candidate_metrics.as_dict(),
        },
        "opponent": {
            "kind": "forge_ai",
            "description": "Forge built-in AI controls the opponent in all executable evaluations.",
        },
        "baselines": {
            "always_pass": {
                "status": pass_baseline_status,
                "metrics": pass_metrics.as_dict(),
            },
            "legal_random": {
                "status": random_baseline_status,
                "metrics": random_metrics.as_dict(),
            },
            "forge_ai": {
                "status": forge_ai_baseline_status,
                "metrics": forge_ai_metrics.as_dict() if forge_ai_metrics else None,
                **({"reason": FORGE_AI_BASELINE_REASON}
                   if forge_ai_metrics is None else {}),
            },
        },
        "comparisons": comparisons,
        "episodes": {
            name: [asdict(item) for item in items]
            for name, items in episode_sets.items()
        },
        "heldout_matchups": matchup_reports,
        "heldout_protocol": {
            "declared_matchups": declared_count,
            "verified_disjoint_matchups": verified_count,
            "training_deck_hashes_supplied": len(training_hashes),
            "note": (
                "A declared holdout is an operator assertion. Verified-disjoint "
                "requires training deck hashes in the manifest."
            ),
        },
        "thresholds": asdict(thresholds),
        "evaluation_protocol": {
            "seed_pairing": "same_matchup_id_and_seed",
            "confidence_interval": "paired_bootstrap_percentile_95_2000_draws",
            "checkpoint_digest": "relative_posix_path_NUL_file_sha256_LF",
            "opponent": "forge_ai",
        },
        "gates": gates,
        "reasons": reasons,
    }
    if incumbent_metrics is not None or incumbent_checkpoint is not None:
        report["incumbent"] = {
            "checkpoint": incumbent_checkpoint,
            "checkpoint_sha256": incumbent_sha256,
            "checkpoint_hash_algorithm": incumbent_hash_algorithm,
            "checkpoint_file_count": incumbent_file_count,
            "policy": "ray_checkpoint",
            "status": incumbent_status,
            "metrics": incumbent_metrics.as_dict() if incumbent_metrics else None,
        }
    return report


def blocked_report(
    *, checkpoint: str, reason: str, generated_at: Optional[str] = None
) -> Dict[str, Any]:
    """Return a schema-valid report when checkpoint loading cannot begin."""

    return {
        "schema_version": SCHEMA_VERSION,
        "status": "blocked",
        "pass": False,
        "generated_at": generated_at
        or datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "candidate": {"checkpoint": str(checkpoint), "policy": "ray_checkpoint", "metrics": None},
        "opponent": {"kind": "forge_ai"},
        "baselines": {
            "always_pass": {"status": "not_run"},
            "legal_random": {"status": "not_run"},
            "forge_ai": {"status": "blocked", "reason": FORGE_AI_BASELINE_REASON},
        },
        "heldout_matchups": [],
        "thresholds": None,
        "gates": {},
        "reasons": [reason],
    }


def make_forge_env_factory(
    *, turn_limit: int, step_timeout: float, extra_config: Optional[Mapping[str, Any]] = None
) -> EnvFactory:
    """Build an environment factory for a real Forge evaluation.

    A fresh JVM is used for every episode.  This costs startup time but avoids
    cross-game state leakage and makes timeout/control telemetry attributable
    to one checkpoint/matchup pair.
    """

    from ml_engine.ray_cluster.env import MtgForgeEnv

    base_config = dict(extra_config or {})

    def factory(matchup: HeldoutMatchup) -> MtgForgeEnv:
        config = {
            **base_config,
            "agent_deck": matchup.agent_deck,
            "opponent_deck": matchup.opponent_deck,
            "turn_limit": turn_limit,
            "step_timeout": step_timeout,
            "use_autoregressive_actions": False,
            "require_policy_control": True,
        }
        return MtgForgeEnv(config)

    return factory


def default_output_path() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return Path("artifacts") / "policy_evaluation" / f"evaluation_{stamp}" / "report.json"


def write_report(report: Mapping[str, Any], output: Path) -> Path:
    """Atomically persist a promotion-consumable report."""

    import json

    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(output.suffix + ".tmp")
    temp.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp.replace(output)
    return output.resolve()


def _state_from_info(info: Any) -> Mapping[str, Any]:
    if isinstance(info, Mapping) and isinstance(info.get("state"), Mapping):
        return info["state"]
    return {}


def _coerce_discrete_action(value: Any) -> int:
    if isinstance(value, np.ndarray):
        if value.size != 1:
            raise ValueError("policy returned non-discrete ndarray action")
        value = value.reshape(-1)[0]
    if isinstance(value, (list, tuple)):
        if len(value) != 1:
            raise ValueError("policy returned non-discrete action")
        value = value[0]
    if isinstance(value, (bool, np.bool_)):
        raise ValueError("policy returned boolean instead of discrete action")
    return int(value)


def _life_difference(state: Mapping[str, Any]) -> Optional[float]:
    if "life_you" in state or "life_opp" in state:
        return _safe_float(state.get("life_you"), 20.0) - _safe_float(
            state.get("life_opp"), 20.0
        )
    you = state.get("you")
    opponent = state.get("opp")
    if isinstance(you, Mapping) and isinstance(opponent, Mapping):
        return _safe_float(you.get("life"), 20.0) - _safe_float(opponent.get("life"), 20.0)
    return None


def _safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _text_sha256(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = "\n".join(line.strip() for line in str(value).strip().splitlines())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _mean(values: Sequence[Optional[float]]) -> Optional[float]:
    numeric = [float(value) for value in values if value is not None]
    return sum(numeric) / len(numeric) if numeric else None


def _ratio(numerator: int, denominator: int) -> Optional[float]:
    return float(numerator) / float(denominator) if denominator > 0 else None


def _difference(left: Optional[float], right: Optional[float]) -> Optional[float]:
    return None if left is None or right is None else left - right


def _at_least(value: Optional[float], threshold: float) -> bool:
    return value is not None and value >= threshold


def _baseline_status(metrics: AggregateMetrics) -> str:
    """Whether a baseline is usable for a promotion comparison.

    A baseline can lose every game and still pass: quality is not the point of
    a lower-bound control.  It must, however, finish every requested episode
    without a bridge error and yield finite comparison metrics.  Consumers can
    therefore reject a report instead of treating a crashed random baseline as
    evidence that the candidate won.
    """

    required = (
        metrics.episodes > 0,
        metrics.completed_episodes == metrics.episodes,
        metrics.system_errors == 0,
        metrics.action_legality_rate is not None,
        metrics.action_applied_rate is not None,
        metrics.mean_life_difference is not None,
        metrics.win_rate is not None,
    )
    return "passed" if all(required) else "failed"


def _wilson_lower_bound(successes: int, total: int, z: float = 1.959963984540054) -> Optional[float]:
    """Two-sided 95% Wilson lower bound without SciPy."""

    if total <= 0:
        return None
    p = successes / float(total)
    denominator = 1.0 + (z * z) / total
    center = p + (z * z) / (2.0 * total)
    margin = z * math.sqrt((p * (1.0 - p) + (z * z) / (4.0 * total)) / total)
    return max(0.0, (center - margin) / denominator)


__all__ = [
    "AggregateMetrics",
    "AlwaysPassPolicy",
    "EvaluationPolicy",
    "EvaluationThresholds",
    "FORGE_AI_BASELINE_REASON",
    "HeldoutMatchup",
    "LegalRandomPolicy",
    "RayCheckpointPolicy",
    "SCHEMA_VERSION",
    "aggregate_episode_results",
    "blocked_report",
    "build_report",
    "default_output_path",
    "evaluate_policy",
    "legal_action_ids",
    "make_forge_env_factory",
    "run_episode",
    "write_report",
]
