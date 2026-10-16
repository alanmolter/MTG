"""Build deck pool v2 from MTGJSON precons and the local tournament export.

MTGJSON deck files are MIT-licensed (https://mtgjson.com/license/). Tournament
rows come from the user's Postgres export of public MTGTop8 event lists that
actually have cards. The script does not invent lists: a deck is written only
when the source file contains it, the mainboard is 60 cards, every card is
legal in an Arena-relevant format (standard / pioneer / historic / timeless /
explorer), deck_quality passes, and every name resolves to a Forge
cardsfolder filename.

Run from the repo root:

    python -m ml_engine.ray_cluster.build_deck_pool_v2 \\
        --tournament-csv path/to/competitive_decks_full.csv
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from ml_engine.ray_cluster.deck_pool import assign_ood_splits
from ml_engine.ray_cluster.deck_quality import (
    BASIC_LAND_COLORS,
    CardData,
    _slug,
    deck_rejection_reason,
)

ROOT = Path(__file__).resolve().parent / "data" / "deck_pool" / "v2"
UA = "mtg-rl-deck-pool/2.0 (research; mtgjson MIT + user-supplied tournament export)"
JSON_HEADERS = {"User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json"}
CONSTRUCTED_TYPES = {
    "Arena Starter Deck",
    "Arena Starter Kit",
    "Challenger Deck",
    "Pioneer Challenger Deck",
    "Event Deck",
    "Planeswalker Deck",
    "Intro Pack",
    "Clash Pack",
    "Guild Kit",
    "Starter Kit",
    "World Championship Deck",
    "Pro Tour Deck",
    "Theme Deck",
    "Duel Deck",
    "Enhanced Deck",
    "Advanced Deck",
    "Starter Deck",
    "MTGO Theme Deck",
    "Arena Promotional Deck",
}
ARENA_FORMATS = {"standard", "pioneer", "historic", "timeless", "explorer"}
TOURNAMENT_FORMATS = {"standard", "pioneer"}
MTGJSON_LICENSE = "MIT"
MTGJSON_LICENSE_URL = "https://mtgjson.com/license/"
TOP8_NOTE = (
    "Public MTGTop8 event decklist imported by the user into Postgres and "
    "exported for this pool. Card names and quantities are tournament facts; "
    "MTGTop8 does not grant a separate bulk-content license. Source URL is the "
    "event page the importer used."
)


def _get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def _json_bytes(raw: bytes) -> dict:
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    payload = json.loads(raw)
    return payload["data"] if isinstance(payload, dict) and "data" in payload else payload


def _forge_slugs(tree_path: Path) -> set[str]:
    data = json.loads(tree_path.read_text(encoding="utf-8"))
    slugs = set()
    for node in data.get("tree", []):
        path = str(node.get("path", ""))
        if "/cardsfolder/" in path and path.endswith(".txt"):
            slugs.add(Path(path).stem)
    if len(slugs) < 1000:
        raise RuntimeError(f"forge cardsfolder tree looks empty ({len(slugs)} files)")
    return slugs


def _mana_cost(raw: str | None) -> str:
    if not raw:
        return ""
    parts = re.findall(r"\{([^}]+)\}", raw)
    return " ".join(parts)


def _types(card: dict) -> str:
    parts = [*(card.get("supertypes") or []), *(card.get("types") or []), *(card.get("subtypes") or [])]
    return " ".join(str(part) for part in parts if part)


def _produces(card: dict) -> list[str]:
    colors = [color for color in (card.get("producedMana") or []) if color in "WUBRG"]
    types = set(card.get("subtypes") or [])
    for basic, color in BASIC_LAND_COLORS.items():
        if basic in types and color not in colors:
            colors.append(color)
    return colors


def _card_data(card: dict) -> CardData:
    return CardData(
        name=str(card["name"]),
        mana_cost=_mana_cost(card.get("manaCost")),
        types=_types(card),
        oracle="",
        path=Path("mtgjson"),
        produces=frozenset(_produces(card)),
    )


def _faces(card: dict) -> list[str]:
    faces = []
    for key in ("faceName",):
        value = card.get(key)
        if isinstance(value, str) and value and value != card.get("name"):
            faces.append(value)
    other = card.get("otherFaceIds")
    # Deck files sometimes put the back face only in `faceName` of a flipped printing.
    layout = str(card.get("layout") or "")
    if "adventure" in layout or "modal" in layout or "transform" in layout or "mdfc" in layout:
        back = card.get("flavorName")
        if isinstance(back, str):
            faces.append(back)
    if isinstance(other, list):
        pass
    return faces


def resolve_forge_slug(name: str, slugs: set[str], faces: list[str] | None = None) -> str | None:
    """Return the cardsfolder stem for this English name, or None."""

    slug = _slug(name)
    if slug in slugs:
        return slug
    for face in faces or []:
        combined = _slug(f"{name} {face}")
        if combined in slugs:
            return combined
        flipped = _slug(f"{face} {name}")
        if flipped in slugs:
            return flipped
    prefix = [stem for stem in slugs if stem.startswith(slug + "_")]
    if len(prefix) == 1:
        return prefix[0]
    return None


def _mainboard_text(cards: list[tuple[str, int]]) -> str:
    return "\n".join(f"{count} {name}" for name, count in cards)


def _arena_export(name: str, main: list[tuple[str, int]], side: list[tuple[str, int]]) -> str:
    lines = ["About", f"Name {name}", "", "Deck"]
    lines.extend(f"{count} {card}" for count, card in main)
    lines.extend(["", "Sideboard"])
    lines.extend(f"{count} {card}" for count, card in side)
    lines.append("")
    return "\n".join(lines)


def _format_ok(cards: list[dict]) -> str | None:
    for fmt in ("standard", "pioneer", "historic", "timeless", "explorer"):
        if all(str((card.get("legalities") or {}).get(fmt, "")).lower() in {"legal", "restricted"} for card in cards):
            return fmt
    return None


def _archetype(name: str, types_by_name: dict[str, str], quantities: dict[str, int], costs: dict[str, str]) -> str:
    label = name.casefold()
    if any(word in label for word in ("control", "permission")):
        return "control"
    if any(word in label for word in ("combo", "storm", "phoenix")):
        return "combo"
    if "ramp" in label:
        return "ramp"
    if any(word in label for word in ("aggro", "burn", "prowess", "heroic", "sligh")):
        return "aggro"
    values = []
    for card_name, count in quantities.items():
        if "Land" in types_by_name.get(card_name, "").split():
            continue
        tokens = costs.get(card_name, "").split()
        if not tokens:
            continue
        value = 0
        ok = True
        for token in tokens:
            if token.isdigit():
                value += int(token)
            elif token == "X":
                continue
            else:
                value += 1
        if ok:
            values.extend([value] * count)
    if not values:
        return "midrange"
    mean = sum(values) / len(values)
    if mean <= 2.35:
        return "aggro"
    if mean >= 3.25:
        return "control"
    return "midrange"


def _colors(cards: list[dict]) -> str:
    found = []
    for card in cards:
        for color in card.get("colorIdentity") or []:
            if color in "WUBRG" and color not in found:
                found.append(color)
    ordered = [color for color in "WUBRG" if color in found]
    return "".join(ordered) or "C"


def _load_tournament(path: Path) -> list[dict]:
    grouped: dict[str, dict] = {}
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            deck = grouped.setdefault(row["id"], {
                "id": row["id"],
                "source": row["source"],
                "source_id": row["source_id"],
                "name": row["name"],
                "format": row["format"].strip().lower(),
                "archetype_label": row.get("archetype") or "",
                "imported_at": row["imported_at"],
                "main": [],
                "side": [],
            })
            section = (row.get("section") or "mainboard").strip().lower()
            entry = (int(row["quantity"]), row["card_name"].strip())
            if section == "sideboard":
                deck["side"].append(entry)
            else:
                deck["main"].append(entry)
    return list(grouped.values())


def _scryfall_query_name(name: str) -> str:
    """Scryfall wants ``Front // Back``. The export sometimes uses one slash."""

    if "//" in name:
        return name
    if name.count("/") == 1:
        left, right = name.split("/")
        if left.strip() and right.strip():
            return f"{left.strip()} // {right.strip()}"
    return name


