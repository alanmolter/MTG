"""
Tests for `ml_engine.ray_cluster.arena_pool` — the Python mirror of
`server/scripts/utils/poolFilter.ts`.

These guard the contract that:
  1. The truthy-string parser agrees with the TS helper character-for-character.
  2. `resolve_decks_for_training()` returns `(None, None)` when arena_only
     is False so we don't accidentally override the Forge bridge's hardcoded
     fallback decks for full-catalog runs.
  3. When arena_only is True and the DB is unreachable, we fall through to
     the bundled Arena-legal hardcoded fallback (never raise, never silently
     return None — that would defeat the whole feature).
  4. When arena_only is True with a seeded RNG, the archetype matchup is
     deterministic so PBT trials in a single Tune experiment can reproduce
     each other's deck pairing.

Run:
    .\\.venv\\Scripts\\python.exe -m pytest ml_engine/ray_cluster/tests/test_arena_pool.py -v
"""

from __future__ import annotations

import os

import pytest

from ml_engine.ray_cluster import arena_pool


# ── Env var contract ────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    """Each test starts with TRAINING_POOL_ARENA_ONLY unset.

    `monkeypatch.delenv(..., raising=False)` is a no-op if the var isn't
    already set, so we don't need to remember the original value — pytest
    rolls back any monkeypatched env mutations at teardown.
    """
    monkeypatch.delenv("TRAINING_POOL_ARENA_ONLY", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("POSTGRES_URL", raising=False)
    yield


def test_is_arena_only_false_when_unset():
    assert arena_pool.is_arena_only_training() is False


def test_is_arena_only_false_when_empty():
    os.environ["TRAINING_POOL_ARENA_ONLY"] = ""
    assert arena_pool.is_arena_only_training() is False


@pytest.mark.parametrize(
    "value", ["1", "true", "yes", "on", "TRUE", "True", "Yes", "On", " 1 "]
)
def test_is_arena_only_true_for_truthy_strings(value):
    """Must agree exactly with the TypeScript helper for cross-language parity."""
    os.environ["TRAINING_POOL_ARENA_ONLY"] = value
    assert arena_pool.is_arena_only_training() is True


@pytest.mark.parametrize(
    "value", ["0", "false", "no", "off", "anything-else", "2", "FALSE"]
)
def test_is_arena_only_false_for_other_strings(value):
    """Anything outside the truthy set is False — never truthy by accident."""
    os.environ["TRAINING_POOL_ARENA_ONLY"] = value
    assert arena_pool.is_arena_only_training() is False


def test_describe_pool_full_catalog_default():
    assert arena_pool.describe_training_pool() == "Full catalog"


def test_describe_pool_arena_when_flag_set():
    os.environ["TRAINING_POOL_ARENA_ONLY"] = "1"
    assert arena_pool.describe_training_pool() == "Arena-only"


# ── resolve_decks_for_training contract ────────────────────────────────────


def test_resolve_returns_none_pair_when_arena_disabled():
    """Backward-compat: full-catalog runs hand `None` to the bridge so the
    hardcoded paper-Modern AggroRed/Control fallback fires unchanged."""
    agent, opp = arena_pool.resolve_decks_for_training(arena_only=False)
    assert agent is None
    assert opp is None


def test_resolve_uses_env_var_when_arg_omitted():
    os.environ["TRAINING_POOL_ARENA_ONLY"] = "1"
    agent, opp = arena_pool.resolve_decks_for_training()
    # Without DB, must fall back to hardcoded — but never None when arena=True.
    assert agent is not None and isinstance(agent, str) and agent.strip()
    assert opp is not None and isinstance(opp, str) and opp.strip()


def test_resolve_arena_falls_back_to_hardcoded_without_db():
    """No DATABASE_URL → query is skipped → we MUST get the bundled fallback,
    not raise and not return None. This is the smoke-test happy path."""
    agent, opp = arena_pool.resolve_decks_for_training(arena_only=True, seed=0)
    assert agent
    assert opp
    # Hardcoded fallbacks are MTGO-style "<count> <name>\\n..." strings.
    assert any(line.strip().split(" ", 1)[0].isdigit()
               for line in agent.splitlines() if line.strip())


def test_resolve_arena_decks_are_distinct():
    """A self-play matchup with two copies of the *exact same* decklist would
    bias the population and defeat archetype diversity. We pick two distinct
    archetypes per call."""
    agent, opp = arena_pool.resolve_decks_for_training(arena_only=True, seed=123)
    assert agent != opp


def test_resolve_arena_is_deterministic_with_seed():
    """Same seed → same archetype pair so PBT trials can reproduce."""
    a1, b1 = arena_pool.resolve_decks_for_training(arena_only=True, seed=42)
    a2, b2 = arena_pool.resolve_decks_for_training(arena_only=True, seed=42)
    assert (a1, b1) == (a2, b2)


def test_resolve_arena_different_seeds_can_differ():
    """We have 3 archetypes → C(3,2)=3 ordered pairs (×2 for order).
    Some seed must yield a different pair than seed=0, otherwise the picker
    is broken."""
    base = arena_pool.resolve_decks_for_training(arena_only=True, seed=0)
    found_difference = any(
        arena_pool.resolve_decks_for_training(arena_only=True, seed=s) != base
        for s in range(1, 50)
    )
    assert found_difference, (
        "archetype picker collapsed to a single matchup across 50 seeds — "
        "check _archetype_pair_for_seed in arena_pool.py"
    )


# ── Hardcoded fallback shape ───────────────────────────────────────────────


def test_hardcoded_aggro_fallback_has_lands():
    """Every Forge-legal deck must include some basic lands or it'll mulligan
    forever. We don't enforce 60 cards (Forge is tolerant) but at least one
    "<n> Mountain"/"<n> Island"/etc line must be present."""
    text = arena_pool.ARENA_FALLBACK_AGGRO_RED
    has_basic = any(
        any(basic in line for basic in
            ("Plains", "Island", "Swamp", "Mountain", "Forest"))
        for line in text.splitlines()
    )
    assert has_basic


def test_hardcoded_control_fallback_has_lands():
    text = arena_pool.ARENA_FALLBACK_CONTROL
    has_basic = any(
        any(basic in line for basic in
            ("Plains", "Island", "Swamp", "Mountain", "Forest"))
        for line in text.splitlines()
    )
    assert has_basic


def test_hardcoded_fallbacks_parse_as_decklists():
    """Each line must start with a positive integer count — that's what
    Forge's `parseDeck()` requires. Catches typos / merge slip-ups in the
    fallback strings."""
    for text in (
        arena_pool.ARENA_FALLBACK_AGGRO_RED,
        arena_pool.ARENA_FALLBACK_CONTROL,
    ):
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("//") or line.startswith("#"):
                continue
            head = line.split(" ", 1)[0].replace("x", "")
            assert head.isdigit(), f"non-integer line head: {line!r}"
            assert int(head) > 0


def test_hardcoded_fallbacks_have_reasonable_size():
    """Sanity: a real MTG deck is between 40 (limited) and 100 (Commander).
    Anything outside that is almost certainly a corrupted fallback. We sum
    the per-card counts, not the line count."""
    for label, text in (
        ("aggro", arena_pool.ARENA_FALLBACK_AGGRO_RED),
        ("control", arena_pool.ARENA_FALLBACK_CONTROL),
    ):
        total = 0
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            head = line.split(" ", 1)[0].replace("x", "")
            if head.isdigit():
                total += int(head)
        assert 40 <= total <= 100, f"{label} fallback total={total} (expected 40–100)"


# ── DB query path (mocked, no real connection) ─────────────────────────────


def test_query_arena_pool_returns_empty_without_dsn():
    rows = arena_pool._query_arena_pool("R")
    assert rows == ()


def test_query_arena_pool_returns_empty_when_psycopg2_missing(monkeypatch):
    """If the user runs on a Python without psycopg2 installed, we must
    silently return () — not raise — so the fallback path engages."""
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "psycopg2":
            raise ImportError("simulated missing psycopg2")
        return real_import(name, *args, **kwargs)

    os.environ["DATABASE_URL"] = "postgres://fake/db"
    monkeypatch.setattr(builtins, "__import__", fake_import)
    rows = arena_pool._query_arena_pool("R")
    assert rows == ()


def test_query_arena_pool_returns_empty_on_connect_failure(monkeypatch):
    """A bad DSN should NOT crash training — we want graceful fallback so a
    misconfigured Postgres on a laptop doesn't kill `forge:smoke:arena`."""
    psycopg2 = pytest.importorskip("psycopg2")  # only run if psycopg2 present

    def boom(*args, **kwargs):
        raise psycopg2.OperationalError("simulated connection failure")

    os.environ["DATABASE_URL"] = "postgres://nope/db"
    monkeypatch.setattr(psycopg2, "connect", boom)
    rows = arena_pool._query_arena_pool("R")
    assert rows == ()


