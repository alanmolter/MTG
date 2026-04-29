"""
Arena pool resolver — Python mirror of `server/scripts/utils/poolFilter.ts`.

Why this exists
---------------
The Node-side trainers (`teach`, `teach:arena`) read
`TRAINING_POOL_ARENA_ONLY=1` and add `AND is_arena = 1` to their card-pool
SQL. The Ray/IMPALA pipeline lives in Python and never touched that flag, so
running `npm run train:ray` was silently using the *full* paper catalog —
including non-Arena-legal cards baked into the Forge bridge's hardcoded
fallback decks (Snapcaster Mage, Goblin Guide, etc.). See
`server/scripts/utils/poolFilter.ts` for the original contract.

This module gives the Python pipeline the exact same flag and produces a
pair of MTGO-style decklists that Forge's `parseDeck()` can consume. The
Ray orchestrator and smoke envs feed those into `env_config["agent_deck"]`
/ `["opponent_deck"]` so the bridge skips the hardcoded `AggroRed`/`Control`
fallback when Arena-only is requested.

Resolution order for the deck content (tries each, falls through on failure):

    1. DATABASE_URL set + cards table populated with `is_arena=1` rows
       → query the DB and synthesize a 60-card decklist by colour pair.
    2. No DB or query fails / returns 0 rows
       → use a hardcoded Arena-legal fallback (Standard 2026 staples).

The fallback exists because:
  - We never want a smoke test or unit test to silently hit the network.
  - On a clean checkout (no Postgres yet), `forge:smoke:arena` should still
    produce *some* sensible Arena-legal pair instead of crashing.

Usage:
    >>> from ml_engine.ray_cluster.arena_pool import (
    ...     is_arena_only_training, resolve_decks_for_training,
    ... )
    >>> if is_arena_only_training():
    ...     agent, opp = resolve_decks_for_training(arena_only=True)
"""

from __future__ import annotations

import os
import random
import sys
from typing import Optional, Sequence, Tuple

# When DB-backed synthesis falls back, emit a single warning per process so
# the operator sees that the trainers are running on hardcoded decks. Set the
# env var `ARENA_POOL_QUIET=1` to silence (e.g. in tests).
_FALLBACK_WARNED = False


def _warn_fallback(reason: str) -> None:
    """Print a one-shot warning when DB synthesis is unavailable.

    Without this, operators silently get the hardcoded AggroRed/ControlUW
    matchup repeated forever — exactly the failure mode that polluted the
    2026-04-29 Ray run (no deck variance → score plateau at ~1.1).
    """
    global _FALLBACK_WARNED
    if _FALLBACK_WARNED:
        return
    if os.environ.get("ARENA_POOL_QUIET") == "1":
        return
    _FALLBACK_WARNED = True
    msg = (
        f"[arena_pool] WARN: DB synthesis disabled ({reason}). "
        f"Falling back to hardcoded Aggro Red / Control UW decks. "
        f"Set DATABASE_URL + `pip install psycopg2-binary` for varied decks."
    )
    print(msg, file=sys.stderr, flush=True)


# Mirror of TRUTHY_VALUES in server/scripts/utils/poolFilter.ts. Kept in lock
# step on purpose — the two files MUST agree on what counts as truthy or you
# get split-brain behavior between npm scripts and Python entrypoints.
_TRUTHY_VALUES = {"1", "true", "yes", "on"}

_ARENA_ONLY_ENV_VAR = "TRAINING_POOL_ARENA_ONLY"


def is_arena_only_training() -> bool:
    """Return True iff TRAINING_POOL_ARENA_ONLY is truthy.

    Reads the env var at every call so tests / nested subprocesses can
    mutate it freely, matching the TypeScript helper's contract.
    """
    raw = os.environ.get(_ARENA_ONLY_ENV_VAR)
    if not raw:
        return False
    return raw.strip().lower() in _TRUTHY_VALUES


def describe_training_pool() -> str:
    """Human-readable label, matched 1:1 with `describeTrainingPool()` in TS."""
    return "Arena-only" if is_arena_only_training() else "Full catalog"


# ── Hardcoded Arena-legal fallback decks ────────────────────────────────────
#
# These are deliberately Arena-legal Standard staples (rotated as of 2026-04).
# They mirror the *shape* of Forge's `defaultDeckFor("AggroRed")` /
# `defaultDeckFor("Control")` decks — same archetypes, same ~60-card count —
# but every card here is on Arena. The bridge's `parseDeck()` strips set codes
# in parens, so the decklist format is whatever it accepts.
#
# If you change a list, keep the total at exactly 60 (mainboard) — Forge's
# `Match` constructor is fine with smaller decks but RegisteredPlayer will
# refuse to start a tournament-legal game below the minimum.

