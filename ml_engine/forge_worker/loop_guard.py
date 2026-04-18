"""
Pillar 7 — Loop Prevention / Toxic Action Detection.

Magic: The Gathering has infinite combos AND infinite *mistakes*. A policy
that loops a Time Stop / Gratuitous Violence cycle indefinitely must be
detected and punished, or training wastes GPU hours grinding a zero-info loop.

Strategy — three-layered:

  1. State-hash counter: if the canonical-hash (life_totals, battlefield,
     graveyards, hand_sizes, phase) repeats >`loop_threshold` times within
     a window, we flag the last action as toxic and terminate the game with
     a strong negative reward.

  2. Toxic action ledger: persist (card_id, action_type, context_hash) →
     `toxic_actions` table so future PBT generations inherit the aversion
     without relearning it.

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
    flagged: bool = False
    flagged_action: Optional[Mapping[str, Any]] = None


# ── Implementation ──────────────────────────────────────────────────────────


def canonical_state_hash(state: Mapping[str, Any]) -> str:
    """Deterministic, stable hash over a game state.

    The dict keys are sorted so {a:1,b:2} and {b:2,a:1} hash identically.
    Only includes fields that matter for loop detection — we ignore e.g.
    priority passes or stack-depth changes that are transient.
    """
    keyset = {
        "turn_phase", "life_you", "life_opp",
        "battlefield_you", "battlefield_opp",
        "hand_you_size", "hand_opp_size",
        "graveyard_you_size", "graveyard_opp_size",
        "mana_pool_you", "mana_pool_opp",
    }
    filtered = {k: state[k] for k in state.keys() if k in keyset}
    blob = json.dumps(filtered, sort_keys=True, default=str).encode("utf-8")
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

    def observe(self, state: Mapping[str, Any]) -> Tuple[bool, Optional[ToxicAction]]:
        """Record a state and check for loops.

        Returns:
            (is_loop, toxic_action_or_None)
            is_loop = True means terminate episode with toxic_penalty.
        """
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
        """UPSERT all pending toxic actions to the `toxic_actions` table.

        Schema (from 0005_endgame_pgvector.sql):
            toxic_actions (
                id BIGSERIAL PK,
                card_id INT, action_type TEXT, context_hash TEXT,
                turn_detected INT, detected_count INT,
                first_seen_at TIMESTAMP, last_seen_at TIMESTAMP,
                UNIQUE(card_id, action_type, context_hash)
            )

        Returns number of rows written.
        """
        if not self._toxic_pending:
            return 0

        rows = [
            (t.card_id, t.action_type, t.context_hash, t.turn, t.detected_count)
            for t in self._toxic_pending
        ]
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO toxic_actions (
                    card_id, action_type, context_hash, turn_detected,
                    detected_count, first_seen_at, last_seen_at
                )
                VALUES (%s, %s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (card_id, action_type, context_hash) DO UPDATE SET
                    detected_count = toxic_actions.detected_count + EXCLUDED.detected_count,
                    last_seen_at   = NOW()
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
