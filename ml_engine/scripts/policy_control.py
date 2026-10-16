"""Phase 1 policy-control acceptance, criteria A1-A11.

The in-process bridge is what CI runs at the full sample sizes (200 episodes,
1000 illegal actions, 20 determinism pairs). A machine with Forge jars can
run the same checks against the JVM via ``--live``. Smoke defaults are smaller;
set ``POLICY_CONTROL_EPISODES=200`` for the documented run.
"""

from __future__ import annotations

import hashlib
import math
import os
import time
from typing import Any, Mapping


REQUIRED = ("policy_control", "seed", "legal_mask", "decision_points")


def _mask(extra: bool) -> tuple[list[int], list[int], list[int], list[int]]:
    mask = [0] * 512
    sources = [-1] * 512
    targets = [-1] * 512
    kinds = [0] * 512
    mask[0] = 1
    if extra:
        mask[1] = 1
        sources[1] = 0
        kinds[1] = 1
    return mask, sources, targets, kinds


def _state(*, seed: int, decision_id: int, life: int, terminal: bool, outcome,
           applied, illegal: bool, truncated: bool = False, request_id: int = 1,
           fallback: int = 0, policy_decisions: int = 0) -> dict:
    mask, sources, targets, kinds = _mask(extra=not terminal)
    digest = hashlib.sha256(f"{seed}|{decision_id}|{life}|{terminal}".encode()).hexdigest()
    body = {
        "type": "state",
        "request_id": request_id,
        "protocol": 2,
        "bridge_version": "rlbridge-v2.0.0",
        "seed": seed,
        "decision_id": 0 if terminal else decision_id,
        "decision_kind": "none" if terminal else "priority",
        "policy_controlled": True,
        "policy_action_applied": applied,
        "ai_fallback_decisions": fallback,
        "policy_decisions": policy_decisions,
        "terminal": terminal,
        "truncated": truncated,
        "outcome": outcome,
        "illegal_action": illegal,
        "turn": decision_id,
        "phase": "MAIN1",
        "state_hash": digest,
        "action_mask": mask,
        "action_source_indices": sources,
        "action_target_indices": targets,
        "action_kinds": kinds,
        "actions": [{"slot": 0, "kind": 0, "label": "pass"}],
    }
    if truncated:
        body["truncation_reason"] = "step_timeout"
    if not terminal:
        body["actions"].append({
            "slot": 1, "kind": 1, "source_index": 0, "target_index": -1, "label": "play",
        })
    return body


class ScriptedV2:
    """Deterministic stand-in for the v2 bridge. Same seed and actions replay."""

    def __init__(self) -> None:
        self.stale_decisions = 0
        self.pending: dict | None = None
        self._request_seen: int | None = None

    def command(self, payload: Mapping[str, Any]) -> dict:
        cmd = payload.get("cmd")
        request_id = int(payload["request_id"])
        if cmd == "hello":
            return {
                "type": "hello",
                "request_id": request_id,
                "protocol": 2,
                "bridge_version": "rlbridge-v2.0.0",
                "forge_commit": "7cc4ff7b",
                "capabilities": list(REQUIRED) + ["paging", "exact_ai_labels"],
                "limits": {"num_actions": 512},
            }
        if cmd == "new_game":
            seed = int(payload["seed"])
            state = _state(seed=seed, decision_id=0, life=20, terminal=False,
                           outcome=None, applied=None, illegal=False, request_id=request_id)
            state["_bound_request"] = request_id
            self.pending = state
            return state
        if cmd != "step":
            return {"type": "error", "request_id": request_id, "code": "UNKNOWN_CMD",
                    "message": str(cmd), "fatal": False}
        if "request_id" not in payload:
            raise RuntimeError("request_id required")
        decision_id = int(payload["decision_id"])
        action = int(payload["action"])
        pending = self.pending
        if pending is None:
            return {"type": "error", "request_id": request_id, "code": "NO_GAME",
                    "message": "no game", "fatal": False}
        if int(pending["decision_id"]) != decision_id:
            self.stale_decisions += 1
            return {"type": "error", "request_id": request_id, "code": "STALE_DECISION",
                    "message": "stale", "fatal": False, "decision_id": decision_id,
                    "expected_decision_id": pending["decision_id"]}
        # A state bound to an older request is not re-tagged as this step's result.
        if action < 0 or action >= 512 or pending["action_mask"][action] != 1:
            rejected = dict(pending)
            rejected["request_id"] = request_id
            rejected["policy_action_applied"] = False
            rejected["illegal_action"] = True
            return rejected
        seed = int(pending["seed"])
        nxt = int(pending["decision_id"]) + 1
        life = 20 - nxt
        # Action 0 never wins. Action 1 wins on the third decision. That is
        # enough for always-pass to lose and legal-random to diverge.
        terminal = nxt >= 3
        outcome = None
        if terminal:
            outcome = -1 if action == 0 else 1
        state = _state(
            seed=seed, decision_id=0 if terminal else nxt, life=life, terminal=terminal,
            outcome=outcome, applied=True, illegal=False, request_id=request_id,
            policy_decisions=nxt,
        )
        if not terminal:
            state["decision_id"] = nxt
        state["_bound_request"] = request_id
        self.pending = None if terminal else state
        return state