ARENA_FALLBACK_AGGRO_RED = """
4 Monastery Swiftspear
4 Heartfire Hero
4 Slickshot Show-Off
4 Emberheart Challenger
4 Manifold Mouse
4 Lightning Strike
4 Burst Lightning
4 Play with Fire
4 Bloodthirsty Conqueror
4 Screaming Nemesis
20 Mountain
""".strip()


ARENA_FALLBACK_CONTROL = """
4 Spell Pierce
4 Three Steps Ahead
4 No More Lies
4 Get Lost
4 Abrade
4 Stock Up
4 Beza, the Bounding Spring
2 Hostile Investigator
2 Sheoldred, the Apocalypse
4 Deduce
4 Island
4 Plains
4 Meticulous Archive
4 Restless Anchorage
8 Plains
""".strip()


# ── DB-backed deck synthesis ────────────────────────────────────────────────


# Two-color archetypes we synthesize from the DB. The first two letters of
# `colors` (like "WU", "BR") are matched against the card's `colors` column,
# which the seed pipeline stores as concatenated colour identity letters.
_ARCHETYPE_RECIPES: Tuple[Tuple[str, str, Sequence[str]], ...] = (
    # (archetype_name, primary_colors, basic_lands)
    # Mono-color
    ("aggro_red",       "R",  ("Mountain",)),
    ("aggro_white",     "W",  ("Plains",)),
    ("control_blue",    "U",  ("Island",)),
    ("midrange_black",  "B",  ("Swamp",)),
    ("ramp_green",      "G",  ("Forest",)),
    # Two-color
    ("control_uw",      "WU", ("Island", "Plains")),
    ("midrange_bg",     "BG", ("Swamp", "Forest")),
    ("aggro_rw",        "WR", ("Mountain", "Plains")),
    ("midrange_br",     "BR", ("Swamp", "Mountain")),
    ("control_ub",      "UB", ("Island", "Swamp")),
    ("ramp_gw",         "WG", ("Forest", "Plains")),
    ("aggro_gr",        "GR", ("Mountain", "Forest")),
)


