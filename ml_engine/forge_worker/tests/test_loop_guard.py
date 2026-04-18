"""Unit tests for Pillar 7 — LoopGuard."""

import pytest

from ml_engine.forge_worker.loop_guard import (
    LoopGuard,
    LoopGuardConfig,
    ToxicAction,
    canonical_state_hash,
)


def _state(life_you=20, life_opp=20, phase="main", bf_you=None, bf_opp=None, turn=1):
    return {
        "turn": turn,
        "turn_phase": phase,
        "life_you": life_you,
        "life_opp": life_opp,
        "battlefield_you": bf_you or [],
        "battlefield_opp": bf_opp or [],
        "hand_you_size": 7,
        "hand_opp_size": 7,
        "graveyard_you_size": 0,
        "graveyard_opp_size": 0,
        "mana_pool_you": 0,
        "mana_pool_opp": 0,
    }


class TestCanonicalStateHash:
    def test_deterministic(self):
        s1 = _state()
        s2 = _state()
        assert canonical_state_hash(s1) == canonical_state_hash(s2)

    def test_different_states_different_hash(self):
        s1 = _state(life_you=20)
        s2 = _state(life_you=18)
        assert canonical_state_hash(s1) != canonical_state_hash(s2)

    def test_key_order_invariant(self):
        """Keys in different order must still hash the same."""
        s = _state()
        reordered = dict(reversed(list(s.items())))
        assert canonical_state_hash(s) == canonical_state_hash(reordered)

    def test_ignores_irrelevant_fields(self):
        """Transient fields (e.g. `priority_passes`) should not affect the hash."""
        s1 = _state()
        s2 = dict(s1)
        s2["priority_passes"] = 42
        s2["random_junk"] = "this should be ignored"
        assert canonical_state_hash(s1) == canonical_state_hash(s2)


class TestLoopGuard:
    def test_unique_states_no_loop(self):
        guard = LoopGuard()
        for life in range(20, 10, -1):
            looped, _ = guard.observe(_state(life_you=life))
            assert not looped

    def test_repeated_state_triggers_loop(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=3))
        s = _state(life_you=15)
        loop_detected = False
        for _ in range(5):
            looped, toxic = guard.observe(s)
            if looped:
                loop_detected = True
                assert toxic is not None
                break
        assert loop_detected

    def test_flag_set_only_once(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        s = _state()
        guard.observe(s)
        _, toxic1 = guard.observe(s)  # trips
        _, toxic2 = guard.observe(s)  # already flagged, no new toxic
        assert toxic1 is not None
        assert toxic2 is None
        assert guard.is_flagged()

    def test_reset_clears_state(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        s = _state()
        guard.observe(s)
        guard.observe(s)
        assert guard.is_flagged()
        guard.reset()
        assert not guard.is_flagged()
        looped, _ = guard.observe(s)
        assert not looped

    def test_action_history_tracked_in_toxic(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        guard.record_action({"type": "cast", "card_id": 42})
        guard.record_action({"type": "pass"})
        s = _state()
        guard.observe(s)
        _, toxic = guard.observe(s)
        assert toxic is not None
        # Should prefer the non-pass action for attribution
        assert toxic.card_id == 42
        assert toxic.action_type == "cast"

    def test_action_attribution_falls_back_to_last(self):
        """If every action is a pass, fall back to the most recent."""
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        guard.record_action({"type": "pass", "card_id": None})
        s = _state()
        guard.observe(s)
        _, toxic = guard.observe(s)
        assert toxic is not None
        assert toxic.action_type == "pass"

    def test_window_size_bounds_memory(self):
        """State counter should evict old entries as window fills."""
        guard = LoopGuard(LoopGuardConfig(window_size=10, loop_threshold=100))
        for turn in range(50):
            guard.observe(_state(life_you=turn, turn=turn))
        # After 50 distinct states with window=10, we should have ≤10 tracked
        assert len(guard._loop_state.state_counts) <= 11

    def test_pending_toxic_accumulates(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        s = _state()
        guard.observe(s)
        guard.observe(s)
        assert len(guard.pending_toxic()) == 1
        guard.clear_pending()
        assert guard.pending_toxic() == []

    def test_non_terminal_loops_flagged_with_context_hash(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=3))
        s = _state(life_you=17, turn=5)
        for _ in range(4):
            looped, toxic = guard.observe(s)
            if looped:
                assert toxic.context_hash == canonical_state_hash(s)
                assert toxic.turn == 5
                return
        pytest.fail("loop was never detected")
