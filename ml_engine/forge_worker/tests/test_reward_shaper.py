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
        shaper = RewardShaper(ShapingConfig(beta_tempo=0.01, step_cap=1.0))
        prev = _snap()
        curr = _snap(mana_value_played=4)
        r = shaper.shape(prev, curr)
        assert r >= 0.04

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
