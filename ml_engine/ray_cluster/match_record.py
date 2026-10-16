"""Write one ``forge_matches`` row with deck, seed, and policy provenance.

The table is optional at runtime. When ``DATABASE_URL`` is unset, or
``FORGE_MATCH_RECORD=0``, nothing is written. A database error is logged by
the caller; this function raises so the caller can decide.
"""

from __future__ import annotations

import os
from typing import Any, Optional


INSERT_FORGE_MATCH = """
INSERT INTO forge_matches (
    winner, turns, agent_deck_id, opponent_deck_id, seed,
    policy_version, pool_version, bridge_version
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
"""


def forge_match_params(
    *,
    agent_deck_id: Optional[str],
    opponent_deck_id: Optional[str],
    seed: Any,
    policy_version: Optional[str],
    pool_version: Optional[str],
    bridge_version: Optional[str],
    winner: Any = None,
    turns: Any = None,
) -> tuple:
    def _text(value: Any) -> Optional[str]:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    def _int(value: Any) -> Optional[int]:
        if value is None or value == "":
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    return (
        _int(winner),
        _int(turns),
        _text(agent_deck_id),
        _text(opponent_deck_id),
        _int(seed),
        _text(policy_version),
        _text(pool_version),
        _text(bridge_version),
    )


def maybe_record_forge_match(**kwargs: Any) -> bool:
    if os.environ.get("FORGE_MATCH_RECORD", "1") == "0":
        return False
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return False
    import psycopg2

    params = forge_match_params(**kwargs)
    with psycopg2.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(INSERT_FORGE_MATCH, params)
        conn.commit()
    return True
