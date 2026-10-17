"""Versioned Arena deck pool for training and holdout.

Training never builds a deck from a random card query. It samples two
distinct lists from the train split of ``data/deck_pool/v1``. Evaluation
samples the holdout split, which is a different set of lists. Every list is
an official Wizards Challenger Deck stored in Arena export format; the Forge
string is the mainboard with set codes stripped.

A list that fails ``deck_quality`` is rejected and the reason is logged.
The shipped pool is checked at import, so a broken file fails closed.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional, Sequence

from ml_engine.ray_cluster.deck_quality import canonical_deck_hash, card_index_from_file, deck_rejection_reason


logger = logging.getLogger(__name__)

POOL_ROOT = Path(__file__).resolve().parent / "data" / "deck_pool" / "v1"

# DividedAsYouChoose targets are still chosen by the Forge AI. Phase 1
# training lists must not contain these cards. Phase 2 will expose the split.
PHASE1_DIVIDED_CARDS = (
    "Abzan Charm",
    "Armament Corps",
    "Chandra's Pyrohelix",
    "Elusive Otter",
    "Fight with Fire",
    "Magic Missile",
    "Quirion Beastcaller",
    "Shatterskull Smashing",
    "Splendid Agony",
    "Spreading Flames",
    "Storm the Seedcore",
    "Twin Bolt",
)
POOL_VERSION = "1"
POOL_VERSION_ENV = "DECK_POOL_VERSION"
_V1_SPLITS = {"train", "holdout"}
_V2_SPLITS = {"train", "holdout", "benchmark"}

_SET_SUFFIX = re.compile(r"\s+\([A-Za-z0-9]+\)\s+\S+\s*$")
_COUNT_LINE = re.compile(r"^(\d+)\s+(.+)$")
_SECTION_HEADERS = {"about", "deck", "sideboard", "companion"}


@dataclass(frozen=True)
class PoolDeck:
    deck_id: str
    name: str
    archetype: str
    archetype_id: str
    colors: str
    split: str
    product: str
    source_url: str
    mtgjson_file: str
    arena_format: str
    forge_list: str
    release_date: str = ""
    set_code: str = ""
    license: str = ""
    source_kind: str = ""

    @property
    def sha256(self) -> str:
        return canonical_deck_hash(self.forge_list)


def arena_mainboard(arena_export: str) -> str:
    """Turn an Arena export into the ``<count> <name>`` mainboard Forge reads.

    Sideboard, About, and Deck headers are dropped. A trailing ``(SET) 123``
    collector suffix is stripped. Duplicate names sum their counts.
    """

    counts: dict[str, int] = {}
    order: list[str] = []
    in_sideboard = False
    for raw in arena_export.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        header = line.casefold()
        if header in _SECTION_HEADERS or header.startswith("name "):
            in_sideboard = header == "sideboard" or header.startswith("sideboard")
            continue
        if in_sideboard:
            continue
        match = _COUNT_LINE.match(line)
        if match is None:
            raise ValueError(f"arena deck line is not '<count> <name>': {line!r}")
        quantity = int(match.group(1))
        name = _SET_SUFFIX.sub("", match.group(2)).strip()
        if quantity <= 0 or not name:
            raise ValueError(f"arena deck line has an invalid count or name: {line!r}")
        if name not in counts:
            order.append(name)
        counts[name] = counts.get(name, 0) + quantity
    if not order:
        raise ValueError("arena deck has no mainboard")
    return "\n".join(f"{counts[name]} {name}" for name in order)


def _divided_card(forge_list: str) -> str | None:
    for line in forge_list.splitlines():
        name = line.split(" ", 1)[1] if " " in line else line
        for card in PHASE1_DIVIDED_CARDS:
            if name == card or name.startswith(card + " //") or name.startswith(card + " "):
                return name
    return None


def accept_deck(deck_id: str, decklist: str, *, extra_index=None) -> bool:
    """False when the list fails the quality gate. The reason is logged."""

    reason = deck_rejection_reason(deck_id, decklist, extra_index=extra_index)
    if reason is None:
        return True
    logger.warning("rejected deck %s: %s", deck_id, reason)
    return False


def pool_root(version: str) -> Path:
    return Path(__file__).resolve().parent / "data" / "deck_pool" / f"v{version}"


def active_pool_version() -> str:
    raw = os.environ.get(POOL_VERSION_ENV, "").strip()
    return raw or POOL_VERSION


def _allowed_splits(version: str) -> set[str]:
    return _V2_SPLITS if version != "1" else _V1_SPLITS


@lru_cache(maxsize=4)
def _version_card_index(version: str):
    path = pool_root(version) / "forge_cards.json"
    if not path.is_file():
        return None
    return card_index_from_file(path)


def _load_deck(entry: dict, root: Path, *, version: str) -> PoolDeck:
    deck_id = str(entry["id"]).strip()
    split = str(entry["split"]).strip().lower()
    allowed = _allowed_splits(version)
    if split not in allowed:
        raise ValueError(f"{deck_id} split must be one of {sorted(allowed)}, got {split!r}")
    relative = str(entry["file"])
    path = root / relative
    forge_list = arena_mainboard(path.read_text(encoding="utf-8"))
    divided = _divided_card(forge_list)
    if divided:
        raise RuntimeError(
            f"deck pool {deck_id} contains {divided}; Phase 1 does not train on divided-damage cards"
        )
    deck = PoolDeck(
        deck_id=deck_id,
        name=str(entry["name"]),
        archetype=str(entry["archetype"]),
        archetype_id=str(entry["archetype_id"]),
        colors=str(entry.get("colors", "")),
        split=split,
        product=str(entry.get("product", "")),
        source_url=str(entry.get("source_url", "")),
        mtgjson_file=str(entry.get("mtgjson_file", "")),
        arena_format=str(entry.get("arena_format", "")),
        forge_list=forge_list,
        release_date=str(entry.get("release_date", "")),
        set_code=str(entry.get("set_code", "")),
        license=str(entry.get("license", "")),
        source_kind=str(entry.get("source_kind", "")),
    )
    card_index = _version_card_index(version)
    if not accept_deck(deck.deck_id, deck.forge_list, extra_index=card_index):
        reason = deck_rejection_reason(deck.deck_id, deck.forge_list, extra_index=card_index)
        raise RuntimeError(f"deck pool rejected {deck.deck_id}: {reason}")
    return deck


@lru_cache(maxsize=4)
def _load_pool(version: str) -> tuple[PoolDeck, ...]:
    root = pool_root(version)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    found = str(manifest.get("version", ""))
    if found != version:
        raise RuntimeError(f"deck pool version {found!r} != {version!r}")
    decks = tuple(_load_deck(entry, root, version=version) for entry in manifest["decks"])
    ids = [deck.deck_id for deck in decks]
    if len(ids) != len(set(ids)):
        raise RuntimeError("deck pool has duplicate ids")
    train = [deck for deck in decks if deck.split == "train"]
    held = [deck for deck in decks if deck.split != "train"]
    if len(train) < 2 or len(held) < 2:
        raise RuntimeError("deck pool needs at least two train and two non-train decks")
    if version != "1":
        if not any(deck.split == "holdout" for deck in decks):
            raise RuntimeError("deck pool v2 needs a holdout split")
        if not any(deck.split == "benchmark" for deck in decks):
            raise RuntimeError("deck pool v2 needs a fixed benchmark split")
    train_hashes = {deck.sha256 for deck in train}
    overlap = [deck.deck_id for deck in held if deck.sha256 in train_hashes]
    if overlap:
        raise RuntimeError(f"holdout decks repeat a training list: {overlap}")
    return decks


def load_pool(version: Optional[str] = None) -> tuple[PoolDeck, ...]:
    """Load a versioned pool. Default is v1 unless ``DECK_POOL_VERSION`` is set."""

    return _load_pool(version or active_pool_version())


def decks_for_split(split: str, version: Optional[str] = None) -> tuple[PoolDeck, ...]:
    return tuple(deck for deck in load_pool(version) if deck.split == split)


def training_archetype_ids() -> tuple[str, ...]:
    return tuple(dict.fromkeys(deck.archetype_id for deck in decks_for_split("train")))


def training_deck_hashes() -> list[str]:
    return [deck.sha256 for deck in decks_for_split("train")]


def deck_by_archetype_id(archetype_id: str) -> PoolDeck:
    for deck in load_pool():
        if deck.archetype_id == archetype_id:
            return deck
    raise KeyError(archetype_id)


def identify_deck(decklist: Optional[str]) -> str:
    """Pool id for this mainboard, or ``\"\"`` when it is not in the pool."""

    if not decklist:
        return ""
    digest = canonical_deck_hash(decklist)
    for deck in load_pool():
        if deck.sha256 == digest:
            return deck.deck_id
    return ""


