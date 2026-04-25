"""Unit tests for Pillar 6 — RewardShaper."""

import pytest

from ml_engine.forge_worker.reward_shaper import (
    GameStateSnapshot,
    RewardShaper,
    ShapingConfig,
    default_shaper,
)


def _snap(
    turn=1,
    life_you=20,
    life_opp=20,
    hand_you=7,
    hand_opp=7,
    power_you=0,
    power_opp=0,
    mana_value_played=0,
    mana_available_you=0,
    untapped_lands_you=0,
    instants_in_hand_you=0,
    archetype="",
    turn_ended=False,
    is_terminal=False,
    illegal_action=False,
):
    return GameStateSnapshot(
        turn=turn,
        life_you=life_you,
        life_opp=life_opp,
        hand_you=hand_you,
        hand_opp=hand_opp,
        power_you=power_you,
        power_opp=power_opp,
        mana_value_played=mana_value_played,
        mana_available_you=mana_available_you,
        untapped_lands_you=untapped_lands_you,
        instants_in_hand_you=instants_in_hand_you,
        archetype=archetype,
        turn_ended=turn_ended,
        is_terminal=is_terminal,
        illegal_action=illegal_action,
    )


class TestRewardShaper:
    def test_illegal_action_returns_fixed_penalty(self):
        shaper = RewardShaper()
        prev = _snap()
        curr = _snap(illegal_action=True)
        r = shaper.shape(prev, curr)
        assert r == pytest.approx(-0.05)

    def test_identical_state_produces_zero_or_near_zero(self):
        shaper = RewardShaper()
        s = _snap()
        r = shaper.shape(s, s)
        # Progress bonus can give tiny positive value since power_you=0 → 0.
        assert abs(r) < 1e-6

    def test_hit_opponent_gives_positive_life_reward(self):
        shaper = RewardShaper(ShapingConfig(alpha_life=0.02, step_cap=1.0))
        prev = _snap(life_opp=20)
        curr = _snap(life_opp=17)  # opponent down 3
        r = shaper.shape(prev, curr)
        # d_life = (20-17) - (20-20) = 3; r_life = 0.02 * 3 = 0.06
        assert r > 0.05

    def test_take_damage_gives_negative_reward(self):
        shaper = RewardShaper(ShapingConfig(alpha_life=0.02, step_cap=1.0))
        prev = _snap(life_you=20)
        curr = _snap(life_you=15)  # you down 5
        r = shaper.shape(prev, curr)
        assert r < -0.05

    def test_card_advantage_signal(self):
        shaper = RewardShaper(ShapingConfig(gamma_cards=0.03, step_cap=1.0))
        prev = _snap(hand_you=4, hand_opp=4)
        curr = _snap(hand_you=6, hand_opp=2)
        r = shaper.shape(prev, curr)
        # d_hand = (6-2) - (4-4) = 4 → r = 0.12
        assert r > 0.1

    def test_board_control_signal(self):
        shaper = RewardShaper(ShapingConfig(delta_board=0.015, step_cap=1.0))
        prev = _snap(power_you=2, power_opp=2)
        curr = _snap(power_you=5, power_opp=1)
        r = shaper.shape(prev, curr)
        # d_power = (5-1) - (2-2) = 4 → r = 0.06
        assert r > 0.05

    def test_tempo_signal_from_mana_played(self):
        """Legacy tempo knob still works when explicitly enabled (back-compat)."""
        shaper = RewardShaper(ShapingConfig(beta_tempo=0.01, step_cap=1.0))
        prev = _snap()
        curr = _snap(mana_value_played=4)
        r = shaper.shape(prev, curr)
        assert r >= 0.04

    # ── Phase 1: mana efficiency ────────────────────────────────────────
    def test_mana_efficiency_full_use(self):
        """Spending 4 of 4 available mana → near-full zeta bonus."""
        shaper = RewardShaper(ShapingConfig(zeta_efficiency=0.03, step_cap=1.0))
        prev = _snap()
        curr = _snap(mana_value_played=4, mana_available_you=4)
        r = shaper.shape(prev, curr)
        assert r == pytest.approx(0.03, abs=1e-6)

    def test_mana_efficiency_partial_use(self):
        """Spending 1 of 4 available mana → ~25% of the bonus."""
        shaper = RewardShaper(ShapingConfig(zeta_efficiency=0.04, step_cap=1.0))
        prev = _snap()
        curr = _snap(mana_value_played=1, mana_available_you=4)
        r = shaper.shape(prev, curr)
        assert r == pytest.approx(0.01, abs=1e-6)

    def test_mana_efficiency_no_info_is_zero(self):
        """When mana_available_you is 0, the efficiency bonus is silent."""
        shaper = RewardShaper(ShapingConfig(zeta_efficiency=0.03, step_cap=1.0))
        prev = _snap()
        curr = _snap(mana_value_played=3, mana_available_you=0)
        r = shaper.shape(prev, curr)
        # Only progress bonus (0, since power_you=0) + life delta (0) remain.
        assert abs(r) < 1e-6

    def test_mana_efficiency_over_cast_is_capped(self):
        """Rituals that cast CMC > available shouldn't exceed full bonus."""
        shaper = RewardShaper(ShapingConfig(zeta_efficiency=0.03, step_cap=1.0))
        prev = _snap()
        curr = _snap(mana_value_played=10, mana_available_you=4)
        r = shaper.shape(prev, curr)
        # Efficiency clamps at 1.0 → bonus == zeta_efficiency
        assert r == pytest.approx(0.03, abs=1e-6)

    # ── Phase 1: archetype modifier (control-open-mana) ─────────────────
    def test_control_gets_bonus_for_passing_with_mana_and_instants(self):
        cfg = ShapingConfig(control_mana_open_bonus=0.015, step_cap=1.0)
        shaper = RewardShaper(cfg)
        prev = _snap()
        curr = _snap(
            archetype="control",
            turn_ended=True,
            untapped_lands_you=3,
            instants_in_hand_you=2,
        )
        r = shaper.shape(prev, curr)
        assert r == pytest.approx(0.015, abs=1e-6)

    def test_control_bonus_requires_end_of_turn(self):
        cfg = ShapingConfig(control_mana_open_bonus=0.015, step_cap=1.0)
        shaper = RewardShaper(cfg)
        prev = _snap()
        # Same state but mid-turn → no bonus
        curr = _snap(
            archetype="control",
            turn_ended=False,
            untapped_lands_you=3,
            instants_in_hand_you=2,
        )
        r = shaper.shape(prev, curr)
        assert abs(r) < 1e-6

    def test_control_bonus_requires_instants_in_hand(self):
        cfg = ShapingConfig(control_mana_open_bonus=0.015, step_cap=1.0)
        shaper = RewardShaper(cfg)
        prev = _snap()
        curr = _snap(
            archetype="control",
            turn_ended=True,
            untapped_lands_you=5,
            instants_in_hand_you=0,  # nothing to cast — no bonus
        )
        r = shaper.shape(prev, curr)
        assert abs(r) < 1e-6

    def test_aggro_does_not_get_control_bonus(self):
        cfg = ShapingConfig(control_mana_open_bonus=0.015, step_cap=1.0)
        shaper = RewardShaper(cfg)
        prev = _snap()
        curr = _snap(
            archetype="aggro",
            turn_ended=True,
            untapped_lands_you=3,
            instants_in_hand_you=2,
        )
        r = shaper.shape(prev, curr)
        assert abs(r) < 1e-6

    def test_step_cap_limits_shaped_reward(self):
        shaper = RewardShaper(ShapingConfig(
            alpha_life=1.0,  # absurd weight
            step_cap=0.1,
        ))
        prev = _snap()
        curr = _snap(life_opp=0)  # d_life = 20 → r_life = 20.0 uncapped
        r = shaper.shape(prev, curr)
        assert r <= 0.11  # capped at step_cap=0.1 (plus tiny progress bonus)

    def test_terminal_win_dominates_shape(self):
        shaper = RewardShaper()
        prev = _snap()
        curr = _snap(is_terminal=True, life_you=1)
        r = shaper.shape(prev, curr, outcome=1)
        # Won even though nearly dead — terminal +1 dominates.
        # Dense penalty is clamped to -step_cap (-0.1), so r = 1.0 - 0.1 = 0.9 exactly.
        assert r >= 0.9

    def test_terminal_loss_gives_negative(self):
        shaper = RewardShaper()
        prev = _snap()
        curr = _snap(is_terminal=True, life_you=0, life_opp=20)
        r = shaper.shape(prev, curr, outcome=-1)
        assert r < -0.9

    def test_progress_bonus_favors_faster_clock(self):
        """More power + less life on opp = higher progress bonus."""
        shaper = RewardShaper()
        curr_fast = _snap(power_you=10, life_opp=5)    # lethal in 1
        curr_slow = _snap(power_you=1, life_opp=20)    # lethal in 20
        prev = _snap()
        r_fast = shaper.shape(prev, curr_fast)
        r_slow = shaper.shape(prev, curr_slow)
        assert r_fast > r_slow

    def test_progress_bonus_zero_when_no_power(self):
        shaper = RewardShaper()
        assert shaper._progress_bonus(_snap(power_you=0)) == 0.0

    def test_default_shaper_factory(self):
        s = default_shaper()
        assert isinstance(s, RewardShaper)
        assert s.config.outcome_weight == 1.0
        # Phase 1 defaults must be wired
        assert s.config.zeta_efficiency > 0
        assert s.config.control_mana_open_bonus > 0

    def test_backward_compat_snapshot_without_phase1_fields(self):
        """Older callers that don't set the new fields must still work."""
        shaper = RewardShaper()
        # Only the legacy kwargs — new fields take their defaults
        prev = GameStateSnapshot(
            turn=1, life_you=20, life_opp=20,
            hand_you=7, hand_opp=7,
            power_you=0, power_opp=0,
            mana_value_played=0,
        )
        curr = GameStateSnapshot(
            turn=2, life_you=20, life_opp=18,
            hand_you=7, hand_opp=7,
            power_you=2, power_opp=0,
            mana_value_played=2,
        )
        r = shaper.shape(prev, curr)
        # life delta + tiny progress bonus — should be positive, well below cap
        assert 0 < r < 0.1


