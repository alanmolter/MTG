"""Map a Forge AI decision onto the Discrete(512) action contract.

A decision is mappable when ``chosen_action`` is an integer slot whose mask
bit is set. Anything else (missing field, negative slot, illegal slot) is
unmappable and must be counted, not trained on.
"""

from __future__ import annotations

from typing import Any, Mapping


def mapped_action(state: Mapping[str, Any], *, num_actions: int = 512) -> int | None:
    """Return the legal action index, or None when this decision cannot be used."""

    raw = state.get("chosen_action")
    if isinstance(raw, bool) or not isinstance(raw, int):
        return None
    if raw < 0 or raw >= num_actions:
        return None
    mask = state.get("action_mask")
    if not isinstance(mask, (list, tuple)) or len(mask) != num_actions:
        return None
    bit = mask[raw]
    if isinstance(bit, bool) or not isinstance(bit, int) or int(bit) not in (0, 1):
        return None
    if int(bit) != 1:
        return None
    return raw


def decision_counts(states: list[Mapping[str, Any]], *, num_actions: int = 512) -> dict[str, int]:
    mapped = sum(mapped_action(state, num_actions=num_actions) is not None for state in states)
    total = len(states)
    return {
        "decisions": total,
        "mapped": mapped,
        "unmappable": total - mapped,
    }


def unmappable_rate(counts: Mapping[str, int]) -> float:
    total = int(counts.get("decisions") or 0)
    if total <= 0:
        return 0.0
    return int(counts.get("unmappable") or 0) / total