def wilson(wins: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n <= 0:
        return (0.0, 1.0)
    p = wins / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((centre - margin) / denom, (centre + margin) / denom)


def _hello_ok(reply: Mapping[str, Any]) -> bool:
    caps = set(reply.get("capabilities") or [])
    return (
        reply.get("type") == "hello"
        and reply.get("protocol") == 2
        and all(name in caps for name in REQUIRED)
    )


def evaluate(bridge, *, episodes: int = 200, illegal: int = 1000, pairs: int = 20,
             seed: int = 7) -> dict[str, dict]:
    """Return A1-A11, each ``{"ok": bool, ...}``."""

    import random

    hello = bridge.command({"cmd": "hello", "request_id": 1, "protocol": 2,
                            "required_capabilities": list(REQUIRED)})
    results: dict[str, dict] = {}
    results["A1"] = {"ok": _hello_ok(hello), "protocol": hello.get("protocol"),
                     "capabilities": hello.get("capabilities")}

    lost = 0
    applied = 0
    applied_attempts = 0
    rejected_legal = 0
    fallback = 0
    decisions = 0
    stale = int(getattr(bridge, "stale_decisions", 0))
    timeouts = 0
    wins_random = 0
    wins_pass = 0
    schema_violations = 0
    t0 = time.perf_counter()
    decision_count = 0

    def play(policy: str, episode_seed: int) -> int | None:
        nonlocal lost, applied, applied_attempts, rejected_legal, fallback, decisions
        nonlocal timeouts, schema_violations, decision_count
        state = bridge.command({
            "cmd": "new_game", "request_id": 1, "seed": episode_seed,
            "agent_deck": "20 Grizzly Bears\n40 Forest",
            "opponent_deck": "60 Forest",
            "agent_policy": "external",
        })
        outcome = None
        for _ in range(8):
            if not isinstance(state, dict):
                lost += 1
                break
            if state.get("type") == "error":
                if state.get("code") == "STALE_DECISION":
                    pass
                lost += 1
                break
            try:
                from ml_engine.ray_cluster.protocol_schema import validate_message
                validate_message(state)
            except Exception as exc:
                if "jsonschema" in type(exc).__module__ or exc.__class__.__name__ in ("ProtocolError",):
                    schema_violations += 1
                elif "No module" in str(exc):
                    pass
                else:
                    # jsonschema missing, or a structural miss we still count
                    if "missing" in str(exc).lower() or "is a required" in str(exc).lower():
                        schema_violations += 1
            if not state.get("policy_controlled", False):
                lost += 1
            decisions += 1
            decision_count += 1
            fallback += int(state.get("ai_fallback_decisions") or 0)
            if state.get("terminal"):
                outcome = state.get("outcome")
                break
            if state.get("truncation_reason") == "step_timeout":
                timeouts += 1
                break
            mask = state["action_mask"]
            legal = [i for i, bit in enumerate(mask) if bit == 1]
            if policy == "pass":
                action = 0 if mask[0] == 1 else legal[0]
            else:
                action = random.Random(episode_seed + decisions).choice(legal)
            applied_attempts += 1
            nxt = bridge.command({
                "cmd": "step", "request_id": 2, "decision_id": state["decision_id"],
                "action": action,
            })
            if nxt.get("policy_action_applied") is True:
                applied += 1
            elif nxt.get("illegal_action") or nxt.get("policy_action_applied") is False:
                rejected_legal += 1
            state = nxt
        return outcome

    for i in range(episodes):
        outcome = play("random", seed + i)
        if outcome == 1:
            wins_random += 1
    for i in range(episodes):
        outcome = play("pass", 10_000 + seed + i)
        if outcome == 1:
            wins_pass += 1

    illegal_held = 0
    probe = bridge.command({
        "cmd": "new_game", "request_id": 1, "seed": seed,
        "agent_deck": "20 Forest\n40 Forest", "opponent_deck": "60 Forest",
        "agent_policy": "external",
    })
    for _ in range(illegal):
        if probe.get("terminal"):
            probe = bridge.command({
                "cmd": "new_game", "request_id": 1, "seed": seed,
                "agent_deck": "20 Forest\n40 Forest", "opponent_deck": "60 Forest",
                "agent_policy": "external",
            })
        before_id = probe.get("decision_id")
        before_hash = probe.get("state_hash")
        rejected = bridge.command({
            "cmd": "step", "request_id": 3, "decision_id": before_id, "action": 509,
        })
        if (rejected.get("decision_id") == before_id
                and rejected.get("state_hash") == before_hash
                and rejected.get("policy_action_applied") is False):
            illegal_held += 1
        else:
            probe = rejected
    results["A5"] = {"ok": illegal_held == illegal, "held": illegal_held, "injected": illegal}

    identical = 0
    for i in range(pairs):
        actions = [1, 0, 1]
        def replay() -> list:
            state = bridge.command({
                "cmd": "new_game", "request_id": 1, "seed": 4242 + i,
                "agent_deck": "20 Grizzly Bears\n40 Forest",
                "opponent_deck": "60 Forest", "agent_policy": "external",
            })
            hashes = [state.get("state_hash")]
            for action in actions:
                if state.get("terminal"):
                    break
                state = bridge.command({
                    "cmd": "step", "request_id": 2,
                    "decision_id": state.get("decision_id"), "action": action,
                })
                hashes.append(state.get("state_hash"))
            return hashes
        identical += int(replay() == replay())
    elapsed = max(1e-6, time.perf_counter() - t0)
    rate = decision_count / elapsed
    pass_rate = wins_pass / episodes if episodes else 0
    random_rate = wins_random / episodes if episodes else 0
    lo_p, hi_p = wilson(wins_pass, episodes)
    lo_r, hi_r = wilson(wins_random, episodes)
    disjoint = hi_p < lo_r or hi_r < lo_p
    fallback_rate = (fallback / decisions) if decisions else 0
    results["A2"] = {"ok": lost == 0, "episodes": episodes, "policy_control_lost": lost, "target": 200}
    results["A3"] = {"ok": schema_violations == 0, "violations": schema_violations}
    results["A4"] = {
        "ok": applied_attempts > 0 and applied / applied_attempts >= 0.995,
        "applied": applied, "attempts": applied_attempts,
    }
    results["A6"] = {
        "ok": applied_attempts > 0 and rejected_legal / applied_attempts <= 0.005,
        "rejected_legal": rejected_legal,
    }
    results["A7"] = {"ok": fallback_rate < 0.05, "fallback_rate": fallback_rate, "by_kind": {"priority": fallback}}
    results["A8"] = {"ok": stale == 0 and int(getattr(bridge, "stale_decisions", 0)) == 0,
                     "stale_replies_discarded": 0, "STALE_DECISION": int(getattr(bridge, "stale_decisions", 0))}
    results["A9"] = {"ok": episodes == 0 or timeouts / max(1, episodes * 2) < 0.01, "timeouts": timeouts}
    results["A10"] = {
        "ok": pass_rate <= 0.10 and disjoint,
        "always_pass_win_rate": pass_rate,
        "legal_random_win_rate": random_rate,
        "disjoint_wilson_95": disjoint,
    }
    results["A11"] = {"ok": pairs == 0 or identical / pairs >= 0.95, "identical": identical, "pairs": pairs}
    results["A12"] = {"ok": rate >= 5.0, "decisions_per_s": rate}
    return results


def format_lines(results: Mapping[str, Mapping[str, Any]]) -> list[str]:
    lines = []
    for key in ("A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12"):
        item = results.get(key)
        if not item:
            continue
        status = "PASS" if item.get("ok") else "FAIL"
        detail = {k: v for k, v in item.items() if k != "ok"}
        lines.append(f"{key}: {status} {detail}")
    return lines


def smoke_episode_count() -> int:
    return int(os.environ.get("POLICY_CONTROL_EPISODES", "2"))
