"""Sharded behavior-cloning rows: one JSON object per decision."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator


def write_shard(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")


def iter_rows(root: Path) -> Iterator[dict]:
    paths = sorted(root.glob("*.jsonl"))
    if not paths:
        raise FileNotFoundError(f"no BC shards in {root}")
    for path in paths:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    yield json.loads(line)


def load_rows(root: Path, *, split: str | None = None) -> list[dict]:
    rows = list(iter_rows(root))
    if split is None:
        return rows
    return [row for row in rows if row.get("split") == split]


DB_POOLS_ROOT = Path(__file__).resolve().parents[2] / "data" / "pools"


def db_pool_excluded_deck_ids(manifest: dict) -> set[str]:
    """Deck ids of a DB-backed pool manifest (data/pools/v3+) that are not train.

    Blocks holdout, benchmark and every entry with ``exclude_from_train`` or
    ``holdout_near`` (holdout_near decks keep ``split == "train"`` but are
    taken out of training).
    """

    blocked: set[str] = set()
    for deck in manifest.get("decks", []):
        if (
            deck.get("split") != "train"
            or deck.get("exclude_from_train")
            or deck.get("holdout_near")
        ):
            blocked.add(str(deck["deck_id"]))
    return blocked


def manifest_blocked_deck_ids(version: str | None = None) -> set[str]:
    """Deck ids the pool manifest marks holdout, benchmark or exclude_from_train.

    A behavior-cloning row that names one of these decks is not a training
    row, even if its ``split`` field says ``train``.
    """

    from ml_engine.ray_cluster.deck_pool import active_pool_version, decks_for_split

    resolved = version or active_pool_version()
    db_manifest = DB_POOLS_ROOT / f"v{resolved}" / "manifest.json"
    if db_manifest.is_file():
        return db_pool_excluded_deck_ids(json.loads(db_manifest.read_text(encoding="utf-8")))
    blocked: set[str] = set()
    for split in ("holdout", "benchmark"):
        for deck in decks_for_split(split, resolved):
            blocked.add(deck.deck_id)
    return blocked


def row_uses_blocked_deck(row: dict, blocked_deck_ids: set[str]) -> bool:
    named = {str(row.get("deck_id") or ""), str(row.get("opponent_id") or "")}
    named.discard("")
    return bool(named & blocked_deck_ids)


def row_is_v1(row: dict) -> bool:
    """Historical shards have no protocol, protocol 1, or label_version v1.

    Phase 1 trains only on rows the v2 bridge marked with protocol 2.
    """

    protocol = row.get("protocol", row.get("protocol_version"))
    label = row.get("label_version")
    if protocol in (1, "1", "v1") or label in (1, "1", "v1"):
        return True
    return protocol is None and label is None


def training_rows(rows: list[dict], blocked_deck_ids: set[str]) -> tuple[list[dict], int]:
    """Keep protocol-v2 ``split == train`` rows whose decks are not held out."""

    kept: list[dict] = []
    excluded = 0
    for row in rows:
        if row.get("split") != "train" or row_uses_blocked_deck(row, blocked_deck_ids) or row_is_v1(row):
            excluded += 1
            continue
        kept.append(row)
    return kept, excluded
