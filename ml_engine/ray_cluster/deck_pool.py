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
import random
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional, Sequence

from ml_engine.ray_cluster.deck_quality import canonical_deck_hash, deck_rejection_reason


logger = logging.getLogger(__name__)

POOL_ROOT = Path(__file__).resolve().parent / "data" / "deck_pool" / "v1"
POOL_VERSION = "1"

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


def accept_deck(deck_id: str, decklist: str) -> bool:
    """False when the list fails the quality gate. The reason is logged."""

    reason = deck_rejection_reason(deck_id, decklist)
    if reason is None:
        return True
    logger.warning("rejected deck %s: %s", deck_id, reason)
    return False


def _load_deck(entry: dict, root: Path) -> PoolDeck:
    deck_id = str(entry["id"]).strip()
    split = str(entry["split"]).strip().lower()
    if split not in {"train", "holdout"}:
        raise ValueError(f"{deck_id} split must be train or holdout, got {split!r}")
    relative = str(entry["file"])
    path = root / relative
    forge_list = arena_mainboard(path.read_text(encoding="utf-8"))
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
    )
    if not accept_deck(deck.deck_id, deck.forge_list):
        reason = deck_rejection_reason(deck.deck_id, deck.forge_list)
        raise RuntimeError(f"deck pool rejected {deck.deck_id}: {reason}")
    return deck


@lru_cache(maxsize=1)
def load_pool() -> tuple[PoolDeck, ...]:
    manifest_path = POOL_ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = str(manifest.get("version", ""))
    if version != POOL_VERSION:
        raise RuntimeError(f"deck pool version {version!r} != {POOL_VERSION!r}")
    decks = tuple(_load_deck(entry, POOL_ROOT) for entry in manifest["decks"])
    ids = [deck.deck_id for deck in decks]
    if len(ids) != len(set(ids)):
        raise RuntimeError("deck pool has duplicate ids")
    train = [deck for deck in decks if deck.split == "train"]
    holdout = [deck for deck in decks if deck.split == "holdout"]
    if len(train) < 2 or len(holdout) < 2:
        raise RuntimeError("deck pool needs at least two train and two holdout decks")
    train_hashes = {deck.sha256 for deck in train}
    overlap = [deck.deck_id for deck in holdout if deck.sha256 in train_hashes]
    if overlap:
        raise RuntimeError(f"holdout decks repeat a training list: {overlap}")
    return decks


def decks_for_split(split: str) -> tuple[PoolDeck, ...]:
    return tuple(deck for deck in load_pool() if deck.split == split)


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