# ──────────────────────────────────────────────────────────────────────────────
# Anomaly-1A regression tests (2026-04-23)
#
# Before this fix, a losing agent could net POSITIVE total episode reward by
# farming mana-efficiency bonus turn after turn. The cumulative cap forbids
# that — total shaped reward is bounded by |episode_shape_cap|, so the
# terminal outcome (±1.0) always dominates.
# ──────────────────────────────────────────────────────────────────────────────


class TestEpisodeShapeCap:
    """Cumulative-cap invariants for the Anomaly-1A fix."""

    def test_default_step_cap_is_tightened(self):
        """Step-cap default lowered from 0.1 → 0.04."""
        cfg = ShapingConfig()
        assert cfg.step_cap == pytest.approx(0.04)

    def test_default_episode_cap_exists_and_is_half(self):
        """New knob: cumulative per-episode cap defaults to 0.5."""
        cfg = ShapingConfig()
        assert hasattr(cfg, "episode_shape_cap")
        assert cfg.episode_shape_cap == pytest.approx(0.5)

    def test_cumulative_cap_blocks_runaway_positive_shape(self):
        """50 positive-shape steps should not exceed episode_shape_cap."""
        cfg = ShapingConfig(episode_shape_cap=0.5)
        shaper = RewardShaper(cfg)
        # Each step: mana efficiency bonus == zeta_efficiency == 0.03
        prev = _snap()
        curr = _snap(mana_value_played=4, mana_available_you=4)
        total = 0.0
        for _ in range(50):
            total += shaper.shape(prev, curr)
        assert total <= 0.5 + 1e-9
        # And we actually saturated (not just got lucky with small rewards):
        assert total > 0.4

    def test_cumulative_cap_blocks_runaway_negative_shape(self):
        """50 damage-absorbing steps should not exceed -episode_shape_cap."""
        cfg = ShapingConfig(episode_shape_cap=0.5)
        shaper = RewardShaper(cfg)
        total = 0.0
        for _ in range(50):
            # Each step: take 2 damage → r_life = 0.02 * -2 = -0.04
            prev = _snap()
            curr = _snap(life_you=18)
            total += shaper.shape(prev, curr)
        assert total >= -0.5 - 1e-9
        assert total < -0.4

    def test_loss_outcome_always_dominates_total_return(self):
        """
        The canonical Anomaly-1A scenario:
        Agent played efficiently for 30 turns (cumulative positive shape hits
        the cap) but ultimately LOST. Total episode return MUST be negative.
        Before the fix, this could be +2.0 (shape=+3.0, terminal=-1.0).
        After the fix, shape is capped at +0.5, terminal is -1.0, total is ≤ -0.5.
        """
        shaper = RewardShaper()  # default cfg
        total = 0.0
        # 30 "good" non-terminal turns: full mana efficiency + cards up
        for _ in range(30):
            prev = _snap()
            curr = _snap(
                mana_value_played=4,
                mana_available_you=4,
                hand_you=9, hand_opp=5,
                power_you=3, power_opp=0,
            )
            total += shaper.shape(prev, curr)

        # Terminal LOSS on turn 31
        prev = _snap()
        curr = _snap(is_terminal=True, life_you=0, life_opp=20)
        total += shaper.shape(prev, curr, outcome=-1)

        # With cap=0.5 + terminal=-1.0 (+ one last capped step of -0.04):
        # total ≤ 0.5 - 1.0 - 0.04 = -0.54
        assert total < -0.4, (
            f"Losing agent netted total={total:.3f} — terminal loss did not "
            "dominate! This is the Anomaly-1A regression."
        )

    def test_win_outcome_still_clearly_positive_with_cap(self):
        """Symmetric: winning agent with capped shape still has positive return."""
        shaper = RewardShaper()
        total = 0.0
        for _ in range(30):
            prev = _snap()
            curr = _snap(mana_value_played=4, mana_available_you=4)
            total += shaper.shape(prev, curr)
        prev = _snap()
        curr = _snap(is_terminal=True, life_you=20)
        total += shaper.shape(prev, curr, outcome=1)
        # ≥ 0.5 (cap) + 1.0 (terminal win) − 0.04 (last capped step variance) ≈ 1.46
        assert total > 1.0

    def test_reset_episode_clears_cumulative(self):
        """After reset_episode(), the cap budget must be fresh again."""
        cfg = ShapingConfig(episode_shape_cap=0.5)
        shaper = RewardShaper(cfg)
        # Saturate
        for _ in range(50):
            shaper.shape(_snap(), _snap(mana_value_played=4, mana_available_you=4))
        # Now a new positive step should be ~zero (cap reached)
        r_saturated = shaper.shape(
            _snap(), _snap(mana_value_played=4, mana_available_you=4)
        )
        assert r_saturated == pytest.approx(0.0, abs=1e-9)

        # Reset → budget restored
        shaper.reset_episode()
        r_fresh = shaper.shape(
            _snap(), _snap(mana_value_played=4, mana_available_you=4)
        )
        assert r_fresh > 0.02

    def test_terminal_auto_resets_cumulative(self):
        """Terminal transition automatically clears cumulative for next episode."""
        shaper = RewardShaper()
        # Saturate positive
        for _ in range(50):
            shaper.shape(_snap(), _snap(mana_value_played=4, mana_available_you=4))
        # Terminal step with loss
        shaper.shape(
            _snap(), _snap(is_terminal=True, life_you=0, life_opp=20), outcome=-1
        )
        # Next "episode" first step should have full budget again
        r_new = shaper.shape(
            _snap(), _snap(mana_value_played=4, mana_available_you=4)
        )
        assert r_new > 0.02

    def test_illegal_action_does_not_consume_shape_budget(self):
        """Illegal-action penalty is its own channel — it must not touch cumulative."""
        shaper = RewardShaper()
        # Trigger a couple of illegal actions
        for _ in range(5):
            r = shaper.shape(_snap(), _snap(illegal_action=True))
            assert r == pytest.approx(-0.05)
        # Shape budget should still be fully available
        r = shaper.shape(_snap(), _snap(mana_value_played=4, mana_available_you=4))
        assert r > 0.02
