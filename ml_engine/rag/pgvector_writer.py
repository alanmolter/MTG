"""
Pillar 4 — Bulk pgvector writer for `card_oracle_embeddings`.

Reads `cards` table, concatenates (name + " " + type_line + " " + oracle_text)
for each row, embeds in batches of 64, UPSERTs into card_oracle_embeddings.

Idempotent: uses ON CONFLICT DO UPDATE so re-running rebuilds stale rows.
Incremental: `--since` flag skips cards already embedded in the last N days.

Usage:
    python -m ml_engine.rag.pgvector_writer                 # full rebuild
    python -m ml_engine.rag.pgvector_writer --since-days 7  # only recent
    python -m ml_engine.rag.pgvector_writer --limit 1000    # smoke test
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Iterable, List, Sequence, Tuple

import numpy as np

try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError as e:  # pragma: no cover
    print(f"[pgvector_writer] psycopg2 missing — install `psycopg2-binary` ({e})")
    sys.exit(1)

from .embedder import EMBEDDING_DIM, embed_batch

BATCH_SIZE = 64
UPSERT_SQL = """
INSERT INTO card_oracle_embeddings (card_id, embedding, model_version, updated_at)
VALUES %s
ON CONFLICT (card_id) DO UPDATE SET
  embedding      = EXCLUDED.embedding,
  model_version  = EXCLUDED.model_version,
  updated_at     = NOW()
"""


def _vector_literal(vec: np.ndarray) -> str:
    """Format a numpy vector as a pgvector literal: '[0.1,0.2,...]'."""
    return "[" + ",".join(f"{float(x):.6f}" for x in vec) + "]"


def _load_cards_batch(
    cur,
    since_days: int | None,
    limit: int | None,
    offset: int,
    chunk: int,
) -> List[Tuple[int, str]]:
    """Pull (card_id, combined_text) rows from `cards` in chunks."""
    where = []
    params: list = []
    if since_days:
        where.append("updated_at > NOW() - INTERVAL '%s days'" % int(since_days))
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    # LIMIT/OFFSET pagination (simple, fine for a few hundred thousand rows).
    sql = f"""
        SELECT
          id,
          COALESCE(name, '') || ' ' ||
          COALESCE(type_line, '') || ' ' ||
          COALESCE(oracle_text, '') AS body
        FROM cards
        {where_sql}
        ORDER BY id
        OFFSET %s LIMIT %s
    """
    params.extend([offset, chunk])
    cur.execute(sql, params)
    rows = cur.fetchall()
    if limit is not None and (offset + len(rows)) > limit:
        rows = rows[: max(0, limit - offset)]
    return rows


def _insert_batch(
    cur,
    batch: Sequence[Tuple[int, np.ndarray]],
    model_version: str,
) -> None:
    """Push a batch of (card_id, vector) to card_oracle_embeddings."""
    if not batch:
        return
    rows = [(cid, _vector_literal(vec), model_version) for cid, vec in batch]
    execute_values(
        cur,
        UPSERT_SQL,
        rows,
        template="(%s, %s::vector, %s, NOW())",
        page_size=100,
    )


def backfill_card_embeddings(
    since_days: int | None = None,
    limit: int | None = None,
    dsn: str | None = None,
) -> dict:
    """Main backfill entrypoint — called from server.py /embed/cards and from CLI."""
    dsn = dsn or os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL env var required")

    model_version = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2").split("/")[-1]
    print(f"[pgvector_writer] connecting to {dsn.split('@')[-1].split('/')[0]}...")

    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    total = 0
    start = time.time()

    try:
        with conn.cursor() as cur:
            offset = 0
            chunk = 512  # cards fetched per SQL round-trip
            while True:
                rows = _load_cards_batch(cur, since_days, limit, offset, chunk)
                if not rows:
                    break

                texts = [r[1] for r in rows]
                ids = [r[0] for r in rows]

                # Embed in sub-batches of BATCH_SIZE
                for sub_start in range(0, len(texts), BATCH_SIZE):
                    sub_texts = texts[sub_start : sub_start + BATCH_SIZE]
                    sub_ids = ids[sub_start : sub_start + BATCH_SIZE]
                    vecs = embed_batch(sub_texts, batch_size=BATCH_SIZE)
                    if vecs.shape[1] != EMBEDDING_DIM:
                        raise RuntimeError(
                            f"[pgvector_writer] embedder returned dim {vecs.shape[1]}, expected {EMBEDDING_DIM}"
                        )
                    batch = list(zip(sub_ids, vecs))
                    _insert_batch(cur, batch, model_version)
                    total += len(batch)

                conn.commit()
                elapsed = time.time() - start
                rate = total / elapsed if elapsed > 0 else 0
                print(
                    f"[pgvector_writer] {total} cards embedded — "
                    f"{rate:.1f} cards/s, elapsed {elapsed:.1f}s"
                )
                offset += chunk
                if limit is not None and total >= limit:
                    break
    finally:
        conn.close()

    elapsed = time.time() - start
    print(f"[pgvector_writer] done — {total} cards in {elapsed:.1f}s")
    return {"cards_embedded": total, "elapsed_sec": round(elapsed, 1)}


# ── CLI ─────────────────────────────────────────────────────────────────────


def main():
    p = argparse.ArgumentParser(description="Bulk embed MTG cards → card_oracle_embeddings")
    p.add_argument("--since-days", type=int, default=None, help="only cards updated in last N days")
    p.add_argument("--limit", type=int, default=None, help="max cards to embed (smoke test)")
    p.add_argument("--dsn", type=str, default=None, help="override DATABASE_URL")
    args = p.parse_args()

    try:
        result = backfill_card_embeddings(
            since_days=args.since_days,
            limit=args.limit,
            dsn=args.dsn,
        )
        print(result)
    except Exception as e:  # pragma: no cover
        print(f"[pgvector_writer] FATAL: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
