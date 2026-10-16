"""Quality gate: copy limit, color identity, curve, and Forge card data."""

from __future__ import annotations

import logging

from ml_engine.ray_cluster.deck_pool import accept_deck, deck_by_archetype_id
from ml_engine.ray_cluster.deck_quality import (
    _mana_value,
    _read_card,
    _spell_colors,
    evaluate_deck,
    load_card,
)


def _write_card(folder, slug: str, body: str) -> None:
    path = folder / slug[0] / f"{slug}.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def test_five_copies_of_a_nonbasic_are_rejected():
    result = evaluate_deck("five", "5 Lightning Strike\n55 Mountain")
    assert result["pass"] is False
    assert any(finding["code"] == "copy_limit" for finding in result["findings"])


def test_mainboard_under_sixty_is_rejected():
    result = evaluate_deck("short", "4 Lightning Strike\n20 Mountain")
    assert result["pass"] is False
    assert any(finding["code"] == "card_count" for finding in result["findings"])


def test_reported_off_color_cards_are_rejected(tmp_path):
    """The old fallbacks put Abrade in UW and a black creature in mono-red."""

    folder = tmp_path / "cardsfolder"
    _write_card(
        folder,
        "abrade",
        "Name:Abrade\nManaCost:1 R\nTypes:Instant\nOracle:Abrade deals 3 damage to target creature.\n",
    )
    _write_card(
        folder,
        "bloodthirsty_conqueror",
        "Name:Bloodthirsty Conqueror\nManaCost:3 B B\nTypes:Creature Vampire Knight\n",
    )
    red = deck_by_archetype_id("aggro_red").forge_list.replace(
        "4 Monastery Swiftspear", "4 Bloodthirsty Conqueror", 1
    )
    blue = deck_by_archetype_id("control_uw").forge_list.replace(
        "1 Negate", "1 Abrade", 1
    )
    red_result = evaluate_deck("mono_red_with_black", red, card_database=folder)
    blue_result = evaluate_deck("uw_with_abrade", blue, card_database=folder)
    assert red_result["pass"] is False
    assert blue_result["pass"] is False
    assert any(finding["code"] == "color_identity" for finding in red_result["findings"])
    assert any("Bloodthirsty Conqueror" in finding["detail"] for finding in red_result["findings"])
    assert any(finding["code"] == "color_identity" for finding in blue_result["findings"])
    assert any("Abrade" in finding["detail"] for finding in blue_result["findings"])


def test_rejection_is_logged(caplog):
    with caplog.at_level(logging.WARNING):
        assert accept_deck("short", "4 Lightning Strike\n20 Mountain") is False
    assert any("rejected deck short" in record.message for record in caplog.records)


def test_forge_hybrid_cost_and_land_back_are_readable(tmp_path):
    lurrus = load_card("Lurrus of the Dream-Den")
    assert lurrus is not None
    assert _mana_value(lurrus) == 3
    assert _spell_colors(lurrus) == {"W", "B"}

    folder = tmp_path / "cardsfolder"
    _write_card(
        folder,
        "jwari_disruption_jwari_ruins",
        "\n".join([
            "Name:Jwari Disruption",
            "ManaCost:1 U",
            "Types:Instant",
            "Oracle:Counter target spell unless its controller pays {1}.",
            "",
            "Name:Jwari Ruins",
            "ManaCost:no cost",
            "Types:Land",
            "Oracle:{T}: Add {U}.",
            "",
        ]),
    )
    card = _read_card(folder / "j" / "jwari_disruption_jwari_ruins.txt")
    assert card is not None
    assert card.name == "Jwari Disruption"
    assert card.is_land is False
    assert "U" in card.produces
    loaded = load_card("Jwari Disruption", folder)
    assert loaded is not None and loaded.name == "Jwari Disruption"