def _build_decklist_from_rows(
    rows: Sequence[Tuple[str, Optional[str]]],
    basics: Sequence[str],
    *,
    nonland_count: int = 24,
    land_count: int = 24,
) -> str:
    """Synthesize an MTGO-style decklist from DB rows.

    rows is [(name, type)]. We keep cards whose type field doesn't contain
    "Land" (basic lands come from the `basics` arg), cap at `nonland_count`
    distinct names with 4-of each, and fill the remainder with basic lands.
    Forge's `parseDeck` is tolerant — it just reads "<count> <name>".

    The total honors `nonland_count + land_count = 48` by default. We pad
    with a 4-of "Llanowar Wastes"-style dual? No — keep it simple: 4-of
    nonlands until we hit nonland_count, then fill with evenly-distributed
    basics. Stays Arena-legal because we only emit names from `rows` (which
    the caller already filtered with `AND is_arena = 1`) plus basics.
    """
    nonlands = [
        name for (name, type_str) in rows
        if name and (type_str is None or "Land" not in (type_str or ""))
    ]
    # Distinct names only — we'll print `4 <name>` for each.
    seen: set[str] = set()
    distinct: list[str] = []
    for n in nonlands:
        if n in seen:
            continue
        seen.add(n)
        distinct.append(n)
        if len(distinct) >= nonland_count // 4:
            break

    if not distinct:
        # No usable non-land rows — caller will get a basics-only deck which
        # Forge will accept but the game will be a slow loss. Better than
        # crashing with an empty deck.
        distinct = []

    lines: list[str] = [f"4 {name}" for name in distinct]
    # Land count: divide land_count across `basics` round-robin.
    if not basics:
        basics = ("Plains",)
    per_basic = max(1, land_count // len(basics))
    remainder = land_count - per_basic * len(basics)
    for i, b in enumerate(basics):
        count = per_basic + (1 if i < remainder else 0)
        lines.append(f"{count} {b}")

    return "\n".join(lines)


def _query_arena_pool(
    primary_colors: str,
    *,
    limit: int = 200,
    dsn: Optional[str] = None,
) -> Sequence[Tuple[str, Optional[str]]]:
    """Pull Arena-legal cards matching the given colour identity.

    Returns [(name, type)] tuples. Falls back to an empty list (NOT raises)
    on any DB failure — the caller will then use the hardcoded fallback.

    We mirror `trainCommander.ts`'s WHERE clause: `is_arena = 1`, `cmc <= 8`,
    plus a colour identity match on the `colors` column.
    """
    dsn = dsn or os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
    if not dsn:
        _warn_fallback("DATABASE_URL not set in this Python process")
        return ()

    try:
        import psycopg2  # noqa: WPS433 — lazy import keeps this module dep-free
    except ImportError:
        _warn_fallback("psycopg2 not installed (run `pip install psycopg2-binary` in the venv)")
        return ()

    # Colour-identity match: colors LIKE '%R%' for mono-red, both letters
    # required for a pair. Using LIKE keeps us compatible with both the
    # comma-style and concat-style colour storage in our cards table.
    color_clauses = " AND ".join(
        f"colors LIKE %s" for _ in primary_colors
    ) if primary_colors else "TRUE"
    color_params = [f"%{c}%" for c in primary_colors]

    sql = f"""
        SELECT name, type
        FROM cards
        WHERE is_arena = 1
          AND ({color_clauses})
          AND (cmc IS NULL OR cmc <= 8)
        ORDER BY RANDOM()
        LIMIT %s
    """

    try:
        conn = psycopg2.connect(dsn, connect_timeout=5)
        conn.autocommit = True
    except Exception as e:
        _warn_fallback(f"psycopg2 connect failed: {e!s}")
        return ()

    try:
        with conn.cursor() as cur:
            cur.execute(sql, [*color_params, int(limit)])
            rows = cur.fetchall()
            if not rows:
                _warn_fallback(
                    f"DB query returned 0 rows for primary_colors={primary_colors!r}; "
                    f"check that cards.is_arena=1 was applied via `npm run db:repair-arena -- --apply`"
                )
            return rows
    except Exception as e:
        _warn_fallback(f"DB query failed: {e!s}")
        return ()
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _archetype_pair_for_seed(seed: Optional[int]) -> Tuple[str, str]:
    """Pick two distinct archetypes for the matchup. Deterministic if seed set."""
    rng = random.Random(seed)
    pair = rng.sample([r[0] for r in _ARCHETYPE_RECIPES], k=2)
    return pair[0], pair[1]


def _archetype_to_recipe(name: str) -> Tuple[str, str, Sequence[str]]:
    for r in _ARCHETYPE_RECIPES:
        if r[0] == name:
            return r
    # Fallback to aggro_red — first recipe.
    return _ARCHETYPE_RECIPES[0]


def resolve_decks_for_training(
    *,
    arena_only: Optional[bool] = None,
    seed: Optional[int] = None,
    dsn: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """Return `(agent_deck, opponent_deck)` for `MtgForgeEnv` config.

    Behavior:
      - `arena_only=False` (or env var unset): returns `(None, None)` so
        Forge's `parseDeck()` falls back to its hardcoded `AggroRed` /
        `Control` paper-Modern decks. Backward compatible.
      - `arena_only=True`: returns two real decklists — one synthesized from
        the DB (Arena-legal, colour-balanced) if reachable, else the
        hardcoded fallback in this module (also Arena-legal).

    Both return values are MTGO-style strings ready for the Java bridge.
    """
    if arena_only is None:
        arena_only = is_arena_only_training()

    if not arena_only:
        return (None, None)

    agent_archetype, opp_archetype = _archetype_pair_for_seed(seed)

    def _build(arche: str) -> str:
        _name, primary, basics = _archetype_to_recipe(arche)
        rows = _query_arena_pool(primary, dsn=dsn)
        if rows:
            return _build_decklist_from_rows(rows, basics)
        # DB unreachable / empty — pick the closest hardcoded fallback by
        # archetype family. Exact matches first; otherwise default to aggro.
        if "aggro" in arche or "red" in arche:
            return ARENA_FALLBACK_AGGRO_RED
        return ARENA_FALLBACK_CONTROL

    return _build(agent_archetype), _build(opp_archetype)


__all__ = [
    "is_arena_only_training",
    "describe_training_pool",
    "resolve_decks_for_training",
    "ARENA_FALLBACK_AGGRO_RED",
    "ARENA_FALLBACK_CONTROL",
]
