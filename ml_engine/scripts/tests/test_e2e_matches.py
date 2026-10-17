"""Preflight gate for forge_matches accounting. No Ray and no live Postgres."""

from __future__ import annotations

import pytest

from ml_engine.ray_cluster import match_record
from ml_engine.ray_cluster.match_record import reset_match_writer_for_tests
from ml_engine.scripts.e2e_preflight import stage_matches


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("FORGE_MATCH_RECORD", raising=False)
    monkeypatch.setattr(match_record, "FLUSH_INTERVAL_SECONDS", 30)
    reset_match_writer_for_tests()
    yield
    reset_match_writer_for_tests()


def test_stage_matches_passes_when_written_equals_episodes(monkeypatch):
    pytest.importorskip("psycopg2")
    monkeypatch.setenv("DATABASE_URL", "postgres://fake/db")
    monkeypatch.setenv("FORGE_MATCH_RECORD", "1")
    written = []

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def executemany(self, _sql, rows):
            written.extend(rows)

    class _Conn:
        def cursor(self):
            return _Cursor()

        def commit(self):
            return None

        def rollback(self):
            return None

        def close(self):
            return None

    monkeypatch.setattr("psycopg2.connect", lambda *args, **kwargs: _Conn())
    result = stage_matches(episodes=3)
    assert result["status"] == "PASS"
    assert result["episodes"] == 3
    assert result["forge_matches_written"] == 3
    assert result["forge_matches_dropped"] == 0
    assert len(written) == 3


def test_stage_matches_fails_when_rows_are_dropped(monkeypatch):
    psycopg2 = pytest.importorskip("psycopg2")
    monkeypatch.setenv("DATABASE_URL", "postgres://down/db")
    monkeypatch.setenv("FORGE_MATCH_RECORD", "1")

    def boom(*args, **kwargs):
        raise psycopg2.OperationalError("down")

    monkeypatch.setattr(psycopg2, "connect", boom)
    result = stage_matches(episodes=2)
    assert result["status"] == "FAIL"
    assert result["forge_matches_written"] == 0
    assert result["forge_matches_dropped"] == 2
