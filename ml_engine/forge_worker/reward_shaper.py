"""
Pillar 6 — Dense Reward Shaping.

The Forge sparse reward (+1 win / -1 loss at game end) is correct but lousy to
learn from: early in training, an agent picks random moves for 20 turns before
getting any signal at all. Dense shaping hands out small, bounded rewards on
every transition so gradients start flowing from turn 1.

Terms (all normalized, caps at ±0.1 per turn):

    r_total = r_outcome                        # {-1, 0, +1} at game end
            + α * Δlife_advantage              # you - opponent, per turn
            + ζ * mana_efficiency              # mana_used / mana_available (anti-flood)
            + γ * Δcard_advantage              # cards in hand, you - opponent
            + δ * Δboard_control                # power on battlefield, you - opp
            + ε * turn_progression_bonus        # converge toward win condition
            + archetype_modifier                # e.g. control gets +bonus for
                                                 #      passing turn with mana+instants

Weights are conservative: even if all dense terms accidentally align they
produce |r_shape| ≤ 0.5, leaving r_outcome dominant. Paper reference:
Ng, Harada & Russell 1999, "Policy invariance under reward transformations" —
potential-based shaping theorem.

Phase 1 (Quick-Win): replaced raw mana tempo (`beta_tempo * mana_value_played`)
with *mana efficiency* (`zeta_efficiency * used/available`). Premia o agente
por **gastar bem o mana disponível**, não apenas por soltar cartas caras. O
modificador `control_mana_open_bonus` dá um micro-reforço para arquétipos
control que passam o turno com mana aberta + instants na mão (jogo reativo).

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

from dataclasses import dataclass
from typing import Optional


# ── Config ──────────────────────────────────────────────────────────────────


@dataclass
class ShapingConfig:
    """Reward weights. Tuned on 1000 games vs random opponent."""
    alpha_life: float = 0.02        # per 1 life advantage swing
    # NOTE: beta_tempo kept for backward-compat but deprecated. Prefer
    # zeta_efficiency below, which uses mana_used/mana_available ratio.
    beta_tempo: float = 0.0         # (deprecated; retained so tests using it
                                    #  explicitly still compile / run)
    gamma_cards: float = 0.03       # per 1 card advantage
    delta_board: float = 0.015      # per 1 total power on battlefield
    epsilon_progress: float = 0.005  # per turn closer to lethal

    # ── Phase 1 additions ───────────────────────────────────────────────
    zeta_efficiency: float = 0.03           # per unit mana efficiency (0..1)
    control_mana_open_bonus: float = 0.015  # added when control passes turn
                                            #   with untapped lands + instants

    outcome_weight: float = 1.0     # sparse terminal (+1 / -1)
    step_cap: float = 0.1           # cap on per-step shaped reward magnitude
    penalty_illegal_action: float = -0.05


@dataclass
class GameStateSnapshot:
    """Minimal subset of game state needed for shaped reward.

    Forge exposes these via its Java API; MtgForgeEnv serializes them into
    this dataclass before passing to shape().

    Phase 1 adds fields used by the new efficiency + archetype shaping. All
    new fields carry sane defaults so older call-sites keep compiling.
    """
    turn: int
    life_you: int
    life_opp: int
    hand_you: int
    hand_opp: int
    power_you: int     # sum of power of creatures you control
    power_opp: int
    mana_value_played: int  # sum of CMC resolved THIS step

    # ── Phase 1 fields ──────────────────────────────────────────────────
    mana_available_you: int = 0     # total mana that *could* have been spent this turn
    untapped_lands_you: int = 0     # untapped lands at end-of-turn snapshot
    instants_in_hand_you: int = 0   # instants (or flash) in hand
    archetype: str = ""             # "aggro" | "control" | "midrange" | "combo" | "ramp"
    turn_ended: bool = False        # true iff this snapshot is end-of-turn

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
        # Legacy tempo term (kept at 0.0 by default so efficiency dominates).
        r_tempo = self.config.beta_tempo * curr.mana_value_played
        r_cards = self.config.gamma_cards * d_hand
        r_board = self.config.delta_board * d_power
        r_progress = self._progress_bonus(curr)
        r_efficiency = self._mana_efficiency_bonus(curr)
        r_archetype = self._archetype_modifier(curr)

        r_shape = (
            r_life + r_tempo + r_cards + r_board
            + r_progress + r_efficiency + r_archetype
        )

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

    def _mana_efficiency_bonus(self, curr: GameStateSnapshot) -> float:
        """Reward **using the mana you had**, not just casting expensive cards.

        efficiency = mana_value_played / max(1, mana_available_you)
                   ∈ [0, 1+]  (capped implicitly by step_cap)

        - Full use of 4 available mana → bonus ≈ zeta_efficiency
        - Floating 3 of 4 mana → bonus ≈ zeta_efficiency * 0.25
        - No mana_available info → falls back to 0 (no spurious reward)
        """
        avail = max(0, curr.mana_available_you)
        if avail <= 0:
            return 0.0
        used = max(0, curr.mana_value_played)
        # Clamp ratio at 1.0 — over-casting (rituals etc.) shouldn't inflate
        efficiency = min(1.0, used / float(avail))
        return self.config.zeta_efficiency * efficiency

    def _archetype_modifier(self, curr: GameStateSnapshot) -> float:
        """Archetype-specific micro-rewards.

        control: +control_mana_open_bonus at end-of-turn if the agent passed
                 with ≥2 untapped lands AND ≥1 instant in hand. Teaches the
                 "pass with mana open" concept without hard-coding a play.
        """
        if not curr.turn_ended:
            return 0.0
        archetype = (curr.archetype or "").strip().lower()
        if archetype == "control":
            if curr.untapped_lands_you >= 2 and curr.instants_in_hand_you >= 1:
                return self.config.control_mana_open_bonus
        return 0.0


# ── Convenience API ─────────────────────────────────────────────────────────


def default_shaper() -> RewardShaper:
    """Singleton-ish helper for MtgForgeEnv usage."""
    return RewardShaper()
