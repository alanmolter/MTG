"""The Forge discrete action mask is a complete, fail-closed contract.

The bridge's autoregressive endpoint currently supports only pass.  Training
must reject that action space until conditional legal masks exist there.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List

import numpy as np
import pytest

from ml_engine.ray_cluster.env import (
    MtgForgeEnv,
    ProtocolError,
    java_step_timeout_seconds,
    seed_everything,
)


# ── Fakes ────────────────────────────────────────────────────────────────────

class _FakeStdin:
    def __init__(self) -> None:
        self.written: List[str] = []
    def write(self, s: str) -> None: self.written.append(s)
    def flush(self) -> None: pass


def _hello_response(request_id: Any) -> Dict[str, Any]:
    return {
        "type": "hello",
        "request_id": request_id,
        "protocol": 2,
        "bridge_version": "rlbridge-v2.0.0",
        "forge_commit": "7cc4ff7b",
        "capabilities": ["policy_control", "seed", "legal_mask", "decision_points"],
    }


class _FakeStdout:
    """One reply per command.

    The env pumps stdout on a daemon thread, so a reply must not be produced
    until the command it belongs to has been written. Otherwise the pump
    pulls the next game state while ``hello`` is still the last command and
    the state is tagged with the wrong request id.
    """

    def __init__(self, responses: List[Dict[str, Any]], stdin: _FakeStdin | None = None,
                 inject_request_id: bool = True) -> None:
        self.queue: List[str] = [json.dumps(r) + "\n" for r in responses]
        self.stdin = stdin
        self.inject_request_id = inject_request_id
        self._answered = 0

    def readline(self) -> str:
        import time

        if self.stdin is not None and self.stdin.written:
            deadline = time.monotonic() + 2.0
            while len(self.stdin.written) <= self._answered:
                if time.monotonic() > deadline:
                    return ""
                time.sleep(0.001)
            command = json.loads(self.stdin.written[self._answered])
            self._answered += 1
            if command.get("cmd") == "hello":
                return json.dumps(_hello_response(command.get("request_id"))) + "\n"
            return self._pop(command if self.inject_request_id else None)
        return self._pop(None)

    def _pop(self, command: Dict[str, Any] | None) -> str:
        if not self.queue:
            return ""
        raw = self.queue.pop(0)
        if command is None or "request_id" not in command:
            return raw
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return raw
        if isinstance(payload, dict) and "request_id" not in payload:
            payload["request_id"] = command["request_id"]
            return json.dumps(payload) + "\n"
        return raw


class _FakeProc:
    def __init__(self, responses: List[Dict[str, Any]], inject_request_id: bool = True) -> None:
        self.stdin = _FakeStdin()
        self.stdout = _FakeStdout(responses, self.stdin, inject_request_id)
    def poll(self) -> Any: return None  # alive


def _minimal_state(**overrides) -> Dict[str, Any]:
    s: Dict[str, Any] = {
        "terminal": False, "outcome": None, "illegal_action": False,
        "policy_controlled": True,
        "policy_action_applied": True,
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
        "action_mask": [1] + [0] * 511,
        "action_source_indices": [-1] * 512,
        "action_target_indices": [-1] * 512,
        "action_kinds": [0] * 512,
    }
    s.update(overrides)
    return s


def _make_env(*, autoregressive: bool = False) -> MtgForgeEnv:
    """Build an env without spawning a Forge subprocess. Tests inject
    their own _FakeProc directly onto env._proc."""
    env = MtgForgeEnv(config={
        "use_autoregressive_actions": autoregressive,
        # Supply stub paths so __init__ doesn't reach the filesystem check
        # (that only runs inside _ensure_subprocess which we bypass).
        "forge_jar":  "stub",
        "bridge_jar": "stub",
        "strict_protocol": False,
    })
    # Pre-populate last_snapshot so shape() delta maths doesn't crash
    env._last_snapshot = env._state_to_snapshot(_minimal_state())
    return env


# ── Tests ────────────────────────────────────────────────────────────────────

def test_autoregressive_configuration_is_rejected_until_masked_by_bridge():
    with pytest.raises(ValueError, match="autoregressive.*legal mask"):
        _make_env(autoregressive=True)


def test_discrete_payload_and_pass_classification():
    env = _make_env()
    env._proc = _FakeProc([_minimal_state(turn=2)])

    env.step(0)
    payload = json.loads(env._proc.stdin.written[0])
    assert payload["cmd"]    == "step"
    assert payload["action"] == 0
    assert env.loop_guard._loop_state.action_history[-1]["type"] == "pass"
    # AR fields must not leak into legacy path
    for k in ("action_base", "source_id", "target_id"):
        assert k not in payload


@pytest.mark.parametrize("page_action", [510, 511])
def test_page_navigation_is_not_meaningful_loop_action(page_action):
    env = _make_env()
    env._proc = _FakeProc([_minimal_state(turn=2)])
    env.step(page_action)
    assert env.loop_guard._loop_state.action_history[-1]["type"] == "noop"


def test_illegal_action_flag_from_bridge_is_respected():
    """If the Java bridge emits illegal_action=true (e.g. fail-safe for an
    out-of-range triple), the Python shaper must receive it and produce a
    negative reward."""
    env = _make_env()
    env._proc = _FakeProc([_minimal_state(turn=2, illegal_action=True)])

    _, reward, _, _, info = env.step(0)
    # illegal_action in state → shaper applies penalty_illegal_action (negative)
    assert info["state"]["illegal_action"] is True
    assert reward <= 0.0


def test_policy_control_loss_truncates_without_a_loss_penalty():
    env = _make_env()
    env._proc = _FakeProc([_minimal_state(turn=2, policy_controlled=False)])

    _, reward, terminated, truncated, info = env.step(0)

    assert terminated is False
    assert truncated is True
    assert reward == 0.0
    assert info["error"] == "forge_policy_control_lost"
    assert info["episode_metrics"]["win"] is None


def test_repeated_illegal_action_ends_the_episode():
    env = _make_env()
    stuck = _minimal_state(
        decision_id=0,
        illegal_action=True,
        policy_action_applied=False,
    )
    env._proc = _FakeProc([stuck] * 8)
    terminated = False
    for _ in range(8):
        _, _, terminated, _, info = env.step(0)
    assert terminated is True
    assert info["state"]["_illegal_cap"] is True
    written = len(env._proc.stdin.written)
    _, _, terminated_again, _, info_again = env.step(0)
    assert terminated_again is True
    assert info_again["error"] == "illegal_action_cap"
    assert len(env._proc.stdin.written) == written


def test_unapplied_policy_action_is_penalized():
    env = _make_env()
    env._proc = _FakeProc([_minimal_state(turn=2, policy_action_applied=False)])

    _, reward, _, _, info = env.step(0)

    assert info["state"]["illegal_action"] is True
    assert reward <= 0.0


def test_discrete_observation_links_action_to_visible_card_identity():
    """The same slot can name different hand cards across different states."""
    env = _make_env()
    card_a = {
        "name": "Lightning Bolt", "oracle_text": "Deal 3 damage to any target.",
        "zone": "hand", "is_instant": True,
    }
    card_b = {
        "name": "Island", "oracle_text": "Tap: Add blue mana.",
        "zone": "hand", "is_land": True,
    }
    first_state = _minimal_state(
        cards=[card_a, card_b],
        action_mask=[1, 1] + [0] * 510,
        action_source_indices=[-1, 0] + [-1] * 510,
        action_target_indices=[-1] * 512,
        action_kinds=[0, 1] + [0] * 510,
    )
    second_state = _minimal_state(
        cards=[card_a, card_b],
        action_mask=[1, 1] + [0] * 510,
        action_source_indices=[-1, 1] + [-1] * 510,
        action_target_indices=[-1] * 512,
        action_kinds=[0, 1] + [0] * 510,
    )

    first = env._encode_observation(first_state)
    second = env._encode_observation(second_state)

    assert first["action_source_indices"][1] == 0
    assert second["action_source_indices"][1] == 1
    assert first["action_kinds"][1] == 1
    assert not np.array_equal(first["card_feats"][0, 13:], first["card_feats"][1, 13:])
    assert env.observation_space.contains(first)


@pytest.mark.parametrize(
    "field",
    ["action_mask", "action_source_indices", "action_target_indices", "action_kinds"],
)
def test_active_policy_state_rejects_missing_action_contract(field):
    env = _make_env()
    state = _minimal_state()
    state.pop(field)
    with pytest.raises(ValueError, match=field):
        env._encode_observation(state)


@pytest.mark.parametrize(
    "field",
    ["action_mask", "action_source_indices", "action_target_indices", "action_kinds"],
)
@pytest.mark.parametrize("length", [0, 511, 513])
def test_active_policy_state_rejects_wrong_length_action_contract(field, length):
    env = _make_env()
    state = _minimal_state()
    state[field] = state[field][:length] if length <= 512 else state[field] + [0]
    with pytest.raises(ValueError, match=field):
        env._encode_observation(state)


def _state_with_legal_action(kind: int, source: int, target: int, slot: int = 1):
    state = _minimal_state(cards=[{"name": "Grizzly Bears"}])
    state["action_mask"][slot] = 1
    state["action_source_indices"][slot] = source
    state["action_target_indices"][slot] = target
    state["action_kinds"][slot] = kind
    return state


@pytest.mark.parametrize("kind", [1, 2, 3, 4, 5])
def test_legal_non_page_action_requires_visible_source(kind):
    env = _make_env()
    state = _state_with_legal_action(kind, -1, -3)
    with pytest.raises(ValueError, match="source"):
        env._encode_observation(state)


def test_legal_source_beyond_truncated_card_observation_is_rejected():
    env = _make_env()
    state = _state_with_legal_action(1, 128, -1)
    state["cards"] = [{"name": "Forest"} for _ in range(129)]
    with pytest.raises(ValueError, match="source"):
        env._encode_observation(state)


@pytest.mark.parametrize("kind", [2, 3, 4])
def test_targeted_action_requires_visible_target_or_player(kind):
    env = _make_env()
    state = _state_with_legal_action(kind, 0, -1)
    with pytest.raises(ValueError, match="target"):
        env._encode_observation(state)


@pytest.mark.parametrize("kind,target", [(2, -3), (3, 0), (4, -2), (4, -3)])
def test_targeted_actions_accept_card_or_player_indices(kind, target):
    env = _make_env()
    state = _state_with_legal_action(kind, 0, target)
    assert env.observation_space.contains(env._encode_observation(state))


@pytest.mark.parametrize("kind", [-1, 8, 10])
def test_active_policy_state_rejects_invalid_action_kind(kind):
    env = _make_env()
    state = _state_with_legal_action(kind, 0, -1)
    with pytest.raises(ValueError, match="kind"):
        env._encode_observation(state)


@pytest.mark.parametrize("page_slot,page_kind", [(510, 6), (511, 7)])
def test_legal_page_actions_have_distinct_kinds(page_slot, page_kind):
    env = _make_env()
    state = _minimal_state()
    state["action_mask"][page_slot] = 1
    state["action_kinds"][page_slot] = page_kind
    observation = env._encode_observation(state)
    assert observation["action_kinds"][page_slot] == page_kind
    state["action_kinds"][page_slot] = 0
    with pytest.raises(ValueError, match="page"):
        env._encode_observation(state)


def test_active_state_without_any_legal_action_is_rejected():
    env = _make_env()
    state = _minimal_state(action_mask=[0] * 512)
    with pytest.raises(ValueError, match="legal action"):
        env._encode_observation(state)


def test_action_mask_values_are_binary():
    env = _make_env()
    state = _minimal_state()
    state["action_mask"][1] = 2
    with pytest.raises(ValueError, match="action_mask"):
        env._encode_observation(state)


def test_terminal_and_dummy_observations_have_no_legal_actions():
    env = _make_env()
    state = _minimal_state(terminal=True)
    state.pop("action_mask")
    state.pop("action_source_indices")
    state.pop("action_target_indices")
    state.pop("action_kinds")
    terminal_obs = env._encode_observation(state)
    dummy_obs = env._dummy_obs()
    assert not terminal_obs["action_mask"].any()
    assert not dummy_obs["action_mask"].any()
    assert env.observation_space.contains(terminal_obs)
    assert env.observation_space.contains(dummy_obs)


def test_action_descriptors_are_deterministic_and_distinguish_same_source_options():
    env = _make_env()
    state = _state_with_legal_action(5, 0, -1)
    state["action_mask"][2] = 1
    state["action_source_indices"][2] = 0
    state["action_kinds"][2] = 5
    state["action_descriptors"] = {
        "1": "Tap: Deal 1 damage to any target.",
        "2": "Pay two mana: Draw a card.",
    }
    first = env._encode_observation(state)
    second = env._encode_observation(state)
    assert np.array_equal(
        first["action_descriptor_features"], second["action_descriptor_features"]
    )
    assert np.linalg.norm(first["action_descriptor_features"][1]) > 0
    assert not np.array_equal(
        first["action_descriptor_features"][1],
        first["action_descriptor_features"][2],
    )
    assert not first["action_descriptor_features"][3].any()
    assert env.observation_space.contains(first)


def test_invalid_or_masked_off_action_descriptor_is_rejected():
    env = _make_env()
    state = _minimal_state(action_descriptors={"1": "not a legal slot"})
    with pytest.raises(ValueError, match="action_descriptors"):
        env._encode_observation(state)


def test_card_controller_zone_and_combat_state_are_visible():
    env = _make_env()
    state = _minimal_state(cards=[
        {"name": "Bear", "controller": "you", "zone": "battlefield", "is_attacking": True},
        {"name": "Bolt", "controller": "opp", "zone": "graveyard"},
        {"name": "Relic", "controller": "opp", "zone": "exile"},
        {"name": "Spell", "controller": "you", "zone": "stack"},
    ])
    observation = env._encode_observation(state)
    cards = observation["card_feats"]
    assert cards.shape == (env.max_cards, 400)
    assert cards[0, 395] == 1 and cards[0, 399] == 1
    assert cards[1, 395] == 0 and cards[1, 396] == 1
    assert cards[2, 397] == 1 and cards[3, 398] == 1


def test_read_state_times_out_while_stdout_blocks():
    import subprocess
    import threading

    class _BlockingStdout:
        def __init__(self) -> None:
            self.release = threading.Event()

        def readline(self) -> str:
            self.release.wait(timeout=5)
            return ""

    env = _make_env()
    env.step_timeout = 0.2
    stdout = _BlockingStdout()
    env._proc = _FakeProc([])
    env._proc.stdout = stdout
    try:
        with pytest.raises(subprocess.TimeoutExpired):
            env._read_state()
    finally:
        stdout.release.set()


def test_timeout_and_dead_process_are_truncations_not_losses():
    import threading

    class _BlockingStdout:
        def __init__(self) -> None:
            self.release = threading.Event()

        def readline(self) -> str:
            self.release.wait(timeout=5)
            return ""

    class _DeadProc(_FakeProc):
        def poll(self):
            return 1

    env = _make_env()
    env.step_timeout = 0.2
    stdout = _BlockingStdout()
    env._proc = _FakeProc([])
    env._proc.stdout = stdout
    try:
        _, reward, terminated, truncated, info = env.step(0)
    finally:
        stdout.release.set()
    assert terminated is False
    assert truncated is True
    assert reward == 0.0
    assert info["error"] == "forge_step_timeout"
    assert info["episode_metrics"]["win"] is None
    assert env.shaper._episode_shape_total == 0.0

    env = _make_env()
    env.shaper._episode_shape_total = 0.4
    env._proc = _DeadProc([])
    _, reward, terminated, truncated, info = env.step(0)
    assert terminated is False and truncated is True
    assert reward == 0.0
    assert info["error"] == "forge_subprocess_dead"
    assert env.shaper._episode_shape_total == 0.0


def test_reset_clears_shaping_budget_and_records_seed(monkeypatch):
    env = _make_env()
    env.shaper._episode_shape_total = 0.5
    env.agent_deck = "4 Lightning Bolt\n56 Mountain"
    env.opponent_deck = "4 Counterspell\n56 Island"
    env._proc = _FakeProc([_minimal_state()])
    monkeypatch.setattr(env, "_ensure_subprocess", lambda: None)

    _obs, info = env.reset(seed=11)

    assert env.shaper._episode_shape_total == 0.0
    assert info["seed"] == 11
    assert info["agent_deck_sha256"]
    assert info["agent_deck_id"] == ""
    assert env._episode_seed == 11


def test_episode_log_names_the_pool_deck(monkeypatch):
    from ml_engine.ray_cluster.deck_pool import deck_by_archetype_id

    deck = deck_by_archetype_id("aggro_red")
    env = _make_env()
    env.agent_deck = deck.forge_list
    env.opponent_deck = deck_by_archetype_id("control_uw").forge_list
    env._proc = _FakeProc([
        _minimal_state(),
        _minimal_state(terminal=True, outcome=1, turn=4),
    ])
    monkeypatch.setattr(env, "_ensure_subprocess", lambda: None)
    env.reset(seed=5)
    _, _, terminated, _, info = env.step(0)
    metrics = info["episode_metrics"]
    assert terminated is True
    assert metrics["agent_deck_id"] == "q06_mono_red_burn"
    assert metrics["opponent_deck_id"] == "q05_azorius_control"
    assert metrics["agent_deck_sha256"] == deck.sha256


def test_arena_reset_updates_archetype_name(monkeypatch):
    env = _make_env()
    env.arena_only = True
    env.archetype = "aggro"
    env._proc = _FakeProc([_minimal_state()])
    monkeypatch.setattr(env, "_ensure_subprocess", lambda: None)

    def _matchup(**_kwargs):
        return "4 Island\n56 Island", "4 Mountain\n56 Mountain", "control_uw", "aggro_red"

    monkeypatch.setattr(
        "ml_engine.ray_cluster.arena_pool.resolve_training_matchup",
        _matchup,
    )
    env.reset(seed=3)
    assert env.archetype == "control_uw"


def test_turn_limit_truncates_and_does_not_leak_shaping_budget():
    env = _make_env()
    env.turn_limit = 2
    env.shaper._episode_shape_total = env.shaper.config.episode_shape_cap
    env._proc = _FakeProc([_minimal_state(turn=2)])

    _, _reward, terminated, truncated, info = env.step(0)

    assert terminated is False
    assert truncated is True
    assert env.shaper._episode_shape_total == 0.0
    assert info["episode_metrics"]["truncated"] == 1.0
    assert info["episode_metrics"]["win"] is None
    assert "seed" in info["episode_metrics"]


def test_terminal_win_logs_decisive_metrics():
    env = _make_env()
    env._begin_episode_tracking(9)
    env._proc = _FakeProc([_minimal_state(terminal=True, outcome=1, turn=6, lands_you=3)])

    _, reward, terminated, truncated, info = env.step(0)

    assert terminated is True and truncated is False
    assert reward > 0.5
    metrics = info["episode_metrics"]
    assert metrics["win"] == 1.0
    assert metrics["passes"] == 1.0
    assert metrics["seed"] == 9
    assert metrics["steps"] == 1.0
    assert metrics["agent_deck_id"] == ""
    assert "agent_deck_sha256" in metrics


def test_edge_padding_uses_sentinel_and_keeps_card_zero():
    env = _make_env()
    state = _minimal_state(controlled_by_edges=[[0, 0], [1, 0]])
    observation = env._encode_observation(state)
    edges = observation["controlled_by_edges"]
    assert edges[0, 0] == 0 and edges[1, 0] == 0
    assert edges[0, 1] == 1 and edges[1, 1] == 0
    assert edges[0, 2] == -1 and edges[1, 2] == -1
    assert env.observation_space.contains(observation)


def test_life_library_and_turn_are_scaled_next_to_binary_flags():
    env = _make_env()
    state = _minimal_state(cards=[{"name": "Bear", "mana_value": 10, "power": 2, "is_creature": True}])
    state["you"]["life"] = 20
    state["you"]["library_size"] = 30
    state["turn"] = 20
    observation = env._encode_observation(state)
    players = observation["player_feats"]
    assert players[0, 0] == pytest.approx(1.0)       # life / 20
    assert players[0, 9] == pytest.approx(0.5)       # library / 60
    assert players[0, 12] == pytest.approx(1.0)      # turn / 20
    assert players[0, 13] == pytest.approx(1.0)      # is_active stays binary
    assert players[0, 14] == pytest.approx(1.0)      # is_you stays binary
    assert observation["card_feats"][0, 0] == pytest.approx(1.0)  # mana value / 10
    assert observation["card_feats"][0, 1] == pytest.approx(0.2)  # power / 10
    assert observation["card_feats"][0, 4] == pytest.approx(1.0)  # creature flag


def test_java_timeout_stays_below_python_and_stale_replies_are_dropped():
    assert java_step_timeout_seconds(12.0) == 8
    assert java_step_timeout_seconds(12.0, 20) == 11
    assert java_step_timeout_seconds(12.0, 7) == 7

    responses = []
    for request_id in range(1, 1001):
        responses.append({"request_id": request_id - 1, "turn": -1, "terminal": False})
        responses.append(_minimal_state(request_id=request_id, turn=request_id))
    env = _make_env()
    env._proc = _FakeProc(responses)
    for request_id in range(1, 1001):
        env._pending_request_id = request_id
        state = env._read_state(timeout_override=2.0)
        assert state["turn"] == request_id
    assert env.stale_replies_discarded == 1000


def test_bridge_step_timeout_flag_is_an_infra_stop():
    env = _make_env()
    env._proc = _FakeProc([{
        "truncated": True,
        "truncation_reason": "step_timeout",
        "turn": 3,
        "terminal": False,
    }])
    _obs, reward, terminated, truncated, info = env.step(0)
    assert terminated is False
    assert truncated is True
    assert reward == 0.0
    assert info["error"] == "forge_step_timeout"


def test_malformed_active_response_kills_forge_worker():
    env = _make_env()
    state = _minimal_state(turn=2)
    state.pop("action_mask")
    env._proc = _FakeProc([state])
    with pytest.raises(ValueError, match="action_mask"):
        env.step(0)
    assert env._proc is None


def test_response_without_request_id_is_a_protocol_error():
    env = _make_env()
    env._proc = _FakeProc([_minimal_state(turn=2)], inject_request_id=False)
    env._pending_request_id = 1
    with pytest.raises(ProtocolError, match="request_id"):
        env._read_state(timeout_override=1.0)


def test_reset_handshake_and_decision_id_are_sent(monkeypatch):
    env = _make_env()
    env.agent_deck = "4 Lightning Bolt\n56 Mountain"
    env.opponent_deck = "4 Counterspell\n56 Island"
    env._proc = _FakeProc([
        _minimal_state(decision_id=0, turn=1),
        _minimal_state(decision_id=1, turn=1),
    ])
    monkeypatch.setattr(env, "_ensure_subprocess", lambda: None)
    env.reset(seed=11)
    commands = [json.loads(line) for line in env._proc.stdin.written]
    assert commands[0]["cmd"] == "hello"
    assert commands[0]["protocol"] == 2
    assert commands[1]["cmd"] == "new_game"
    assert commands[1]["seed"] == 11
    env.step(0)
    step = json.loads(env._proc.stdin.written[-1])
    assert step["decision_id"] == 0
    assert step["action"] == 0


def test_seed_everything_replays_numpy_and_torch():
    import numpy as np
    import torch

    seed_everything(123456)
    a = np.random.randint(0, 10_000, size=4)
    t = torch.randint(0, 10_000, (4,))
    seed_everything(123456)
    b = np.random.randint(0, 10_000, size=4)
    u = torch.randint(0, 10_000, (4,))
    assert np.array_equal(a, b)
    assert torch.equal(t, u)
