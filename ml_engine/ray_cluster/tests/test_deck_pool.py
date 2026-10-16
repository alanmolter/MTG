"""Train/holdout deck pool: real lists, Forge names, disjoint splits."""

from __future__ import annotations

import json

import pytest

from ml_engine.ray_cluster import arena_pool
from ml_engine.ray_cluster.deck_pool import (
    POOL_VERSION,
    arena_mainboard,
    decks_for_split,
    identify_deck,
    load_pool,
    sample_pair,
    training_deck_hashes,
)
from ml_engine.ray_cluster.deck_quality import _slug, load_card
from ml_engine.ray_cluster.deck_quality import BUNDLED_CARD_INDEX
from ml_engine.scripts.policy_evaluation import generated_seed_holdout


@pytest.fixture(autouse=True)
def _clear_curriculum(monkeypatch):
    monkeypatch.delenv("TRAINING_ARCHETYPES", raising=False)


def test_pool_version_and_both_splits_exist():
    manifest = json.loads((BUNDLED_CARD_INDEX.parent / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["version"] == POOL_VERSION
    assert manifest["sources"]
    decks = load_pool()
    splits = {deck.split for deck in decks}
    assert splits == {"train", "holdout"}
    archetypes = {deck.archetype for deck in decks_for_split("train")}
    assert {"aggro", "midrange", "control", "combo"} <= archetypes


def test_train_and_holdout_hashes_are_disjoint_and_sixty_cards():
    train = {deck.sha256 for deck in decks_for_split("train")}
    holdout = decks_for_split("holdout")
    assert train.isdisjoint({deck.sha256 for deck in holdout})
    assert training_deck_hashes() == [deck.sha256 for deck in decks_for_split("train")]
    for deck in load_pool():
        total = sum(int(line.split(" ", 1)[0]) for line in deck.forge_list.splitlines())
        assert total == 60, deck.deck_id
        assert identify_deck(deck.forge_list) == deck.deck_id


def test_arena_export_round_trips_and_drops_the_sideboard():
    for deck in load_pool():
        path = BUNDLED_CARD_INDEX.parent / "decks" / f"{deck.deck_id}.txt"
        text = path.read_text(encoding="utf-8")
        assert text.startswith("About\n")
        assert "\nDeck\n" in text
        assert "\nSideboard\n" in text
        assert arena_mainboard(text) == deck.forge_list
        assert "Sideboard" not in deck.forge_list


def test_every_mainboard_card_matches_a_forge_filename():
    index = json.loads(BUNDLED_CARD_INDEX.read_text(encoding="utf-8"))
    by_name = {}
    for entry in index["cards"]:
        keys = [entry["name"], *entry.get("aliases", [])]
        for key in keys:
            by_name[key.casefold()] = entry
        slug_source = entry["aliases"][0] if entry.get("aliases") else entry["name"]
        assert entry["forge_slug"] == _slug(slug_source)
        assert entry["forge_slug"][0] == _slug(slug_source)[0]
    for deck in load_pool():
        for line in deck.forge_list.splitlines():
            name = line.split(" ", 1)[1]
            card = load_card(name)
            assert card is not None, name
            assert card.name.casefold() == name.casefold()
            assert name.casefold() in by_name


def test_training_samples_only_the_train_split_and_is_deterministic():
    train_ids = {deck.deck_id for deck in decks_for_split("train")}
    holdout_ids = {deck.deck_id for deck in decks_for_split("holdout")}
    first = sample_pair("train", 42)
    second = sample_pair("train", 42)
    assert (first[0].deck_id, first[1].deck_id) == (second[0].deck_id, second[1].deck_id)
    assert first[0].deck_id != first[1].deck_id
    seen = set()
    for seed in range(30):
        left, right = sample_pair("train", seed)
        assert {left.deck_id, right.deck_id} <= train_ids
        assert {left.deck_id, right.deck_id}.isdisjoint(holdout_ids)
        seen.add((left.deck_id, right.deck_id))
    assert len(seen) > 1


def test_holdout_sampler_stays_out_of_the_training_set():
    train_hashes = set(training_deck_hashes())
    for seed in range(10):
        left, right = sample_pair("holdout", seed)
        assert left.sha256 not in train_hashes
        assert right.sha256 not in train_hashes
        assert left.deck_id != right.deck_id


def test_training_resolver_does_not_query_the_database(monkeypatch):
    def boom(*_args, **_kwargs):
        raise AssertionError("training must not query the card table")

    monkeypatch.setattr(arena_pool, "_query_arena_pool", boom)
    agent, opponent = arena_pool.resolve_decks_for_training(arena_only=True, seed=3)
    assert identify_deck(agent) in {deck.deck_id for deck in decks_for_split("train")}
    assert identify_deck(opponent) in {deck.deck_id for deck in decks_for_split("train")}
    assert agent != opponent


def test_random_db_builder_is_rejected(caplog):
    caplog.set_level("WARNING")
    text = arena_pool.gated_db_decklist(
        [("Lightning Strike", "Instant"), ("Bloodthirsty Conqueror", "Creature")],
        ("Mountain",),
        deck_id="random_rows",
    )
    assert text is None
    assert any("rejected deck random_rows" in record.message for record in caplog.records)


def test_generated_eval_matchups_use_the_holdout_split():
    matchups = generated_seed_holdout([7, 8], arena_only=True)
    holdout_hashes = {deck.sha256 for deck in decks_for_split("holdout")}
    train_hashes = set(training_deck_hashes())
    assert len(matchups) == 2
    for matchup in matchups:
        assert matchup.agent_deck_sha256 in holdout_hashes
        assert matchup.opponent_deck_sha256 in holdout_hashes
        assert matchup.agent_deck_sha256 not in train_hashes
        assert matchup.declared_heldout is False
        assert matchup.source == "deck_pool_holdout"


def test_curriculum_allowlist_keeps_real_pool_ids(monkeypatch):
    monkeypatch.setenv("TRAINING_ARCHETYPES", "AGGRO_RED, aggro_red, CONTROL_UW")
    assert arena_pool._archetype_allowlist() == ("aggro_red", "control_uw")
    agent, opponent = arena_pool.resolve_decks_for_training(arena_only=True, seed=1)
    assert {identify_deck(agent), identify_deck(opponent)} == {
        "q06_mono_red_burn",
        "q05_azorius_control",
    }
