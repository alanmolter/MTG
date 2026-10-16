"""Potential-based reward shaping for Forge episodes.

The sparse outcome (+1 win / -1 loss / 0 draw) is the learning target. Dense
shaping exists only to shorten the credit-assignment gap, and it is the
Ng, Harada & Russell (1999) potential:

    F(s, s') = w * (gamma * Phi(s') - Phi(s))

Phi depends only on the state (life, useful cards, board power, mana
development, and a control "mana open" indicator). It does not pay a fresh
bonus for repeating the same position, and moving a card from hand onto the
battlefield is not a card-advantage loss. On a true terminal state Phi is 0,
so the shaping telescopes and cannot swamp the outcome. An episode cap is a
second guardrail. ``w`` is an annealing weight: it can decay to 0 so late
training optimizes the win/loss signal alone.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class ShapingConfig:
    """Weights inside Phi, plus the discount and the annealing schedule.

    Phi terms are already scaled to roughly [-1, 1] before the weights, so
    the default weights keep a single potential well below the ±1 outcome.
    ``episode_shape_cap`` bounds the sum of F over one episode.
    """

    w_life: float = 0.20
    w_cards: float = 0.15
    w_board: float = 0.10
    w_mana: float = 0.15
    w_control_open: float = 0.05
    gamma: float = 0.99
    shaping_weight: float = 1.0
    shaping_weight_final: float = 0.0
    shaping_anneal_episodes: int = 0
    outcome_weight: float = 1.0
    episode_shape_cap: float = 0.5
    penalty_illegal_action: float = -0.05
    # Retained so older call sites that still pass these kwargs keep working.
    # They are not added on top of the potential.
    step_cap: float = 0.0
    alpha_life: float = 0.0
    beta_tempo: float = 0.0
    gamma_cards: float = 0.0
    delta_board: float = 0.0
    epsilon_progress: float = 0.0
    zeta_efficiency: float = 0.0
    control_mana_open_bonus: float = 0.0


@dataclass
class GameStateSnapshot:
    """State features the potential reads. Missing bridge fields stay at 0."""

    turn: int
    life_you: int
    life_opp: int
    hand_you: int
    hand_opp: int
    power_you: int
    power_opp: int
    mana_value_played: int = 0
    mana_available_you: int = 0
    untapped_lands_you: int = 0
    instants_in_hand_you: int = 0
    archetype: str = ""
    turn_ended: bool = False
    lands_you: int = 0
    lands_opp: int = 0
    nonland_permanents_you: int = 0
    nonland_permanents_opp: int = 0
    untapped_lands_opp: int = 0
    is_terminal: bool = False
    illegal_action: bool = False


def is_control_archetype(name: str) -> bool:
    """True for ``control`` and Arena ids such as ``control_uw``.

    Matching the whole string against ``"control"`` never fired: the training
    pool names archetypes ``control_uw``, ``control_blue``, and ``control_ub``.
    """

    tokens = [token for token in (name or "").strip().lower().replace("-", "_").split("_") if token]
    return "control" in tokens


class RewardShaper:
    """Potential-based shaper with an episode cap and an annealing weight."""

    def __init__(self, config: Optional[ShapingConfig] = None):
        self.config = config or ShapingConfig()
        self._episode_shape_total: float = 0.0
        self._weight: float = float(self.config.shaping_weight)

    def reset_episode(self) -> None:
        """Clear the per-episode shaping budget. Called from ``env.reset()``."""
        self._episode_shape_total = 0.0

    def set_episode_index(self, episode_index: int) -> None:
        """Anneal ``w`` across episodes. Index is 1-based.

        With ``shaping_anneal_episodes <= 0`` the weight stays at
        ``shaping_weight``. Otherwise it moves linearly to
        ``shaping_weight_final`` and holds there.
        """

        span = int(self.config.shaping_anneal_episodes)
        start = float(self.config.shaping_weight)
        final = float(self.config.shaping_weight_final)
        if span <= 0:
            self._weight = start
            return
        progress = min(1.0, max(0.0, (int(episode_index) - 1) / float(span)))
        self._weight = (1.0 - progress) * start + progress * final

    @property
    def shaping_weight(self) -> float:
        return self._weight

    def potential(self, state: GameStateSnapshot) -> float:
        """Phi(s). Terminal callers must pass 0 instead of calling this."""

        cfg = self.config
        life = (state.life_you - state.life_opp) / 20.0
        useful_you = state.hand_you + state.nonland_permanents_you
        useful_opp = state.hand_opp + state.nonland_permanents_opp
        cards = (useful_you - useful_opp) / 10.0
        board = (state.power_you - state.power_opp) / 10.0
        mana = _mana_development(state.lands_you) - _mana_development(state.lands_opp)
        control = 0.0
        if (
            state.turn_ended
            and is_control_archetype(state.archetype)
            and state.untapped_lands_you >= 2
            and state.instants_in_hand_you >= 1
        ):
            control = 1.0
        return (
            cfg.w_life * life
            + cfg.w_cards * cards
            + cfg.w_board * board
            + cfg.w_mana * mana
            + cfg.w_control_open * control
        )

    def shape(
        self,
        prev: GameStateSnapshot,
        curr: GameStateSnapshot,
        outcome: Optional[int] = None,
    ) -> float:
        """Return F(s, s') plus the terminal outcome, with the episode cap applied to F."""

        if curr.illegal_action:
            return self.config.penalty_illegal_action

        r_terminal = 0.0
        if curr.is_terminal and outcome is not None:
            r_terminal = self.config.outcome_weight * float(outcome)

        phi_prev = self.potential(prev)
        phi_curr = 0.0 if curr.is_terminal else self.potential(curr)
        r_shape = self._weight * (self.config.gamma * phi_curr - phi_prev)
        r_shape = self._clip_to_episode_budget(r_shape)
        if curr.is_terminal:
            self._episode_shape_total = 0.0
        return r_terminal + r_shape

    def _clip_to_episode_budget(self, r_shape: float) -> float:
        cap = abs(float(self.config.episode_shape_cap))
        projected = self._episode_shape_total + r_shape
        if projected > cap:
            r_shape = cap - self._episode_shape_total
        elif projected < -cap:
            r_shape = -cap - self._episode_shape_total
        self._episode_shape_total += r_shape
        return r_shape


def _mana_development(lands: int) -> float:
    """Diminishing land development, saturated at 7 lands."""
    return min(7, max(0, int(lands))) / 7.0


def default_shaper() -> RewardShaper:
    return RewardShaper()
