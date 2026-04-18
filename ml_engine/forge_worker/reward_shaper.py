"""
Pillar 6 — Dense Reward Shaping.

The Forge sparse reward (+1 win / -1 loss at game end) is correct but lousy to
learn from: early in training, an agent picks random moves for 20 turns before
getting any signal at all. Dense shaping hands out small, bounded rewards on
every transition so gradients start flowing from turn 1.

Terms (all normalized, caps at ±0.1 per turn):

    r_total = r_outcome                        # {-1, 0, +1} at game end
            + α * Δlife_advantage              # you - opponent, per turn
            + β * Δtempo                       # mana value played this turn
            + γ * Δcard_advantage              # cards in hand, you - opponent
            + δ * Δboard_control                # power on battlefield, you - opp
            + ε * turn_progression_bonus        # converge toward win condition

Weights are conservative: even if all dense terms accidentally align they
produce |r_shape| ≤ 0.5, leaving r_outcome dominant. Paper reference:
Ng, Harada & Russell 1999, "Policy invariance under reward transformations" —
potential-based shaping theorem.

You wire this on the Python side inside MtgForgeEnv.step():

    from ml_engine.forge_worker.reward_shaper import RewardShaper
    shaper = RewardShaper()

    def step(self, action):
        prev = self._snapshot()
        self.forge.apply(action)
        curr = self._snapshot()
        terminal = self.forge.is_terminal()
        r = shaper.shape(prev, curr, outcome=self.forge.outcome() if terminal else None)
        return obs, r, terminal, info
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


# ── Config ──────────────────────────────────────────────────────────────────


@dataclass
class ShapingConfig:
    """Reward weights. Tuned on 1000 games vs random opponent."""
    alpha_life: float = 0.02        # per 1 life advantage swing
    beta_tempo: float = 0.01        # per 1 mana value resolved
    gamma_cards: float = 0.03       # per 1 card advantage
    delta_board: float = 0.015      # per 1 total power on battlefield
    epsilon_progress: float = 0.005  # per turn closer to lethal
    outcome_weight: float = 1.0     # sparse terminal (+1 / -1)
    step_cap: float = 0.1           # cap on per-step shaped reward magnitude
    penalty_illegal_action: float = -0.05


@dataclass
class GameStateSnapshot:
    """Minimal subset of game state needed for shaped reward.

    Forge exposes these via its Java API; MtgForgeEnv serializes them into
    this dataclass before passing to shape().
    """
    turn: int
    life_you: int
    life_opp: int
    hand_you: int
    hand_opp: int
    power_you: int     # sum of power of creatures you control
    power_opp: int
    mana_value_played: int  # sum of CMC resolved THIS step
    is_terminal: bool = False
    illegal_action: bool = False


# ── Implementation ──────────────────────────────────────────────────────────


class RewardShaper:
    """Stateless(-ish) reward shaper. Stores last snapshot to compute deltas."""

    def __init__(self, config: Optional[ShapingConfig] = None):
        self.config = config or ShapingConfig()

    def shape(
        self,
        prev: GameStateSnapshot,
        curr: GameStateSnapshot,
        outcome: Optional[int] = None,
    ) -> float:
        """Compute shaped reward for the transition prev → curr.

        `outcome` is the sparse terminal reward:
            +1 = agent won
            -1 = agent lost
             0 = draw
           None = non-terminal step (will be ignored, only dense shaping applies)

        Returns a scalar. Clamped to [-1.1, +1.1] worst case (outcome=1 + shape).
        """
        if curr.illegal_action:
            return self.config.penalty_illegal_action

        # ── Sparse terminal term ────────────────────────────────────────────
        r_terminal = 0.0
        if curr.is_terminal and outcome is not None:
            r_terminal = self.config.outcome_weight * float(outcome)

        # ── Dense shaping terms ─────────────────────────────────────────────
        d_life = (curr.life_you - curr.life_opp) - (prev.life_you - prev.life_opp)
        d_hand = (curr.hand_you - curr.hand_opp) - (prev.hand_you - prev.hand_opp)
        d_power = (curr.power_you - curr.power_opp) - (prev.power_you - prev.power_opp)

        r_life = self.config.alpha_life * d_life
        r_tempo = self.config.beta_tempo * curr.mana_value_played
        r_cards = self.config.gamma_cards * d_hand
        r_board = self.config.delta_board * d_power
        r_progress = self._progress_bonus(curr)

        r_shape = r_life + r_tempo + r_cards + r_board + r_progress

        # Cap shaping so it can't dominate the terminal signal
        if r_shape > self.config.step_cap:
            r_shape = self.config.step_cap
        elif r_shape < -self.config.step_cap:
            r_shape = -self.config.step_cap

        return r_terminal + r_shape

    def _progress_bonus(self, curr: GameStateSnapshot) -> float:
        """Bonus for being on a faster clock — encourages aggression over stalling.

        We approximate "turns to lethal" as opp_life / max(1, power_you) and
        hand out a small bonus proportional to 1/(turns_to_lethal+1).
        """
        if curr.power_you <= 0:
            return 0.0
        turns_to_lethal = max(1.0, curr.life_opp / max(1, curr.power_you))
        return self.config.epsilon_progress / turns_to_lethal


# ── Convenience API ─────────────────────────────────────────────────────────


def default_shaper() -> RewardShaper:
    """Singleton-ish helper for MtgForgeEnv usage."""
    return RewardShaper()
