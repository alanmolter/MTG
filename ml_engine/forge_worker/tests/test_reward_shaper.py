"""Unit tests for potential-based reward shaping."""

import pytest

from ml_engine.forge_worker.reward_shaper import (
    GameStateSnapshot,
    RewardShaper,
    ShapingConfig,
    default_shaper,
    is_control_archetype,
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
    lands_you=0,
    lands_opp=0,
    nonland_permanents_you=0,
    nonland_permanents_opp=0,
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
        lands_you=lands_you,
        lands_opp=lands_opp,
        nonland_permanents_you=nonland_permanents_you,
        nonland_permanents_opp=nonland_permanents_opp,
        is_terminal=is_terminal,
        illegal_action=illegal_action,
    )


class TestRewardShaper:
    def test_illegal_action_returns_fixed_penalty(self):
        shaper = RewardShaper()
        assert shaper.shape(_snap(), _snap(illegal_action=True)) == pytest.approx(-0.05)

    def test_unchanged_neutral_state_is_zero(self):
        shaper = RewardShaper()
        state = _snap()
        assert shaper.shape(state, state) == pytest.approx(0.0, abs=1e-9)

    def test_repeating_a_developed_state_is_not_a_positive_bonus(self):
        """Per-step farming must not pay again for a position the agent already holds."""
        shaper = RewardShaper()
        state = _snap(power_you=6, lands_you=4, hand_you=5, nonland_permanents_you=2)
        assert shaper.potential(state) > 0
        assert shaper.shape(state, state) <= 0.0

    def test_life_swing_matches_discounted_potential_delta(self):
        shaper = RewardShaper()
        prev = _snap()
        curr = _snap(life_opp=17)
        expected = shaper.shaping_weight * (
            shaper.config.gamma * shaper.potential(curr) - shaper.potential(prev)
        )
        assert shaper.shape(prev, curr) == pytest.approx(expected)
        assert shaper.shape(prev, curr) > 0

    def test_taking_damage_is_negative(self):
        shaper = RewardShaper()
        assert shaper.shape(_snap(), _snap(life_you=15)) < 0

    def test_drawing_cards_increases_potential(self):
        shaper = RewardShaper()
        prev = _snap(hand_you=4, hand_opp=4)
        curr = _snap(hand_you=6, hand_opp=2)
        assert shaper.shape(prev, curr) > 0

    def test_playing_a_land_is_not_penalized(self):
        """Hand size drops by one, but mana development must dominate that."""
        shaper = RewardShaper()
        prev = _snap(hand_you=7, hand_opp=7, lands_you=2)
        curr = _snap(hand_you=6, hand_opp=7, lands_you=3)
        assert shaper.shape(prev, curr) >= 0.0

    def test_casting_a_creature_is_not_penalized(self):
        """A spell leaving the hand and entering the battlefield is not card disadvantage."""
        shaper = RewardShaper()
        prev = _snap(hand_you=7, nonland_permanents_you=0, power_you=0)
        curr = _snap(hand_you=6, nonland_permanents_you=1, power_you=2)
        assert shaper.potential(curr) >= shaper.potential(prev)
        assert shaper.shape(prev, curr) >= 0.0

    def test_board_power_increase_is_positive(self):
        shaper = RewardShaper()
        prev = _snap(power_you=2, power_opp=2)
        curr = _snap(power_you=5, power_opp=1)
        assert shaper.shape(prev, curr) > 0

    def test_control_archetype_ids_match(self):
        assert is_control_archetype("control")
        assert is_control_archetype("control_uw")
        assert is_control_archetype("Control-UB")
        assert not is_control_archetype("aggro_red")
        assert not is_control_archetype("midrange_bg")

    def test_control_open_mana_is_a_one_time_potential(self):
        shaper = RewardShaper()
        prev = _snap(archetype="control_uw")
        curr = _snap(
            archetype="control_uw",
            turn_ended=True,
            untapped_lands_you=3,
            instants_in_hand_you=2,
        )
        entered = shaper.shape(prev, curr)
        assert entered > 0
        # Holding the same end-of-turn state does not pay the bonus again.
        assert shaper.shape(curr, curr) <= 0

    def test_control_bonus_requires_end_of_turn_and_an_instant(self):
        shaper = RewardShaper()
        prev = _snap()
        mid_turn = _snap(
            archetype="control",
            turn_ended=False,
            untapped_lands_you=3,
            instants_in_hand_you=2,
        )
        no_instant = _snap(
            archetype="control",
            turn_ended=True,
            untapped_lands_you=5,
            instants_in_hand_you=0,
        )
        assert shaper.shape(prev, mid_turn) == pytest.approx(0.0, abs=1e-9)
        assert shaper.shape(prev, no_instant) == pytest.approx(0.0, abs=1e-9)

    def test_aggro_does_not_get_the_control_term(self):
        shaper = RewardShaper()
        prev = _snap()
        curr = _snap(
            archetype="aggro_red",
            turn_ended=True,
            untapped_lands_you=3,
            instants_in_hand_you=2,
        )
        assert shaper.shape(prev, curr) == pytest.approx(0.0, abs=1e-9)

    def test_terminal_win_dominates_neutral_state(self):
        shaper = RewardShaper()
        reward = shaper.shape(_snap(), _snap(is_terminal=True, life_you=1), outcome=1)
        assert reward == pytest.approx(1.0)

    def test_terminal_loss_is_negative(self):
        shaper = RewardShaper()
        reward = shaper.shape(
            _snap(), _snap(is_terminal=True, life_you=0, life_opp=20), outcome=-1
        )
        assert reward < -0.9

    def test_terminal_potential_is_zero_so_shaping_telescopes(self):
        shaper = RewardShaper()
        developed = _snap(power_you=8, lands_you=5, hand_you=6)
        assert shaper.potential(developed) > 0
        # Winning from a developed state returns the stored potential instead of
        # adding another copy of it on top of +1.
        reward = shaper.shape(developed, _snap(is_terminal=True), outcome=1)
        assert reward < 1.0
        assert reward > 0.0

    def test_legacy_snapshot_fields_still_construct(self):
        shaper = RewardShaper()
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
        assert shaper.shape(prev, curr) > 0

    def test_default_shaper_factory(self):
        shaper = default_shaper()
        assert isinstance(shaper, RewardShaper)
        assert shaper.config.outcome_weight == 1.0
        assert shaper.config.gamma == pytest.approx(0.99)
        assert shaper.config.episode_shape_cap == pytest.approx(0.5)

    def test_annealing_weight_reaches_the_final_value(self):
        shaper = RewardShaper(ShapingConfig(
            shaping_weight=1.0,
            shaping_weight_final=0.0,
            shaping_anneal_episodes=4,
        ))
        shaper.set_episode_index(1)
        assert shaper.shaping_weight == pytest.approx(1.0)
        shaper.set_episode_index(3)
        assert shaper.shaping_weight == pytest.approx(0.5)
        shaper.set_episode_index(5)
        assert shaper.shaping_weight == pytest.approx(0.0)
        assert shaper.shape(_snap(), _snap(life_opp=10)) == pytest.approx(0.0)

    def test_disabled_anneal_keeps_the_configured_weight(self):
        shaper = RewardShaper(ShapingConfig(shaping_weight=0.25, shaping_anneal_episodes=0))
        shaper.set_episode_index(100)
        assert shaper.shaping_weight == pytest.approx(0.25)