def _scryfall_collection(names: list[str]) -> tuple[list[dict], list]:
    body = json.dumps({"identifiers": [{"name": _scryfall_query_name(name)} for name in names]}).encode()
    request = urllib.request.Request(
        "https://api.scryfall.com/cards/collection",
        data=body,
        headers=JSON_HEADERS,
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.loads(response.read())
    return payload.get("data", []), payload.get("not_found") or []


def _scryfall_cards(names: list[str]) -> dict[str, dict]:
    found: dict[str, dict] = {}
    missing: list = []

    def absorb(queried: list[str], cards: list[dict]) -> None:
        for card in cards:
            keys = [card["name"]]
            for face in card.get("card_faces") or []:
                face_name = face.get("name")
                if isinstance(face_name, str) and face_name:
                    keys.append(face_name)
            for key in keys:
                found[key.casefold()] = card
                if "/" in key and "//" not in key:
                    continue
                if " // " in key:
                    found[key.replace(" // ", "/").casefold()] = card

    pending = list(names)
    while pending:
        chunk = pending[:75]
        pending = pending[75:]
        try:
            cards, not_found = _scryfall_collection(chunk)
        except urllib.error.HTTPError:
            if len(chunk) == 1:
                missing.append(chunk[0])
                continue
            pending = chunk[: len(chunk) // 2] + chunk[len(chunk) // 2 :] + pending
            continue
        absorb(chunk, cards)
        for item in not_found:
            query = item.get("name") if isinstance(item, dict) else str(item)
            face = query.split("//")[0].strip()
            try:
                request = urllib.request.Request(
                    "https://api.scryfall.com/cards/named?fuzzy=" + urllib.parse.quote(face),
                    headers={"User-Agent": UA, "Accept": "application/json"},
                )
                with urllib.request.urlopen(request, timeout=30) as response:
                    card = json.loads(response.read())
            except Exception:
                missing.append(query)
                continue
            absorb([query], [card])
            found[query.casefold()] = card
            found[query.replace(" // ", "/").casefold()] = card
    if missing:
        print(f"[v2] scryfall missed {len(missing)} names", flush=True)
    return found


def _scryfall_to_index(card: dict) -> CardData:
    faces = card.get("card_faces") or []
    front = faces[0] if faces else card
    produced = list(card.get("produced_mana") or [])
    for face in faces:
        produced.extend(face.get("produced_mana") or [])
    payload = {
        "name": card["name"],
        "manaCost": front.get("mana_cost") or card.get("mana_cost"),
        "supertypes": [],
        "types": [part for part in str(front.get("type_line") or card.get("type_line") or "").replace("—", "").split() if part],
        "subtypes": [],
        "producedMana": produced,
        "colorIdentity": card.get("color_identity") or [],
    }
    # type_line is "Legendary Creature — Human". _types joins all pieces; the emdash was stripped.
    return _card_data(payload)


def _download_mtgjson(deck_list: list[dict]) -> list[dict]:
    chosen = [row for row in deck_list if row.get("type") in CONSTRUCTED_TYPES]
    cache = Path("/tmp/mtgjson-decks")
    cache.mkdir(parents=True, exist_ok=True)

    def fetch(row: dict) -> dict | None:
        cached = cache / f"{row['fileName']}.json"
        try:
            if cached.is_file():
                deck = json.loads(cached.read_text(encoding="utf-8"))
            else:
                url = f"https://mtgjson.com/api/v5/decks/{row['fileName']}.json.gz"
                deck = _json_bytes(_get(url))
                cached.write_text(json.dumps(deck), encoding="utf-8")
        except Exception as exc:
            return {"error": f"{row['fileName']}: {exc}"}
        main = deck.get("mainBoard") or []
        if sum(int(card.get("count") or 0) for card in main) != 60:
            return None
        arena_format = _format_ok(main)
        if arena_format is None:
            return {"reject": row["fileName"], "reason": "not_arena_relevant_format"}
        return {"row": row, "deck": deck, "arena_format": arena_format}

    results = []
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(fetch, row) for row in chosen]
        for done, future in enumerate(as_completed(futures), start=1):
            item = future.result()
            if item:
                results.append(item)
            if done % 100 == 0:
                print(f"[v2] fetched {done}/{len(chosen)}")
    return results


def build(tournament_csv: Path, tree_path: Path, deck_list_path: Path) -> dict:
    slugs = _forge_slugs(tree_path)
    deck_list = _json_bytes(deck_list_path.read_bytes())
    print(f"[v2] forge slugs {len(slugs)}; deck list {len(deck_list)}")
    downloaded = _download_mtgjson(deck_list)
    print(f"[v2] mtgjson responses {len(downloaded)}")

    rejections: list[dict] = []
    accepted: list[dict] = []
    index: dict[str, CardData] = {}
    slug_for: dict[str, str] = {}
    aliases: dict[str, list[str]] = defaultdict(list)

    def remember(card: CardData, slug: str, extra_aliases: list[str]) -> None:
        index[card.name.casefold()] = card
        slug_for[card.name.casefold()] = slug
        for alias in extra_aliases:
            aliases[card.name.casefold()].append(alias)
            index.setdefault(alias.casefold(), card)

    def consider(deck_id: str, name: str, main: list[tuple[int, str]], side: list[tuple[int, str]], meta: dict, cards_by_name: dict[str, dict]) -> None:
        missing = [card_name for _, card_name in main if resolve_forge_slug(card_name, slugs, _faces(cards_by_name.get(card_name, {}))) is None]
        if missing:
            rejections.append({"id": deck_id, "reason": "forge_name", "detail": ", ".join(missing[:8]), **meta})
            return
        quantities = []
        local_index: dict[str, CardData] = {}
        for count, card_name in main:
            source = cards_by_name.get(card_name)
            if source is None:
                rejections.append({"id": deck_id, "reason": "missing_card_data", "detail": card_name, **meta})
                return
            data = source if isinstance(source, CardData) else _card_data(source)
            local_index[data.name.casefold()] = data
            quantities.append((card_name, count))
        text = _mainboard_text(quantities)
        reason = deck_rejection_reason(deck_id, text, extra_index=local_index)
        if reason:
            code = reason.split(":", 1)[0]
            rejections.append({"id": deck_id, "reason": code, "detail": reason, **meta})
            return
        for card_name, data in ((name, card) for name, card in local_index.items()):
            raw = cards_by_name.get(data.name, {})
            faces = _faces(raw if isinstance(raw, dict) else {})
            slug = resolve_forge_slug(data.name, slugs, faces)
            assert slug
            remember(data, slug, faces)
        type_map = {data.name: data.types for data in local_index.values()}
        cost_map = {data.name: data.mana_cost for data in local_index.values()}
        counts = {card_name: count for card_name, count in quantities}
        accepted.append({
            "id": deck_id,
            "name": name,
            "main": main,
            "side": side,
            "text": text,
            "archetype": _archetype(name, type_map, counts, cost_map),
            **meta,
        })

    for item in downloaded:
        if "error" in item:
            rejections.append({"id": item["error"], "reason": "download_error", "detail": item["error"]})
            continue
        if "reject" in item:
            rejections.append({"id": item["reject"], "reason": item["reason"], "detail": item["reason"]})
            continue
        row = item["row"]
        deck = item["deck"]
        main_cards = deck.get("mainBoard") or []
        by_name = {card["name"]: card for card in main_cards}
        main = [(int(card["count"]), card["name"]) for card in main_cards]
        side = [(int(card["count"]), card["name"]) for card in (deck.get("sideBoard") or [])]
        deck_id = _slug(f"{row['fileName']}")[:80]
        consider(
            deck_id,
            str(deck.get("name") or row["name"]),
            main,
            side,
            {
                "source_kind": "mtgjson",
                "source_url": row.get("source") or f"https://mtgjson.com/api/v5/decks/{row['fileName']}.json",
                "license": MTGJSON_LICENSE,
                "license_url": MTGJSON_LICENSE_URL,
                "product": row.get("type") or "",
                "set_code": row.get("code") or deck.get("code") or "",
                "release_date": str(row.get("releaseDate") or deck.get("releaseDate") or ""),
                "arena_format": item["arena_format"],
                "mtgjson_file": row["fileName"],
                "colors": _colors(main_cards),
            },
            by_name,
        )

    tournament = [deck for deck in _load_tournament(tournament_csv) if deck["format"] in TOURNAMENT_FORMATS]
    names = sorted({card for deck in tournament for _, card in deck["main"]})
    print(f"[v2] tournament decks {len(tournament)}; unique cards {len(names)}")
    scryfall = _scryfall_cards(names)
    for deck in tournament:
        total = sum(count for count, _ in deck["main"])
        if total != 60:
            rejections.append({"id": f"top8_{deck['id']}", "reason": "mainboard_size", "detail": str(total), "source_kind": "mtgtop8"})
            continue
        by_name = {}
        converted: dict[str, dict] = {}
        for _, card_name in deck["main"]:
            card = scryfall.get(card_name.casefold())
            if card is None:
                by_name = {}
                break
            data = _scryfall_to_index(card)
            # Keep the deck's printed name when Scryfall returns the canonical name.
            if data.name != card_name:
                data = CardData(card_name, data.mana_cost, data.types, "", Path("scryfall"), data.produces)
            converted[card_name] = {
                "name": card_name,
                "manaCost": _brace(data.mana_cost),
                "supertypes": [],
                "types": data.types.split(),
                "subtypes": [],
                "producedMana": list(data.produces),
                "colorIdentity": card.get("color_identity") or [],
                "faceName": (card.get("card_faces") or [{}, {}])[1].get("name") if card.get("card_faces") else None,
                "layout": card.get("layout"),
            }
            by_name[card_name] = converted[card_name]
        if len(by_name) != len({name for _, name in deck["main"]}):
            rejections.append({"id": f"top8_{deck['id']}", "reason": "missing_card_data", "detail": deck["name"], "source_kind": "mtgtop8"})
            continue
        source_id = deck["source_id"]
        event = source_id[5:] if source_id.startswith("top8-") else source_id
        month = str(deck["imported_at"])[:7]
        consider(
            f"top8_{deck['id']}",
            deck["name"],
            deck["main"],
            deck["side"],
            {
                "source_kind": "mtgtop8",
                "source_url": f"https://mtgtop8.com/event?{event}",
                "license": "tournament-facts",
                "license_url": "https://mtgtop8.com/",
                "license_note": TOP8_NOTE,
                "product": "MTGTop8 event decklist",
                "set_code": f"top8-{month}",
                "release_date": str(deck["imported_at"])[:10],
                "arena_format": deck["format"],
                "mtgjson_file": "",
                "colors": _colors(list(converted.values())),
                "tournament_source_id": source_id,
            },
            by_name,
        )

    # Drop duplicate mainboards; keep the earliest release.
    accepted.sort(key=lambda row: (row.get("release_date") or "", row["id"]))
    seen_hash = set()
    unique = []
    for row in accepted:
        digest = row["text"]
        if digest in seen_hash:
            rejections.append({"id": row["id"], "reason": "duplicate_mainboard", "detail": row["name"], "source_kind": row["source_kind"]})
            continue
        seen_hash.add(digest)
        unique.append(row)
    split_rows = assign_ood_splits(unique)
    ROOT.mkdir(parents=True, exist_ok=True)
    deck_dir = ROOT / "decks"
    deck_dir.mkdir(exist_ok=True)
    manifest_decks = []
    for row in sorted(split_rows, key=lambda item: item["id"]):
        path = deck_dir / f"{row['id']}.txt"
        path.write_text(_arena_export(row["name"], row["main"], row["side"]), encoding="utf-8")
        manifest_decks.append({
            "id": row["id"],
            "name": row["name"],
            "archetype": row["archetype"],
            "archetype_id": f"{row['archetype']}_{row['colors']}_{row['set_code']}_{row['id']}"[:120],
            "colors": row["colors"],
            "split": row["split"],
            "file": f"decks/{row['id']}.txt",
            "product": row.get("product") or "",
            "source_url": row.get("source_url") or "",
            "source_kind": row.get("source_kind") or "",
            "license": row.get("license") or "",
            "license_url": row.get("license_url") or "",
            "license_note": row.get("license_note") or "",
            "mtgjson_file": row.get("mtgjson_file") or "",
            "arena_format": row.get("arena_format") or "",
            "release_date": row.get("release_date") or "",
            "set_code": row.get("set_code") or "",
            "tournament_source_id": row.get("tournament_source_id") or "",
        })
    cards_out = []
    seen_names = set()
    for key, data in sorted(index.items()):
        if data.name in seen_names:
            continue
        if key != data.name.casefold():
            continue
        seen_names.add(data.name)
        cards_out.append({
            "name": data.name,
            "mana_cost": data.mana_cost,
            "types": data.types,
            "produces": sorted(data.produces),
            "forge_slug": slug_for[data.name.casefold()],
            "aliases": sorted(set(aliases.get(data.name.casefold(), []))),
        })
    reason_counts = Counter(item["reason"] for item in rejections)
    summary = {
        "accepted": len(manifest_decks),
        "rejected": len(rejections),
        "by_split": Counter(item["split"] for item in manifest_decks),
        "by_format": Counter(item["arena_format"] for item in manifest_decks),
        "by_archetype": Counter(item["archetype"] for item in manifest_decks),
        "by_source": Counter(item["source_kind"] for item in manifest_decks),
        "rejection_reasons": reason_counts,
    }
    manifest = {
        "version": "2",
        "description": (
            "Constructed 60-card pool for Forge training. Train lists are sampled "
            "during arena episodes. Holdout groups are later sets or unseen "
            "archetype/color families. Benchmark is a fixed slice of those holdout "
            "groups for repeatable eval. v1 is unchanged."
        ),
        "sources": [
            {"kind": "mtgjson", "license": MTGJSON_LICENSE, "license_url": MTGJSON_LICENSE_URL},
            {"kind": "mtgtop8", "license": "tournament-facts", "license_note": TOP8_NOTE},
        ],
        "summary": {key: (dict(value) if isinstance(value, Counter) else value) for key, value in summary.items()},
        "decks": manifest_decks,
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (ROOT / "forge_cards.json").write_text(json.dumps({
        "source": "Card-Forge cardsfolder filenames matched to MTGJSON/Scryfall mana, types, and land production. Oracle text is not stored.",
        "forge_repo": "https://github.com/Card-Forge/forge",
        "forge_path": "forge-gui/res/cardsfolder/<first-letter>/<forge_slug>.txt",
        "cards": cards_out,
    }, indent=2), encoding="utf-8")
    (ROOT / "rejections.json").write_text(json.dumps({
        "summary": manifest["summary"],
        "rejected": rejections,
    }, indent=2), encoding="utf-8")
    print(json.dumps(manifest["summary"], indent=2))
    return manifest["summary"]


def _brace(cost: str) -> str | None:
    if not cost:
        return None
    return "".join("{" + token + "}" for token in cost.split())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tournament-csv", type=Path, required=True)
    parser.add_argument("--forge-tree", type=Path, default=Path("/tmp/forge-tree.json"))
    parser.add_argument("--deck-list", type=Path, default=Path("/tmp/DeckList.json.gz"))
    args = parser.parse_args()
    if not args.deck_list.is_file():
        args.deck_list.write_bytes(_get("https://mtgjson.com/api/v5/DeckList.json.gz"))
    build(args.tournament_csv, args.forge_tree, args.deck_list)


if __name__ == "__main__":
    main()
