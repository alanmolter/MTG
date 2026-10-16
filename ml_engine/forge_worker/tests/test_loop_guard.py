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

    def test_rlbridge_source_emits_the_hash_fields(self):
        """The Java snapshot must keep emitting the keys this hash reads.

        mana_pool_* is present but hardcoded to 0 in the current bridge, so a
        mana-only delta does not move the hash. Phase, battlefield size, power
        and land counts do, which is what stops the old constant-hash false loop.
        """
        from pathlib import Path

        source = (
            Path(__file__).resolve().parents[3]
            / "rlbridge_src/src/main/java/forge/rlbridge/ForgeRLBridge.java"
        ).read_text(encoding="utf-8")
        for key in (
            "turn_phase",
            "life_you",
            "life_opp",
            "battlefield_you",
            "battlefield_opp",
            "hand_you_size",
            "hand_opp_size",
            "graveyard_you_size",
            "graveyard_opp_size",
            "mana_pool_you",
            "mana_pool_opp",
            "power_you",
            "power_opp",
            "lands_you",
            "lands_opp",
        ):
            assert f'"{key}"' in source

    def test_bridge_payload_phase_and_battlefield_are_part_of_the_hash(self):
        """ForgeRLBridge emits these flat keys; a phase change must not look like a loop."""
        base = {
            "turn": 3,
            "turn_phase": 2,
            "life_you": 20,
            "life_opp": 20,
            "battlefield_you": 1,
            "battlefield_opp": 1,
            "hand_you_size": 7,
            "hand_opp_size": 7,
            "graveyard_you_size": 0,
            "graveyard_opp_size": 0,
            "mana_pool_you": 0,
            "mana_pool_opp": 0,
            "power_you": 2,
            "power_opp": 2,
        }
        assert canonical_state_hash(base) != canonical_state_hash({**base, "turn_phase": 3})
        assert canonical_state_hash(base) != canonical_state_hash({**base, "battlefield_you": 2})
        assert canonical_state_hash(base) != canonical_state_hash({**base, "lands_you": 1})

    def test_nested_you_block_aliases_when_flat_keys_are_missing(self):
        """A payload that only has the player blocks still distinguishes life totals."""
        you_20 = {"you": {"life": 20, "hand_size": 7}, "opp": {"life": 20, "hand_size": 7}, "phase": "MAIN1"}
        you_18 = {"you": {"life": 18, "hand_size": 7}, "opp": {"life": 20, "hand_size": 7}, "phase": "MAIN1"}
        assert canonical_state_hash(you_20) != canonical_state_hash(you_18)
        assert canonical_state_hash(you_20) != canonical_state_hash({**you_20, "phase": "COMBAT"})


