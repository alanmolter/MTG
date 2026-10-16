"""Deck pool v2 and the Postgres export gate."""

from __future__ import annotations

import json
from pathlib import Path

from ml_engine.ray_cluster.db_decks import eligible_decks
from ml_engine.ray_cluster.deck_pool import assign_ood_splits, decks_for_split, load_pool


def test_ood_split_keeps_a_family_together_and_holds_out_the_newest_set():
    rows = [
        {"id": "old", "archetype": "aggro", "colors": "R", "set_code": "Q06", "release_date": "2021-10-01"},
        {"id": "new", "archetype": "aggro", "colors": "R", "set_code": "Q08", "release_date": "2024-04-01"},
        {"id": "same", "archetype": "aggro", "colors": "R", "set_code": "Q06", "release_date": "2021-10-01"},
        {"id": "solo", "archetype": "control", "colors": "U", "set_code": "OLD", "release_date": "2019-01-01"},
    ]
    assigned = {row["id"]: row["split"] for row in assign_ood_splits(rows, benchmark_per_archetype=1, benchmark_cap=1)}
    assert assigned["old"] == "train"
    assert assigned["same"] == "train"
    assert assigned["new"] == "benchmark"
    assert assigned["solo"] == "train"


def test_v2_pool_is_legal_and_split_by_source():
    decks = load_pool("2")
    assert len(decks) >= 100
    splits = {deck.split for deck in decks}
    assert splits == {"train", "holdout", "benchmark"}
    train_hashes = {deck.sha256 for deck in decks_for_split("train", "2")}
    assert train_hashes.isdisjoint(deck.sha256 for deck in decks if deck.split != "train")
    sources = {deck.source_kind for deck in decks}
    assert "mtgjson" in sources
    assert "mtgtop8" in sources
    root = Path(__file__).resolve().parents[1] / "data" / "deck_pool" / "v2"
    payload = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    assert payload["version"] == "2"
    assert payload["summary"]["accepted"] == len(decks)
    assert any(deck.get("license") for deck in payload["decks"])
    assert (root / "rejections.json").is_file()


def test_db_export_drops_empty_and_non_arena_rows():
    rows = [
        {"id": "1", "source": "mtgtop8", "source_id": "top8-e=1&d=1", "name": "Empty", "format": "standard", "card_name": "", "quantity": 0, "section": "mainboard"},
        {"id": "2", "source": "mtgtop8", "source_id": "top8-e=2&d=2", "name": "Legacy", "format": "legacy", "card_name": "Lightning Bolt", "quantity": 4, "section": "mainboard"},
    ]
    result = eligible_decks(rows)
    assert result["accepted"] == []
    assert {item["reason"] for item in result["rejected"]} >= {"missing_cards", "format"}