class TestEpisodeShapeCap:
    def test_cumulative_cap_blocks_runaway_positive_shape(self):
        shaper = RewardShaper(ShapingConfig(episode_shape_cap=0.5))
        prev = _snap()
        curr = _snap(life_opp=0, power_you=20, lands_you=7, hand_you=10)
        total = sum(shaper.shape(prev, curr) for _ in range(50))
        assert total <= 0.5 + 1e-9
        assert total > 0.4

    def test_cumulative_cap_blocks_runaway_negative_shape(self):
        shaper = RewardShaper(ShapingConfig(episode_shape_cap=0.5))
        total = sum(shaper.shape(_snap(), _snap(life_you=0, power_opp=20)) for _ in range(50))
        assert total >= -0.5 - 1e-9
        assert total < -0.4

    def test_loss_outcome_always_dominates_total_return(self):
        shaper = RewardShaper()
        total = 0.0
        prev = _snap()
        curr = _snap(life_opp=0, power_you=20, lands_you=7, hand_you=10, nonland_permanents_you=6)
        for _ in range(30):
            total += shaper.shape(prev, curr)
        total += shaper.shape(_snap(), _snap(is_terminal=True, life_you=0), outcome=-1)
        assert total < -0.4

    def test_win_after_capped_shaping_stays_positive(self):
        shaper = RewardShaper()
        total = sum(
            shaper.shape(_snap(), _snap(life_opp=0, power_you=20, lands_you=7))
            for _ in range(30)
        )
        total += shaper.shape(_snap(), _snap(is_terminal=True), outcome=1)
        assert total > 1.0

    def test_reset_episode_clears_cumulative(self):
        shaper = RewardShaper(ShapingConfig(episode_shape_cap=0.5))
        prev, curr = _snap(), _snap(life_opp=0, power_you=20, lands_you=7)
        for _ in range(50):
            shaper.shape(prev, curr)
        assert shaper.shape(prev, curr) == pytest.approx(0.0, abs=1e-9)
        shaper.reset_episode()
        assert shaper.shape(prev, curr) > 0.02

    def test_terminal_auto_resets_cumulative(self):
        shaper = RewardShaper()
        prev, curr = _snap(), _snap(life_opp=0, power_you=20, lands_you=7)
        for _ in range(50):
            shaper.shape(prev, curr)
        shaper.shape(_snap(), _snap(is_terminal=True, life_you=0), outcome=-1)
        assert shaper.shape(prev, curr) > 0.02

    def test_illegal_action_does_not_consume_shape_budget(self):
        shaper = RewardShaper()
        for _ in range(5):
            assert shaper.shape(_snap(), _snap(illegal_action=True)) == pytest.approx(-0.05)
        assert shaper.shape(_snap(), _snap(life_opp=10)) > 0.02
