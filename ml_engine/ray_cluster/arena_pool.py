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

Deck content, when arena-only training is on:

    The versioned file pool in ``deck_pool`` (official Challenger Deck lists).
    Training samples the train split. Evaluation samples the holdout split.
    There is no random ``ORDER BY RANDOM()`` deck. ``_build_decklist_from_rows``
    remains for tests; nothing in the training path calls it, and
    ``gated_db_decklist`` drops any list that fails ``deck_quality``.

Usage:
    >>> from ml_engine.ray_cluster.arena_pool import (
    ...     is_arena_only_training, resolve_decks_for_training,
    ... )
    >>> if is_arena_only_training():
    ...     agent, opp = resolve_decks_for_training(arena_only=True)
"""

from __future__ import annotations

import os
import sys
from typing import Optional, Sequence, Tuple

from ml_engine.ray_cluster.deck_pool import (
    accept_deck,
    deck_by_archetype_id,
    sample_pair,
    training_archetype_ids,
)

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
        f"[arena_pool] WARN: Arena card query failed ({reason}). "
        f"Training does not use this query; it samples the versioned deck pool."
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


# Public aliases for the two curriculum decks tests and smoke entrypoints
# already import. They are pool lists, not a second hand-written fallback.
ARENA_FALLBACK_AGGRO_RED = deck_by_archetype_id("aggro_red").forge_list
ARENA_FALLBACK_CONTROL = deck_by_archetype_id("control_uw").forge_list


# ── DB-backed deck synthesis ────────────────────────────────────────────────
#
# Not a training source. ``resolve_decks_for_training`` samples the file pool.
# ``gated_db_decklist`` is the only supported way to turn rows into a deck,
# and it rejects lists that fail the quality gate.


def _build_decklist_from_rows(
    rows: Sequence[Tuple[str, Optional[str]]],
    basics: Sequence[str],
    *,
    nonland_count: int = 36,
    land_count: int = 24,
) -> str:
    """Synthesize an MTGO-style decklist from DB rows.

    rows is [(name, type)]. We keep cards whose type field doesn't contain
    "Land" (basic lands come from the `basics` arg), cap at `nonland_count`
    distinct names with 4-of each, and fill the remainder with basic lands.
    Forge's `parseDeck` is tolerant — it just reads "<count> <name>".

    Defaults total = 36 nonland + 24 land = 60 cards (Standard/Arena legal
    minimum). Was 48 originally — RegisteredPlayer in Forge accepts <60 but
    the meta benchmarks always run 60-card decks, so smaller training decks
    skew matchup variance. Bumped to 60 in the Arena curriculum revision.
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
    # A sparse / partially imported DB may not have enough legal spells for a
    # recipe. Keep the deck tournament-sized anyway: replace each missing
    # spell slot with a basic land rather than handing Forge an underfilled
    # deck that cannot represent normal Arena games.
    missing_spell_slots = max(0, nonland_count - (len(distinct) * 4))
    total_land_count = land_count + missing_spell_slots
    # Land count: divide total_land_count across `basics` round-robin.
    if not basics:
        basics = ("Plains",)
    per_basic = max(1, total_land_count // len(basics))
    remainder = total_land_count - per_basic * len(basics)
    for i, b in enumerate(basics):
        count = per_basic + (1 if i < remainder else 0)
        lines.append(f"{count} {b}")

    return "\n".join(lines)


def gated_db_decklist(
    rows: Sequence[Tuple[str, Optional[str]]],
    basics: Sequence[str],
    *,
    deck_id: str = "db_synthesis",
    nonland_count: int = 36,
    land_count: int = 24,
) -> Optional[str]:
    """Build a deck from rows and return it only if the quality gate passes.

    Training does not call this. A random 4-of pile fails the gate and comes
    back as None, with the reason logged by ``accept_deck``.
    """

    decklist = _build_decklist_from_rows(
        rows, basics, nonland_count=nonland_count, land_count=land_count
    )
    if accept_deck(deck_id, decklist):
        return decklist
    return None


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

    # Colour-identity SUBSET match: card.colors must be a subset of the
    # archetype's primary_colors. Old behaviour used LIKE '%X%' which let any
    # card *containing* the colour through, so a `control_blue` deck got
    # 5-colour cards like `Bring to Light` and was unplayable in Forge —
    # poisoning the training reward signal with deadlocked games. See the
    # 2026-05-07 postmortem on `python -c "...resolve_decks_for_training..."`.
    #
    # Strategy: enumerate the colours forbidden by this archetype (WUBRG
    # minus primary_colors) and require that none of them appear in the
    # card's `colors` field. Colourless cards (NULL or empty) are always
    # allowed — they fit any deck. We don't enforce that the card contains
    # at least one of the allowed colours, because the artifact density in
    # Standard is low (~5%) and adding utility artifacts/equipment is fine.
    _ALL_COLOURS = ("W", "U", "B", "R", "G")
    primary_set = set((primary_colors or "").upper())
    forbidden = [c for c in _ALL_COLOURS if c not in primary_set]
    if forbidden:
        forbid_clauses = " AND ".join("colors NOT LIKE %s" for _ in forbidden)
        forbid_params = [f"%{c}%" for c in forbidden]
        colour_filter = (
            "(colors IS NULL OR colors = '' OR ("
            + forbid_clauses
            + "))"
        )
    else:
        # Five-colour archetype (not currently used) — accept any card.
        colour_filter = "TRUE"
        forbid_params = []

    sql = f"""
        SELECT name, type
        FROM cards
        WHERE is_arena = 1
          AND {colour_filter}
          AND (cmc IS NULL OR cmc <= 8)
        ORDER BY RANDOM()
        LIMIT %s
    """
    color_params = forbid_params

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


_ARCHETYPE_FILTER_ENV_VAR = "TRAINING_ARCHETYPES"


def _archetype_allowlist() -> Optional[Tuple[str, ...]]:
    """Return the operator-configured archetype subset, or None for all 15.

    Honors `TRAINING_ARCHETYPES=aggro_red,control_uw,combo_ur`. Unknown names
    are dropped (warned). Empty / unset → the full train split. Holdout ids
    are not valid here.
    Used for curriculum: shrink the matchup space early, expand later.
    """
    raw = os.environ.get(_ARCHETYPE_FILTER_ENV_VAR)
    if not raw:
        return None
    requested = [s.strip().lower() for s in raw.split(",") if s.strip()]
    if not requested:
        return None
    valid = set(training_archetype_ids())
    # Deduplicate before sampling. Without this, a value such as
    # "aggro_red,aggro_red" has two list entries and random.sample can choose
    # the same deck twice, creating an accidental self-play-only curriculum.
    kept = tuple(dict.fromkeys(name for name in requested if name in valid))
    dropped = [name for name in requested if name not in valid]
    if dropped:
        print(
            f"[arena_pool] WARN: ignoring unknown archetypes {dropped!r}; "
            f"valid options: {sorted(valid)}",
            file=sys.stderr,
            flush=True,
        )
    if len(kept) < 2:
        print(
            f"[arena_pool] WARN: TRAINING_ARCHETYPES needs >=2 valid names; "
            f"got {kept!r}, falling back to the full training deck pool.",
            file=sys.stderr,
            flush=True,
        )
        return None
    return kept


def _training_pair(seed: Optional[int]):
    """Two distinct train-split decks. Holdout lists are not eligible."""

    return sample_pair("train", seed, archetype_ids=_archetype_allowlist())


def _archetype_pair_for_seed(seed: Optional[int]) -> Tuple[str, str]:
    """Pick two distinct archetype ids. Deterministic if seed is set.

    ``TRAINING_ARCHETYPES`` restricts the train split (curriculum). The ids
    are the pool's ``archetype_id`` values, such as ``aggro_red`` and
    ``control_uw``.
    """

    agent, opponent = _training_pair(seed)
    return agent.archetype_id, opponent.archetype_id


def resolve_training_matchup(
    *,
    arena_only: Optional[bool] = None,
    seed: Optional[int] = None,
    dsn: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str], str, str]:
    """Return `(agent_deck, opponent_deck, agent_archetype, opponent_archetype)`.

    Archetype ids are pool ids (``control_uw``, ``aggro_red``, ...). They are
    empty strings when arena rotation is off. The reward shaper uses the
    agent id so a control deck is recognized as control. ``dsn`` is ignored:
    training does not query Postgres for decks.
    """

    del dsn  # training decks come from the file pool, not the database
    if arena_only is None:
        arena_only = is_arena_only_training()
    if not arena_only:
        return None, None, "", ""
    agent, opponent = _training_pair(seed)
    return agent.forge_list, opponent.forge_list, agent.archetype_id, opponent.archetype_id


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
      - `arena_only=True`: returns two mainboards from the train split of the
        versioned deck pool. Both already passed the quality gate.

    Both return values are ``<count> <name>`` strings ready for the Java bridge.
    """

    agent, opponent, _agent_archetype, _opponent_archetype = resolve_training_matchup(
        arena_only=arena_only, seed=seed, dsn=dsn
    )
    return agent, opponent


__all__ = [
    "is_arena_only_training",
    "describe_training_pool",
    "resolve_decks_for_training",
    "resolve_training_matchup",
    "ARENA_FALLBACK_AGGRO_RED",
    "ARENA_FALLBACK_CONTROL",
    "gated_db_decklist",
]
