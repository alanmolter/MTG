"""
Pillar 7 — Loop Prevention / Toxic Action Detection.

Magic: The Gathering has infinite combos AND infinite *mistakes*. A policy
that loops a Time Stop / Gratuitous Violence cycle indefinitely must be
detected and punished, or training wastes GPU hours grinding a zero-info loop.

Strategy — three-layered:

  1. State-hash counter: after meaningful actions, if the canonical-hash
     (life_totals, battlefield, graveyards, hand_sizes, phase) repeats
     `loop_threshold` times within a window, we flag the last action as toxic.
     Priority passes and other no-op decisions are not evidence of a loop.

  2. Toxic action ledger: persist the state hash and the action that
     repeated it into `toxic_actions` (`action_hash`, `deck_snap`,
     `trigger_reason`, `trigger_count`) so future PBT generations inherit
     the aversion without relearning it.

  3. Policy decorator: `wrap_policy_with_guard` adds a sanity-check that
     refuses any action whose toxic score exceeds a threshold.

The state hash is deterministic and collision-resistant for the scope of a
single game (SHA1 over a stable JSON serialization of the state).
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Mapping, Optional, Tuple


# ── Config ──────────────────────────────────────────────────────────────────


@dataclass
class LoopGuardConfig:
    loop_threshold: int = 3          # same state seen >= 3 times = loop
    window_size: int = 50            # number of recent states to track
    toxic_penalty: float = -2.0      # strong negative reward when loop detected
    flush_every_n: int = 500         # persist toxic ledger to DB every N detections
    max_action_history: int = 200    # for credit assignment back to the action


# ── Data classes ────────────────────────────────────────────────────────────


@dataclass
class ToxicAction:
    """One entry for the persistent toxic_actions table."""
    card_id: Optional[int]
    action_type: str
    context_hash: str
    turn: int
    detected_count: int = 1


@dataclass
class LoopState:
    """Per-game loop tracker. One instance per MtgForgeEnv episode."""
    state_counts: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    state_window: Deque[str] = field(default_factory=lambda: deque(maxlen=50))
    action_history: Deque[Mapping[str, Any]] = field(default_factory=lambda: deque(maxlen=200))
    action_sequence: int = 0
    observed_action_sequence: int = 0
    flagged: bool = False
    flagged_action: Optional[Mapping[str, Any]] = None


# ── Implementation ──────────────────────────────────────────────────────────


# Keys ForgeRLBridge.buildSnapshot emits for this hash. mana_pool_* is present
# in that payload but currently hardcoded to 0, so a mana-only change does not
# move the hash until the bridge reports the real pool. Phase, battlefield
# counts, power and land counts do.
_HASH_FIELDS = (
    "turn",
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
)


def _loop_view(state: Mapping[str, Any]) -> Dict[str, Any]:
    """Project a bridge payload onto the loop-hash fields.

    Prefer the flat keys the Java bridge writes. When an older payload only
    has the nested ``you`` / ``opp`` blocks or a ``phase`` string, fill the
    same slots from those aliases so the hash does not collapse to whatever
    subset happened to be present.
    """

    view: Dict[str, Any] = {key: state[key] for key in _HASH_FIELDS if key in state}
    you = state.get("you") if isinstance(state.get("you"), Mapping) else {}
    opp = state.get("opp") if isinstance(state.get("opp"), Mapping) else {}
    aliases = {
        "turn_phase": state.get("phase", state.get("turn_phase")),
        "life_you": you.get("life"),
        "life_opp": opp.get("life"),
        "hand_you_size": you.get("hand_size"),
        "hand_opp_size": opp.get("hand_size"),
        "graveyard_you_size": you.get("graveyard_size"),
        "graveyard_opp_size": opp.get("graveyard_size"),
        "mana_pool_you": you.get("mana_pool_total"),
        "mana_pool_opp": opp.get("mana_pool_total"),
    }
    for key, value in aliases.items():
        if key not in view and value is not None:
            view[key] = value
    if "battlefield_you" not in view or "lands_you" not in view:
        lands_you, lands_opp, bf_you, bf_opp = _battlefield_counts(state)
        if "battlefield_you" not in view and bf_you is not None:
            view["battlefield_you"] = bf_you
        if "battlefield_opp" not in view and bf_opp is not None:
            view["battlefield_opp"] = bf_opp
        if "lands_you" not in view and lands_you is not None:
            view["lands_you"] = lands_you
        if "lands_opp" not in view and lands_opp is not None:
            view["lands_opp"] = lands_opp
    return view


def _battlefield_counts(state: Mapping[str, Any]) -> Tuple[Optional[int], Optional[int], Optional[int], Optional[int]]:
    cards = state.get("cards")
    if not isinstance(cards, list):
        return None, None, None, None
    lands_you = lands_opp = bf_you = bf_opp = 0
    saw_controller = False
    for card in cards:
        if not isinstance(card, Mapping):
            continue
        zone = str(card.get("zone", "battlefield"))
        if zone != "battlefield":
            continue
        controller = card.get("controller")
        if controller is not None:
            saw_controller = True
        is_you = controller in (None, "you")
        if is_you:
            bf_you += 1
            if card.get("is_land"):
                lands_you += 1
        elif controller == "opp":
            bf_opp += 1
            if card.get("is_land"):
                lands_opp += 1
    if not saw_controller:
        return lands_you, None, bf_you, None
    return lands_you, lands_opp, bf_you, bf_opp


def canonical_state_hash(state: Mapping[str, Any]) -> str:
    """Deterministic hash over the loop-relevant slice of a game state.

    Key order does not matter. Priority passes and other transient keys are
    not part of the projection.
    """

    blob = json.dumps(_loop_view(state), sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha1(blob).hexdigest()


class LoopGuard:
    """Detect loops within a single episode. One instance per env."""

    def __init__(self, config: Optional[LoopGuardConfig] = None):
        self.config = config or LoopGuardConfig()
        self._loop_state = LoopState(
            state_window=deque(maxlen=self.config.window_size),
            action_history=deque(maxlen=self.config.max_action_history),
        )
        self._toxic_pending: List[ToxicAction] = []

    def reset(self) -> None:
        """Call at the start of a new episode."""
        self._loop_state = LoopState(
            state_window=deque(maxlen=self.config.window_size),
            action_history=deque(maxlen=self.config.max_action_history),
        )

    def record_action(self, action: Mapping[str, Any]) -> None:
        """Append an action to the rolling history. Use before observe()."""
        self._loop_state.action_history.append(action)
        self._loop_state.action_sequence += 1

    def observe(self, state: Mapping[str, Any]) -> Tuple[bool, Optional[ToxicAction]]:
        """Record a state and check for loops.

        Returns:
            (is_loop, toxic_action_or_None)
            is_loop = True means terminate episode with toxic_penalty.
        """
        tracker = self._loop_state
        # Forge may issue several legitimate priority/target callbacks without
        # changing any of the fields in canonical_state_hash. Only a fresh,
        # meaningful action can provide evidence that the policy is looping.
        if tracker.observed_action_sequence == tracker.action_sequence:
            return False, None
        tracker.observed_action_sequence = tracker.action_sequence
        latest_action = tracker.action_history[-1]
        if latest_action.get("type") in ("pass", "priority", "noop"):
            return False, None

        state_hash = canonical_state_hash(state)

        # Trim oldest state from the counter if our window is full
        if len(self._loop_state.state_window) == self.config.window_size:
            old = self._loop_state.state_window[0]
            self._loop_state.state_counts[old] -= 1
            if self._loop_state.state_counts[old] <= 0:
                del self._loop_state.state_counts[old]

        self._loop_state.state_window.append(state_hash)
        self._loop_state.state_counts[state_hash] += 1

        count = self._loop_state.state_counts[state_hash]
        if count >= self.config.loop_threshold and not self._loop_state.flagged:
            action = self._last_meaningful_action()
            toxic = ToxicAction(
                card_id=(action or {}).get("card_id") if action else None,
                action_type=(action or {}).get("type", "unknown") if action else "unknown",
                context_hash=state_hash,
                turn=state.get("turn", 0),
                detected_count=count,
            )
            self._loop_state.flagged = True
            self._loop_state.flagged_action = action
            self._toxic_pending.append(toxic)
            return True, toxic

        return False, None

    def is_flagged(self) -> bool:
        return self._loop_state.flagged

    def _last_meaningful_action(self) -> Optional[Mapping[str, Any]]:
        """Walk action_history back and return the last action that wasn't a pass."""
        for a in reversed(self._loop_state.action_history):
            if a.get("type") not in ("pass", "priority", "noop"):
                return a
        return self._loop_state.action_history[-1] if self._loop_state.action_history else None

    # ── DB persistence ──────────────────────────────────────────────────────

    def pending_toxic(self) -> List[ToxicAction]:
        """Return toxic actions not yet persisted to DB."""
        return list(self._toxic_pending)

    def clear_pending(self) -> None:
        self._toxic_pending.clear()

    def flush_to_db(self, conn) -> int:
        """UPSERT pending loops into ``toxic_actions``.

        The live table (``drizzle/0005_endgame_pgvector.sql``) is::

            toxic_actions (
                action_hash VARCHAR(64) UNIQUE,
                deck_snap JSONB NOT NULL,
                trigger_reason VARCHAR(64) NOT NULL,
                trigger_count INTEGER NOT NULL DEFAULT 1,
                first_seen_at / last_seen_at TIMESTAMPTZ
            )

        ``action_hash`` is the canonical state hash. The action that was
        repeating lives in ``deck_snap``. ``trigger_reason`` is
        ``STATE_REPEATED`` because that is the loop this guard detects.

        Returns number of rows written.
        """
        if not self._toxic_pending:
            return 0

        rows = []
        for toxic in self._toxic_pending:
            snap = json.dumps({
                "card_id": toxic.card_id,
                "action_type": toxic.action_type,
                "turn": toxic.turn,
                "context_hash": toxic.context_hash,
            })
            rows.append((toxic.context_hash, snap, "STATE_REPEATED", toxic.detected_count))
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO toxic_actions (
                    action_hash, deck_snap, trigger_reason, trigger_count,
                    first_seen_at, last_seen_at
                )
                VALUES (%s, %s::jsonb, %s, %s, NOW(), NOW())
                ON CONFLICT (action_hash) DO UPDATE SET
                    trigger_count = toxic_actions.trigger_count + EXCLUDED.trigger_count,
                    deck_snap = EXCLUDED.deck_snap,
                    last_seen_at = NOW()
                """,
                rows,
            )
        conn.commit()
        written = len(self._toxic_pending)
        self.clear_pending()
        return written


# ── Policy wrapper ──────────────────────────────────────────────────────────


def wrap_policy_with_guard(policy_fn, toxic_lookup, toxic_score_threshold: float = 0.8):
    """Decorator: given a policy function, refuse actions whose toxic score
    exceeds the threshold (sample next-best instead).

    `policy_fn(state) -> List[(action, probability)]` — returns ranked actions
    `toxic_lookup(action, state) -> float in [0, 1]` — 0 = safe, 1 = confirmed toxic
    """
    def guarded(state):
        ranked = policy_fn(state)
        for action, prob in ranked:
            if toxic_lookup(action, state) < toxic_score_threshold:
                return action, prob
        # Fallback: return the least-toxic available action
        return ranked[-1] if ranked else (None, 0.0)

    return guarded
