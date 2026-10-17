"""Deterministic Forge action-family acceptance scenarios.

This gate exercises the *live* Java controller, rather than just checking that
bits appear in a mask.  Each scripted policy chooses only actions published as
legal, then checks that Forge acknowledged their application at the next
decision.  The tiny decks keep the target mechanic frequent across fixed
seeds.  A failed family is reported separately; the trainer must not infer
full Magic competence from a short integration smoke test.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Callable, Mapping

import numpy as np

from ml_engine.ray_cluster.env import MtgForgeEnv


KIND_PASS = 0
KIND_PLAY = 1
KIND_ATTACK = 2
KIND_BLOCK = 3
KIND_TARGET = 4
KIND_ACTIVATE = 5


def _visible_choices(observation: Mapping[str, Any]) -> list[int]:
    return [int(index) for index in np.flatnonzero(observation["action_mask"])]


def _source_name(state: Mapping[str, Any], observation: Mapping[str, Any], action: int) -> str:
    index = int(observation["action_source_indices"][action])
    cards = state.get("cards", [])
    return str(cards[index].get("name", "")) if 0 <= index < len(cards) else ""


def _first_kind(observation: Mapping[str, Any], kind: int) -> int | None:
    for action in _visible_choices(observation):
        if int(observation["action_kinds"][action]) == kind and action not in (0, 510, 511):
            return action
    return None


def _scripted_action(
    state: Mapping[str, Any], observation: Mapping[str, Any],
    *, preferred_card: str,
) -> int:
    decision = str(state.get("decision_kind") or state.get("decision_type") or "")
    if decision == "mulligan":
        return 0
    if decision == "choose_cards":
        for action in _visible_choices(observation):
            if int(observation["action_mask"][action]) == 1:
                return action
        return 0
    if decision == "choose_targets":
        for action in _visible_choices(observation):
            if int(observation["action_kinds"][action]) == KIND_TARGET and \
                    int(observation["action_target_indices"][action]) == -3:
                return action
        action = _first_kind(observation, KIND_TARGET)
        return action if action is not None else 0
    if decision == "declare_attackers":
        action = _first_kind(observation, KIND_ATTACK)
        return action if action is not None else 0
    if decision == "declare_blockers":
        action = _first_kind(observation, KIND_BLOCK)
        return action if action is not None else 0

    for action in _visible_choices(observation):
        if int(observation["action_kinds"][action]) == KIND_PLAY and \
                _source_name(state, observation, action) == preferred_card:
            return action
    for action in _visible_choices(observation):
        if int(observation["action_kinds"][action]) == KIND_PLAY and \
                _source_name(state, observation, action) in {"Forest", "Mountain"}:
            return action
    for action in _visible_choices(observation):
        if int(observation["action_kinds"][action]) == KIND_ACTIVATE and \
                _source_name(state, observation, action) == preferred_card:
            return action
    return 0


SCENARIOS = (
    {
        "name": "land_mana_cast_attack",
        "seed": 1701,
        "agent_deck": "20 Grizzly Bears\n40 Forest\n",
        "opponent_deck": "20 Grizzly Bears\n40 Forest\n",
        "preferred_card": "Grizzly Bears",
        "required_kinds": (KIND_PLAY, KIND_ATTACK),
        "max_steps": 180,
    },
    {
        "name": "targeted_spell_stack",
        "seed": 1702,
        "agent_deck": "20 Lightning Bolt\n40 Mountain\n",
        "opponent_deck": "20 Grizzly Bears\n40 Forest\n",
        "preferred_card": "Lightning Bolt",
        "required_kinds": (KIND_PLAY, KIND_TARGET),
        "max_steps": 90,
    },
    {
        "name": "activated_ability",
        "seed": 1703,
        "agent_deck": "20 Prodigal Pyromancer\n40 Mountain\n",
        "opponent_deck": "60 Forest\n",
        "preferred_card": "Prodigal Pyromancer",
        "required_kinds": (KIND_PLAY, KIND_ACTIVATE, KIND_TARGET),
        "max_steps": 160,
    },
    {
        "name": "declare_blockers",
        "seed": 1703,
        "agent_deck": "20 Prodigal Pyromancer\n40 Mountain\n",
        "opponent_deck": "20 Grizzly Bears\n40 Forest\n",
        "preferred_card": "Prodigal Pyromancer",
        "required_kinds": (KIND_PLAY, KIND_BLOCK),
        "max_steps": 90,
    },
)


def run_mask_rejection() -> dict[str, Any]:
    """An invalid slot must be rejected without advancing the Forge game."""
    env = MtgForgeEnv({
        "agent_deck": "20 Grizzly Bears\n40 Forest\n",
        "opponent_deck": "60 Forest\n",
        "turn_limit": 12,
        "step_timeout": 20,
        "require_policy_control": True,
    })
    violations: list[str] = []
    try:
        obs, info = env.reset(seed=1777)
        state = info["state"]
        invalid_slot = 509
        if int(obs["action_mask"][invalid_slot]) != 0:
            violations.append("test_slot_unexpectedly_legal")
        else:
            _, _, terminated, _, rejected_info = env.step(invalid_slot)
            rejected = rejected_info["state"]
            if terminated or not rejected.get("illegal_action") or rejected.get("policy_action_applied"):
                violations.append("invalid_slot_not_rejected")
            if rejected.get("turn") != state.get("turn") or \
                    (rejected.get("decision_kind") or rejected.get("decision_type")) != \
                    (state.get("decision_kind") or state.get("decision_type")):
                violations.append("invalid_slot_advanced_game")
            _, _, _, _, recovery_info = env.step(0)
            recovered = recovery_info["state"]
            if not recovered.get("policy_action_applied") or recovered.get("illegal_action"):
                violations.append("valid_action_not_recovered")
    except Exception as exc:
        violations.append(f"{type(exc).__name__}: {exc}")
    finally:
        env.close()
    return {"name": "invalid_mask_rejected", "pass": not violations,
            "violations": violations}


def run_scenario(spec: Mapping[str, Any]) -> dict[str, Any]:
    env = MtgForgeEnv({
        "agent_deck": spec["agent_deck"],
        "opponent_deck": spec["opponent_deck"],
        "turn_limit": 12,
        "step_timeout": 20,
        "require_policy_control": True,
    })
    seen: set[int] = set()
    applied: set[int] = set()
    violations: list[str] = []
    trace: list[dict[str, Any]] = []
    steps = 0
    try:
        obs, info = env.reset(seed=int(spec["seed"]))
        state = info["state"]
        for steps in range(1, int(spec["max_steps"]) + 1):
            if state.get("policy_contract_violation"):
                violations.append(str(state["policy_contract_violation"]))
                break
            action = _scripted_action(state, obs, preferred_card=str(spec["preferred_card"]))
            kind = int(obs["action_kinds"][action])
            if os.getenv("MTG_MECHANICS_TRACE") == "1":
                trace.append({
                    "step": steps,
                    "turn": state.get("turn"),
                    "decision": state.get("decision_type"),
                    "action": action,
                    "kind": kind,
                    "source": _source_name(state, obs, action),
                    "battlefield_you": state.get("battlefield_you"),
                    "mana_available_you": state.get("mana_available_you"),
                    "hand": [card.get("name") for card in state.get("cards", []) if card.get("zone") == "hand"],
                    "legal_sources": [_source_name(state, obs, legal) for legal in _visible_choices(obs)
                                      if legal not in (0, 510, 511)],
                })
            if action != 0 and kind in (KIND_PLAY, KIND_ATTACK, KIND_BLOCK, KIND_TARGET, KIND_ACTIVATE):
                seen.add(kind)
            obs, _, terminated, truncated, info = env.step(action)
            state = info.get("state", {})
            if state.get("policy_action_applied") and not state.get("illegal_action"):
                if kind in seen:
                    applied.add(kind)
            elif not state.get("terminal"):
                violations.append("selected_action_not_applied")
                break
            if terminated or truncated:
                break
    except Exception as exc:
        violations.append(f"{type(exc).__name__}: {exc}")
    finally:
        env.close()
    required = set(int(kind) for kind in spec["required_kinds"])
    missing = sorted(required - applied)
    return {
        "name": spec["name"],
        "pass": not violations and not missing,
        "seed": spec["seed"],
        "steps": steps,
        "seen_kinds": sorted(seen),
        "applied_kinds": sorted(applied),
        "missing_kinds": missing,
        "violations": violations,
        **({"trace": trace} if trace else {}),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=[spec["name"] for spec in SCENARIOS] + ["invalid_mask_rejected"])
    args = parser.parse_args(argv)
    chosen = [spec for spec in SCENARIOS if args.scenario in (None, spec["name"])]
    results = [run_scenario(spec) for spec in chosen]
    if args.scenario in (None, "invalid_mask_rejected"):
        results.append(run_mask_rejection())
    passed = all(result["pass"] for result in results)
    print(json.dumps({
        "schema_version": "1.0",
        "pass": passed,
        "scenarios": results,
    }, indent=2), flush=True)
    return 0 if passed else 2


if __name__ == "__main__":
    sys.exit(main())