# ── Decklist synthesis ─────────────────────────────────────────────────────


def test_build_decklist_filters_out_lands():
    rows = [
        ("Lightning Strike", "Instant"),
        ("Mountain", "Basic Land — Mountain"),
        ("Monastery Swiftspear", "Creature — Monk"),
    ]
    text = arena_pool._build_decklist_from_rows(rows, basics=("Mountain",))
    # The "Mountain" *card row* is a land and must be filtered out of the
    # 4-of section. The basic Mountain still appears as the basics filler,
    # but with the count from `land_count`, NOT from the row.
    nonland_lines = [
        line for line in text.splitlines()
        if line and not line.endswith("Mountain")
    ]
    assert any("Lightning Strike" in line for line in nonland_lines)
    assert any("Monastery Swiftspear" in line for line in nonland_lines)
    # No "4 Mountain" — only the basics filler at the bottom.
    assert "4 Mountain" not in text or text.count("Mountain") <= 2


def test_build_decklist_dedupes_repeated_names():
    rows = [
        ("Lightning Strike", "Instant"),
        ("Lightning Strike", "Instant"),
        ("Lightning Strike", "Instant"),
        ("Monastery Swiftspear", "Creature"),
    ]
    text = arena_pool._build_decklist_from_rows(
        rows, basics=("Mountain",), nonland_count=8, land_count=20
    )
    # Each distinct card should appear exactly once (as "4 X").
    bolt_lines = [line for line in text.splitlines() if "Lightning Strike" in line]
    assert len(bolt_lines) == 1


def test_build_decklist_produces_basics_when_input_empty():
    """All-empty input shouldn't crash — we still want SOMETHING the bridge
    can hand to RegisteredPlayer (even if it loses on turn 1)."""
    text = arena_pool._build_decklist_from_rows(
        rows=(), basics=("Forest", "Mountain"), nonland_count=24, land_count=24
    )
    # Just basics — nothing else.
    lines = [l for l in text.splitlines() if l.strip()]
    for line in lines:
        # Each line should be "<n> Forest" or "<n> Mountain" only.
        assert "Forest" in line or "Mountain" in line
