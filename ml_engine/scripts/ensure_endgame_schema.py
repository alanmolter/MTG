"""
ensure_endgame_schema — idempotent DB setup for the 8-pillar endgame.

Why this exists:
    drizzle-kit migrate choked on this project because _journal.json is still
    in mysql-era format (3 MySQL entries left over from before the Postgres
    migration). Rather than surgery on the journal, we apply the endgame
    migration (0005_endgame_pgvector.sql) directly via psycopg2. The SQL is
    entirely built on CREATE ... IF NOT EXISTS, so re-running is harmless.

    After applying we VERIFY the 7 expected tables are present and exit 0
    (success), 2 (still missing after apply), or 1 (other error).

Usage:
    python -m ml_engine.scripts.ensure_endgame_schema
    python -m ml_engine.scripts.ensure_endgame_schema --verify-only
    python -m ml_engine.scripts.ensure_endgame_schema --sql-file drizzle/0005_endgame_pgvector.sql
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

try:
    import psycopg2
except ImportError as e:
    print(f"[ensure_endgame_schema] psycopg2 missing: {e}", file=sys.stderr)
    sys.exit(1)


EXPECTED_TABLES = [
    "card_oracle_embeddings",
    "semantic_cache",
    "api_budget_ledger",
    "card_contextual_weight",
    "toxic_actions",
    "mcts_nodes",
    "league_state",
]


def find_project_root() -> Path:
    """Walk up from this file until we hit the dir containing package.json."""
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        if (parent / "package.json").is_file() and (parent / "drizzle").is_dir():
            return parent
    raise RuntimeError("Could not find project root (expected package.json + drizzle/)")


def get_present_tables(dsn: str) -> set[str]:
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = ANY(%s)
                """,
                (EXPECTED_TABLES,),
            )
            return {r[0] for r in cur.fetchall()}
    finally:
        conn.close()


def apply_sql_file(dsn: str, sql_path: Path) -> None:
    """Execute the whole SQL file as ONE transaction.

    Postgres is happy to get multiple statements separated by semicolons.
    We rely on every CREATE being guarded by IF NOT EXISTS, so re-running
    the same file after partial application is safe.
    """
    sql = sql_path.read_text(encoding="utf-8")
    conn = psycopg2.connect(dsn)
    try:
        conn.autocommit = False
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-only", action="store_true",
                    help="only check tables, do not apply SQL")
    ap.add_argument("--sql-file", default=None,
                    help="path to SQL file to apply (default: drizzle/0005_endgame_pgvector.sql)")
    ap.add_argument("--dsn", default=None,
                    help="override DATABASE_URL")
    args = ap.parse_args()

    dsn = args.dsn or os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
    if not dsn:
        print("[ensure_endgame_schema] DATABASE_URL not set", file=sys.stderr)
        return 1

    root = find_project_root()
    sql_path = Path(args.sql_file) if args.sql_file else root / "drizzle" / "0005_endgame_pgvector.sql"

    # First: see what's already there
    try:
        present_before = get_present_tables(dsn)
    except Exception as e:
        print(f"[ensure_endgame_schema] could not query DB: {e}", file=sys.stderr)
        return 1

    missing_before = [t for t in EXPECTED_TABLES if t not in present_before]
    print(f"[ensure_endgame_schema] present before: {sorted(present_before)}")
    print(f"[ensure_endgame_schema] missing before: {missing_before}")

    if args.verify_only:
        return 0 if not missing_before else 2

    if missing_before:
        if not sql_path.is_file():
            print(f"[ensure_endgame_schema] SQL file not found: {sql_path}", file=sys.stderr)
            return 1
        print(f"[ensure_endgame_schema] applying {sql_path.name}...")
        try:
            apply_sql_file(dsn, sql_path)
        except Exception as e:
            print(f"[ensure_endgame_schema] SQL apply failed: {e}", file=sys.stderr)
            return 1
        print("[ensure_endgame_schema] SQL applied. Re-verifying...")
    else:
        print("[ensure_endgame_schema] all expected tables already present. Nothing to do.")
        return 0

    # Re-verify after applying
    present_after = get_present_tables(dsn)
    missing_after = [t for t in EXPECTED_TABLES if t not in present_after]
    if missing_after:
        print(f"[ensure_endgame_schema] STILL MISSING after apply: {missing_after}", file=sys.stderr)
        return 2
    print(f"[ensure_endgame_schema] all {len(EXPECTED_TABLES)} tables present. OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