class TestLoopGuard:
    def test_unique_states_no_loop(self):
        guard = LoopGuard()
        for life in range(20, 10, -1):
            guard.record_action({"type": "action"})
            looped, _ = guard.observe(_state(life_you=life))
            assert not looped

    def test_repeated_state_triggers_loop(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=3))
        s = _state(life_you=15)
        loop_detected = False
        for _ in range(5):
            guard.record_action({"type": "action"})
            looped, toxic = guard.observe(s)
            if looped:
                loop_detected = True
                assert toxic is not None
                break
        assert loop_detected

    def test_flag_set_only_once(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        s = _state()
        guard.record_action({"type": "action"})
        guard.observe(s)
        guard.record_action({"type": "action"})
        _, toxic1 = guard.observe(s)  # trips
        guard.record_action({"type": "action"})
        _, toxic2 = guard.observe(s)  # already flagged, no new toxic
        assert toxic1 is not None
        assert toxic2 is None
        assert guard.is_flagged()

    def test_reset_clears_state(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        s = _state()
        guard.record_action({"type": "action"})
        guard.observe(s)
        guard.record_action({"type": "action"})
        guard.observe(s)
        assert guard.is_flagged()
        guard.reset()
        assert not guard.is_flagged()
        guard.record_action({"type": "action"})
        looped, _ = guard.observe(s)
        assert not looped

    def test_action_history_tracked_in_toxic(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        guard.record_action({"type": "cast", "card_id": 42})
        s = _state()
        guard.observe(s)
        guard.record_action({"type": "pass"})
        assert guard.observe(s) == (False, None)
        guard.record_action({"type": "cast", "card_id": 42})
        _, toxic = guard.observe(s)
        assert toxic is not None
        # Should prefer the non-pass action for attribution
        assert toxic.card_id == 42
        assert toxic.action_type == "cast"

    def test_repeated_passes_are_not_toxic(self):
        """Priority handoffs often return an identical canonical state."""
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        s = _state()
        for action_type in ("pass", "priority", "noop") * 5:
            guard.record_action({"type": action_type, "card_id": None})
            assert guard.observe(s) == (False, None)
        assert not guard.is_flagged()
        assert guard.pending_toxic() == []
        assert guard._loop_state.state_counts == {}

    def test_duplicate_snapshot_without_new_action_is_not_toxic(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        s = _state()
        guard.record_action({"type": "cast", "card_id": 42})
        assert guard.observe(s) == (False, None)
        for _ in range(5):
            assert guard.observe(s) == (False, None)
        assert not guard.is_flagged()

    def test_meaningful_same_state_actions_still_toxic_after_passes(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=3))
        s = _state()
        for attempt in range(3):
            guard.record_action({"type": "action", "card_id": 42})
            looped, toxic = guard.observe(s)
            if attempt < 2:
                assert not looped
                guard.record_action({"type": "pass"})
                assert guard.observe(s) == (False, None)
            else:
                assert looped
                assert toxic is not None
                assert toxic.action_type == "action"
                assert toxic.detected_count == 3

    def test_window_size_bounds_memory(self):
        """State counter should evict old entries as window fills."""
        guard = LoopGuard(LoopGuardConfig(window_size=10, loop_threshold=100))
        for turn in range(50):
            guard.record_action({"type": "action"})
            guard.observe(_state(life_you=turn, turn=turn))
        # After 50 distinct states with window=10, we should have ≤10 tracked
        assert len(guard._loop_state.state_counts) <= 11

    def test_pending_toxic_accumulates(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=2))
        s = _state()
        guard.record_action({"type": "action"})
        guard.observe(s)
        guard.record_action({"type": "action"})
        guard.observe(s)
        assert len(guard.pending_toxic()) == 1
        guard.clear_pending()
        assert guard.pending_toxic() == []

    def test_flush_matches_toxic_actions_columns(self):
        class _Cursor:
            def __init__(self):
                self.sql = ""
                self.rows = []

            def executemany(self, sql, rows):
                self.sql = sql
                self.rows = list(rows)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        class _Conn:
            def __init__(self):
                self.cur = _Cursor()

            def cursor(self):
                return self.cur

            def commit(self):
                return None

        guard = LoopGuard()
        guard._toxic_pending.append(ToxicAction(
            card_id="Lightning Bolt",
            action_type="cast",
            context_hash="abc123",
            turn=4,
            detected_count=3,
        ))
        conn = _Conn()
        written = guard.flush_to_db(conn)
        assert written == 1
        assert "action_hash" in conn.cur.sql
        assert "deck_snap" in conn.cur.sql
        assert "trigger_reason" in conn.cur.sql
        assert "ON CONFLICT (action_hash)" in conn.cur.sql
        insert_list = conn.cur.sql.split("VALUES")[0]
        assert "card_id" not in insert_list
        assert "action_type" not in insert_list
        action_hash, snap, reason, count = conn.cur.rows[0]
        assert action_hash == "abc123"
        assert "Lightning Bolt" in snap
        assert reason == "STATE_REPEATED"
        assert count == 3

    def test_non_terminal_loops_flagged_with_context_hash(self):
        guard = LoopGuard(LoopGuardConfig(loop_threshold=3))
        s = _state(life_you=17, turn=5)
        for _ in range(4):
            guard.record_action({"type": "action"})
            looped, toxic = guard.observe(s)
            if looped:
                assert toxic.context_hash == canonical_state_hash(s)
                assert toxic.turn == 5
                return
        pytest.fail("loop was never detected")
