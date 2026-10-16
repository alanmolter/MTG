"""Tournament decks exported from Postgres, gated like the file pool.

The live table has many ``competitive_decks`` rows with no
``competitive_deck_cards`` and no ``raw_json``. Those rows are the import
bug. Eligible lists are the ones that actually have a 60-card mainboard in
an Arena-relevant format and pass ``deck_quality``.
"""

from __future__ import annotations

from collections import defaultdict

from ml_engine.ray_cluster.deck_quality import deck_rejection_reason


ARENA_FORMATS = frozenset({"standard", "pioneer", "historic", "timeless", "explorer"})


def group_export(rows: list[dict]) -> list[dict]:
    """Group a flat card export into one record per deck id."""

    grouped: dict[str, dict] = {}
    for row in rows:
        deck = grouped.setdefault(str(row["id"]), {
            "id": str(row["id"]),
            "source": row.get("source") or "",
            "source_id": row.get("source_id") or "",
            "name": row.get("name") or "",
            "format": str(row.get("format") or "").strip().lower(),
            "main": [],
            "side": [],
        })
        name = str(row.get("card_name") or "").strip()
        if not name:
            continue
        quantity = int(row.get("quantity") or 0)
        section = str(row.get("section") or "mainboard").strip().lower()
        target = deck["side"] if section == "sideboard" else deck["main"]
        target.append((quantity, name))
    return list(grouped.values())


def mainboard_text(cards: list[tuple[int, str]]) -> str:
    return "\n".join(f"{count} {name}" for count, name in cards)


def eligible_decks(rows: list[dict]) -> dict:
    """Split an export into accepted Arena lists and named rejections."""

    accepted = []
    rejected = []
    for deck in group_export(rows):
        deck_id = f"db_{deck['id']}"
        total = sum(count for count, _ in deck["main"])
        if deck["format"] not in ARENA_FORMATS:
            rejected.append({"id": deck_id, "reason": "format", "detail": deck["format"]})
            continue
        if total == 0:
            rejected.append({"id": deck_id, "reason": "missing_cards", "detail": "no competitive_deck_cards rows"})
            continue
        text = mainboard_text(deck["main"])
        reason = deck_rejection_reason(deck_id, text)
        if reason:
            rejected.append({"id": deck_id, "reason": reason.split(":", 1)[0], "detail": reason})
            continue
        accepted.append({
            "id": deck_id,
            "name": deck["name"],
            "format": deck["format"],
            "source": deck["source"],
            "source_id": deck["source_id"],
            "forge_list": text,
        })
    reasons: dict[str, int] = defaultdict(int)
    for item in rejected:
        reasons[item["reason"]] += 1
    return {
        "accepted": accepted,
        "rejected": rejected,
        "rejection_reasons": dict(reasons),
    }