def sample_pair(
    split: str,
    seed: Optional[int],
    *,
    archetype_ids: Optional[Sequence[str]] = None,
) -> tuple[PoolDeck, PoolDeck]:
    """Two distinct decks from one split. Deterministic when ``seed`` is set."""

    pool = list(decks_for_split(split))
    if archetype_ids:
        allowed = {archetype_id for archetype_id in archetype_ids}
        filtered = [deck for deck in pool if deck.archetype_id in allowed]
        if len(filtered) >= 2:
            pool = filtered
    if len(pool) < 2:
        raise RuntimeError(f"deck pool split {split!r} does not have two decks")
    left, right = random.Random(seed).sample(pool, k=2)
    return left, right


def assign_ood_splits(
    rows: Sequence[dict],
    *,
    benchmark_per_archetype: int = 2,
    benchmark_cap: int = 24,
    recent_year: int = 2024,
) -> list[dict]:
    """Assign train / holdout / benchmark without splitting a group.

    A group is ``(archetype, colors, set_code)``. Holdout is the newest set
    inside each ``(archetype, colors)`` family when that family spans more
    than one set. A family that exists in only one set is holdout when its
    release year is ``recent_year`` or later, and train otherwise. Benchmark
    is a stable slice of the holdout rows (sorted by id, up to
    ``benchmark_per_archetype`` per archetype, capped), so repeated evals
    use the same lists. No group key is shared with train.
    """

    if benchmark_per_archetype < 1 or benchmark_cap < 1:
        raise ValueError("benchmark selection needs a positive size")
    grouped: dict[tuple[str, str, str], list[dict]] = {}
    for row in rows:
        key = (
            str(row["archetype"]),
            str(row["colors"]),
            str(row.get("set_code") or row.get("code") or ""),
        )
        grouped.setdefault(key, []).append(dict(row))
    families: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for archetype, colors, set_code in grouped:
        dated = max(str(item.get("release_date") or "") for item in grouped[(archetype, colors, set_code)])
        families.setdefault((archetype, colors), []).append((dated, set_code))
    holdout_groups: set[tuple[str, str, str]] = set()
    for (archetype, colors), members in families.items():
        members.sort()
        if len(members) >= 2:
            holdout_groups.add((archetype, colors, members[-1][1]))
            continue
        year = int(members[0][0][:4] or "0") if members[0][0][:4].isdigit() else 0
        if year >= recent_year:
            holdout_groups.add((archetype, colors, members[0][1]))
    assigned: list[dict] = []
    for key, items in grouped.items():
        split = "holdout" if key in holdout_groups else "train"
        for item in items:
            item["split"] = split
            assigned.append(item)
    holdout = sorted(
        (item for item in assigned if item["split"] == "holdout"),
        key=lambda item: str(item["id"]),
    )
    picked = 0
    per_archetype: dict[str, int] = {}
    benchmark_ids: set[str] = set()
    for item in holdout:
        archetype = str(item["archetype"])
        if per_archetype.get(archetype, 0) >= benchmark_per_archetype:
            continue
        if picked >= benchmark_cap:
            break
        benchmark_ids.add(str(item["id"]))
        per_archetype[archetype] = per_archetype.get(archetype, 0) + 1
        picked += 1
    for item in assigned:
        if str(item["id"]) in benchmark_ids:
            item["split"] = "benchmark"
    return assigned


def iter_mainboard_names(decks: Iterable[PoolDeck]) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for deck in decks:
        for line in deck.forge_list.splitlines():
            name = line.split(" ", 1)[1]
            if name not in seen:
                seen.add(name)
                names.append(name)
    return names
