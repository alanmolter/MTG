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
