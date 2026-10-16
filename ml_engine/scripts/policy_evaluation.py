"""Evaluate a frozen Ray policy against reproducible Forge baselines.

Example (promotion-safe only with a declared holdout manifest)::

    node scripts/run-python.mjs -m ml_engine.scripts.policy_evaluation \
      --checkpoint C:\\path\\to\\checkpoint \
      --matchup-manifest artifacts/training/heldout_matchups.json \
      --output artifacts/policy_evaluation/run-001/report.json

The command never starts training.  It writes a versioned JSON report even
when the checkpoint cannot be restored, then exits non-zero unless every
promotion gate passes.  A consumer should inspect ``report.json`` rather than
assuming a zero exit code is the only evidence.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

from ml_engine.ray_cluster.arena_pool import is_arena_only_training
from ml_engine.ray_cluster.deck_pool import sample_pair, training_deck_hashes
from ml_engine.ray_cluster.policy_evaluation import (
    AlwaysPassPolicy,
    EvaluationThresholds,
    HeldoutMatchup,
    LegalRandomPolicy,
    RayCheckpointPolicy,
    blocked_report,
    build_report,
    default_output_path,
    evaluate_policy,
    make_forge_env_factory,
    write_report,
)


def load_matchup_manifest(path: Path) -> tuple[list[HeldoutMatchup], list[str]]:
    """Parse the intentionally small, auditable heldout-manifest contract.

    Accepted shape::

        {
          "training_deck_hashes": ["sha256..."],
          "matchups": [{
            "id": "control-vs-aggro-01", "seed": 1001,
            "agent_deck": "4 ...", "opponent_deck": "4 ...",
            "split": "heldout"
          }]
        }

    A plain list of matchup objects is also accepted for simple local runs,
    but cannot prove deck-pool disjointness because it contains no training
    hashes.  Deck contents are used only to construct Forge envs; the report
    stores hashes, not the text.
    """

    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, list):
        items = raw
        training_hashes: list[str] = []
    elif isinstance(raw, Mapping):
        items = raw.get("matchups")
        training_hashes = _string_list(raw.get("training_deck_hashes", []))
    else:
        raise ValueError("matchup manifest must be a JSON object or list")
    if not isinstance(items, list) or not items:
        raise ValueError("matchup manifest requires a non-empty 'matchups' list")

    matchups: list[HeldoutMatchup] = []
    identifiers: set[str] = set()
    for index, value in enumerate(items):
        if not isinstance(value, Mapping):
            raise ValueError(f"matchups[{index}] must be an object")
        identifier = str(value.get("id") or value.get("identifier") or "").strip()
        if not identifier:
            raise ValueError(f"matchups[{index}] needs a non-empty id")
        if identifier in identifiers:
            raise ValueError(f"duplicate matchup id: {identifier!r}")
        identifiers.add(identifier)
        try:
            seed = int(value["seed"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"matchups[{index}] needs integer seed") from exc
        split = str(value.get("split", "")).strip().lower()
        declared = bool(value.get("declared_heldout", False)) or split in {
            "heldout",
            "holdout",
            "test",
        }
        matchups.append(
            HeldoutMatchup(
                identifier=identifier,
                seed=seed,
                agent_deck=_optional_text(value.get("agent_deck")),
                opponent_deck=_optional_text(value.get("opponent_deck")),
                declared_heldout=declared,
                source=f"manifest:{Path(path).name}",
            )
        )
    return matchups, training_hashes


def generated_seed_holdout(seeds: Sequence[int], *, arena_only: bool) -> list[HeldoutMatchup]:
    """Create diagnostic matchups when no auditable manifest is supplied.

    Arena runs sample the deck pool's holdout split, which is disjoint from
    the lists training plays. These runs are explicitly *not* declared as a
    promotion holdout. The default gates therefore fail closed until the
    operator supplies a manifest that declares the test split.
    """

    matchups: list[HeldoutMatchup] = []
    for seed in seeds:
        if arena_only:
            agent, opponent = sample_pair("holdout", seed)
            agent_deck, opponent_deck = agent.forge_list, opponent.forge_list
            identifier = f"holdout-{seed}-{agent.deck_id}-vs-{opponent.deck_id}"
            source = "deck_pool_holdout"
        else:
            agent_deck, opponent_deck = None, None
            identifier = f"generated-seed-{seed}"
            source = "generated_seed_holdout"
        matchups.append(
            HeldoutMatchup(
                identifier=identifier,
                seed=seed,
                agent_deck=agent_deck,
                opponent_deck=opponent_deck,
                declared_heldout=False,
                source=source,
            )
        )
    return matchups


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Frozen-policy Forge evaluation and promotion-gate report"
    )
    parser.add_argument("--checkpoint", required=True, help="Ray/RLlib checkpoint directory")
    parser.add_argument(
        "--matchup-manifest",
        type=Path,
        help="JSON declared holdout manifest; required for a passing report by default",
    )
    parser.add_argument(
        "--output", type=Path, default=None, help="report.json path (default artifacts/policy_evaluation/<timestamp>/report.json)"
    )
    parser.add_argument(
        "--seeds",
        default="91001,91002,91003",
        help="comma-separated diagnostic holdout seeds when no manifest is supplied",
    )
    parser.add_argument("--episodes-per-matchup", type=int, default=2)
    parser.add_argument("--max-steps", type=int, default=400)
    parser.add_argument("--turn-limit", type=int, default=50)
    parser.add_argument("--step-timeout", type=float, default=20.0)
    parser.add_argument(
        "--deck-pool-version",
        choices=("1", "2"),
        default=None,
        help="set DECK_POOL_VERSION before sampling the holdout (default: env or v1)",
    )
    parser.add_argument(
        "--arena-only",
        action="store_true",
        default=None,
        help="generate Arena-pool diagnostic matchups (default follows TRAINING_POOL_ARENA_ONLY)",
    )
    parser.add_argument(
        "--allow-undeclared-holdout",
        action="store_true",
        help="do not require manifest matchups to declare split=heldout; diagnostic only",
    )
    parser.add_argument(
        "--require-verified-disjoint-holdout",
        action="store_true",
        help="require training_deck_hashes in manifest and no deck hash overlap",
    )
    parser.add_argument(
        "--require-forge-ai-baseline",
        action="store_true",
        help="fail until the bridge supports a causally controlled Forge-AI baseline",
    )
    parser.add_argument("--min-completed-episodes", type=int, default=6)
    parser.add_argument("--min-terminal-episode-rate", type=float, default=0.80)
    parser.add_argument("--min-action-legality-rate", type=float, default=0.98)
    parser.add_argument("--min-action-applied-rate", type=float, default=0.98)
    parser.add_argument("--min-candidate-win-rate", type=float, default=0.50)
    parser.add_argument("--min-candidate-win-rate-lower-bound-95", type=float, default=0.25)
    parser.add_argument("--min-win-rate-delta-vs-legal-random", type=float, default=0.05)
    parser.add_argument("--min-life-difference-delta-vs-legal-random", type=float, default=1.0)
    return parser


def _thresholds_from_args(args: argparse.Namespace) -> EvaluationThresholds:
    return EvaluationThresholds(
        min_completed_episodes=args.min_completed_episodes,
        min_terminal_episode_rate=args.min_terminal_episode_rate,
        min_action_legality_rate=args.min_action_legality_rate,
        min_action_applied_rate=args.min_action_applied_rate,
        min_candidate_win_rate=args.min_candidate_win_rate,
        min_candidate_win_rate_lower_bound_95=args.min_candidate_win_rate_lower_bound_95,
        min_win_rate_delta_vs_legal_random=args.min_win_rate_delta_vs_legal_random,
        min_life_difference_delta_vs_legal_random=args.min_life_difference_delta_vs_legal_random,
        require_declared_heldout_matchups=not args.allow_undeclared_holdout,
        require_verified_disjoint_holdout=args.require_verified_disjoint_holdout,
        require_forge_ai_baseline=args.require_forge_ai_baseline,
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parser().parse_args(argv)
    if args.deck_pool_version:
        os.environ["DECK_POOL_VERSION"] = args.deck_pool_version
    output = args.output or default_output_path()
    checkpoint = str(args.checkpoint)
    try:
        if args.episodes_per_matchup < 1 or args.max_steps < 1:
            raise ValueError("--episodes-per-matchup and --max-steps must be >= 1")
        if args.matchup_manifest:
            matchups, training_hashes = load_matchup_manifest(args.matchup_manifest)
        else:
            arena_only = (
                is_arena_only_training() if args.arena_only is None else bool(args.arena_only)
            )
            matchups = generated_seed_holdout(_parse_seeds(args.seeds), arena_only=arena_only)
            # Arena diagnostics play the holdout split. Supply the train hashes
            # so the report can prove those lists were not training opponents.
            training_hashes = training_deck_hashes() if arena_only else []
        thresholds = _thresholds_from_args(args)
    except Exception as exc:
        report = blocked_report(
            checkpoint=checkpoint, reason=f"invalid_evaluation_configuration:{type(exc).__name__}: {exc}"
        )
        report_path = write_report(report, output)
        _print_summary(report, report_path)
        return 2

    try:
        candidate = RayCheckpointPolicy.load(checkpoint)
    except Exception as exc:
        report = blocked_report(
            checkpoint=checkpoint, reason=f"checkpoint_load_failed:{type(exc).__name__}: {exc}"
        )
        report_path = write_report(report, output)
        _print_summary(report, report_path)
        return 2

    factory = make_forge_env_factory(
        turn_limit=args.turn_limit,
        step_timeout=args.step_timeout,
    )
    try:
        candidate_metrics, candidate_episodes = evaluate_policy(
            candidate,
            factory,
            matchups,
            episodes_per_matchup=args.episodes_per_matchup,
            max_steps=args.max_steps,
        )
        pass_metrics, _ = evaluate_policy(
            AlwaysPassPolicy(),
            factory,
            matchups,
            episodes_per_matchup=args.episodes_per_matchup,
            max_steps=args.max_steps,
        )
        random_metrics, _ = evaluate_policy(
            LegalRandomPolicy(seed=20261014),
            factory,
            matchups,
            episodes_per_matchup=args.episodes_per_matchup,
            max_steps=args.max_steps,
        )
        report = build_report(
            checkpoint=checkpoint,
            candidate_metrics=candidate_metrics,
            pass_metrics=pass_metrics,
            random_metrics=random_metrics,
            matchups=matchups,
            thresholds=thresholds,
            training_deck_hashes=training_hashes,
            candidate_errors=candidate_episodes,
        )
    except Exception as exc:
        report = blocked_report(
            checkpoint=checkpoint, reason=f"evaluation_harness_failed:{type(exc).__name__}: {exc}"
        )
    finally:
        candidate.close()

    report_path = write_report(report, output)
    _print_summary(report, report_path)
    return 0 if report.get("pass") is True else 2


def _print_summary(report: Mapping[str, Any], report_path: Path) -> None:
    payload = {
        "status": report.get("status"),
        "pass": report.get("pass"),
        "reasons": report.get("reasons", []),
        "report_path": str(report_path),
    }
    print(json.dumps(payload, indent=2), flush=True)


def _parse_seeds(raw: str) -> list[int]:
    values = [part.strip() for part in str(raw).split(",") if part.strip()]
    if not values:
        raise ValueError("--seeds must include at least one integer")
    try:
        return [int(value) for value in values]
    except ValueError as exc:
        raise ValueError("--seeds must be comma-separated integers") from exc


def _optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("deck entries must be strings or null")
    return value


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("training_deck_hashes must be a list of strings")
    return list(value)


if __name__ == "__main__":
    sys.exit(main())
