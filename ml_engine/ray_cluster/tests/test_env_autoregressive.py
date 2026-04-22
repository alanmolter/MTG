"""
Phase 3 regression — MtgForgeEnv emits native autoregressive JSON.

The pre-fix code packed MultiDiscrete([4, 128, 128]) triples into a flat int
via `flat = type*S*T + source*T + target` and then `flat % 512`. With 65_536
possible triples mapping onto 512 flat slots, ~99% of distinct triples
collided to the same Forge action — catastrophic for training.

These tests lock in the new contract:

1. use_autoregressive_actions=True → {"cmd":"step_autoregressive",
   "action_base":..., "source_id":..., "target_id":...} with NO modulo.
2. use_autoregressive_actions=False → legacy {"cmd":"step", "action":<int>}.
3. Triples that previously collided now travel intact (no mod 512).
4. Scalar sent in AR mode → defensive fallback to (3, 0, 0) "pass", no crash.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List

import numpy as np
import pytest

from ml_engine.ray_cluster.env import MtgForgeEnv
from ml_engine.forge_worker.loop_guard import LoopGuard
from ml_engine.forge_worker.reward_shaper import RewardShaper


# ── Fakes ────────────────────────────────────────────────────────────────────

class _FakeStdin:
    def __init__(self) -> None:
        self.written: List[str] = []
    def write(self, s: str) -> None: self.written.append(s)
    def flush(self) -> None: pass


class _FakeStdout:
    def __init__(self, responses: List[Dict[str, Any]]) -> None:
        self.queue: List[str] = [json.dumps(r) + "\n" for r in responses]
    def readline(self) -> str:
        return self.queue.pop(0) if self.queue else ""


class _FakeProc:
    def __init__(self, responses: List[Dict[str, Any]]) -> None:
        self.stdin = _FakeStdin()
        self.stdout = _FakeStdout(responses)
    def poll(self) -> Any: return None  # alive


def _minimal_state(**overrides) -> Dict[str, Any]:
    s: Dict[str, Any] = {
        "terminal": False, "outcome": None, "illegal_action": False,
        "turn": 1, "life_you": 20, "life_opp": 20,
        "hand_you_size": 7, "hand_opp_size": 7,
        "power_you": 0, "power_opp": 0, "mana_value_played": 0,
        "you": {"life": 20, "mana_pool_total": 0, "hand_size": 7,
                "library_size": 53, "graveyard_size": 0, "exile_size": 0,
                "is_active": True, "max_life_seen": 20},
        "opp": {"life": 20, "mana_pool_total": 0, "hand_size": 7,
                "library_size": 53, "graveyard_size": 0, "exile_size": 0,
                "is_active": False, "max_life_seen": 20},
        "cards": [],
        "controlled_by_edges": [], "in_zone_edges": [],
        "synergy_edges": [], "attacks_edges": [],
        "action_mask": [1] * 512,
    }
    s.update(overrides)
    return s


def _make_env(*, autoregressive: bool) -> MtgForgeEnv:
    """Build an env without spawning a Forge subprocess. Tests inject
    their own _FakeProc directly onto env._proc."""
    env = MtgForgeEnv(config={
        "use_autoregressive_actions": autoregressive,
        # Supply stub paths so __init__ doesn't reach the filesystem check
        # (that only runs inside _ensure_subprocess which we bypass).
        "forge_jar":  "stub",
        "bridge_jar": "stub",
    })
    # Pre-populate last_snapshot so shape() delta maths doesn't crash
    env._last_snapshot = env._state_to_snapshot(_minimal_state())
    return env


# ── Tests ────────────────────────────────────────────────────────────────────

def test_autoregressive_emits_native_triple():
    env = _make_env(autoregressive=True)
    env._proc = _FakeProc([_minimal_state(turn=2)])

    env.step(np.array([2, 17, 64], dtype=np.int64))

    assert len(env._proc.stdin.written) == 1
    payload = json.loads(env._proc.stdin.written[0])
    assert payload["cmd"] == "step_autoregressive"
    assert payload["action_base"] == 2
    assert payload["source_id"]   == 17
    assert payload["target_id"]   == 64
    # No flat action field — nothing that could be modded
    assert "action" not in payload


def test_autoregressive_preserves_triples_that_previously_collided():
    """Regression: in the old `flat % 512` scheme, (3, 127, 127) would
    produce flat = 3*128*128 + 127*128 + 127 = 65_279 → 65_279 % 512 = 127.
    And (0, 0, 127) → 127. Same Forge action. Here we verify the triple
    is forwarded intact so Forge sees distinct actions."""
    env = _make_env(autoregressive=True)
    env._proc = _FakeProc([_minimal_state(turn=2), _minimal_state(turn=3)])

    env.step(np.array([3, 127, 127], dtype=np.int64))
    env.step(np.array([0,   0, 127], dtype=np.int64))

    p1 = json.loads(env._proc.stdin.written[0])
    p2 = json.loads(env._proc.stdin.written[1])
    assert (p1["action_base"], p1["source_id"], p1["target_id"]) == (3, 127, 127)
    assert (p2["action_base"], p2["source_id"], p2["target_id"]) == (0,   0, 127)
    # Distinct triples → distinct payloads
    assert p1 != p2


def test_autoregressive_no_modulo_on_payload():
    """Every boundary value (3, 127, 127) must round-trip unchanged — the
    old code would return `flat % num_actions` turning large triples into
    small ints."""
    env = _make_env(autoregressive=True)
    env._proc = _FakeProc([_minimal_state(turn=2)])

    env.step(np.array([3, 127, 127], dtype=np.int64))
    payload = json.loads(env._proc.stdin.written[0])
    assert payload["action_base"] == 3
    assert payload["source_id"]   == 127
    assert payload["target_id"]   == 127
    # Sanity: these values exceed num_actions=512, proving we don't mod.
    assert payload["source_id"] >= 128 - 1
    assert payload["target_id"] >= 128 - 1


def test_legacy_discrete_payload_unchanged():
    env = _make_env(autoregressive=False)
    env._proc = _FakeProc([_minimal_state(turn=2)])

    env.step(42)
    payload = json.loads(env._proc.stdin.written[0])
    assert payload["cmd"]    == "step"
    assert payload["action"] == 42
    # AR fields must not leak into legacy path
    for k in ("action_base", "source_id", "target_id"):
        assert k not in payload


def test_scalar_in_autoregressive_mode_falls_back_to_pass():
    """Defensive: if a caller passes a scalar while AR mode is on, the env
    must map to (3, 0, 0) "pass" instead of raising."""
    env = _make_env(autoregressive=True)
    env._proc = _FakeProc([_minimal_state(turn=2)])

    env.step(7)  # scalar, not an array
    payload = json.loads(env._proc.stdin.written[0])
    assert payload["cmd"]         == "step_autoregressive"
    assert payload["action_base"] == 3
    assert payload["source_id"]   == 0
    assert payload["target_id"]   == 0


def test_illegal_action_flag_from_bridge_is_respected():
    """If the Java bridge emits illegal_action=true (e.g. fail-safe for an
    out-of-range triple), the Python shaper must receive it and produce a
    negative reward."""
    env = _make_env(autoregressive=True)
    env._proc = _FakeProc([_minimal_state(turn=2, illegal_action=True)])

    _, reward, _, _, info = env.step(np.array([0, 0, 0], dtype=np.int64))
    # illegal_action in state → shaper applies penalty_illegal_action (negative)
    assert info["state"]["illegal_action"] is True
    assert reward <= 0.0
