"""forge_matches provenance parameters, and a writer that cannot stall rollout."""

from __future__ import annotations

import socket
import threading
import time

import pytest

from ml_engine.ray_cluster import match_record
from ml_engine.ray_cluster.match_record import (
    CONNECT_TIMEOUT_SECONDS,
    INSERT_FORGE_MATCH,
    STATEMENT_TIMEOUT_MS,
    forge_match_params,
    maybe_record_forge_match,
    reset_match_writer_for_tests,
)


_ROW = dict(
    agent_deck_id="burn",
    opponent_deck_id="control",
    seed=11,
    policy_version="checkpoints/bc.pt",
    pool_version="2",
    bridge_version="rlbridge-fase0",
    winner=1,
    turns=40,
)


@pytest.fixture(autouse=True)
def _isolate_writer(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("FORGE_MATCH_RECORD", raising=False)
    reset_match_writer_for_tests()
    yield
    reset_match_writer_for_tests()


def test_forge_match_params_keep_provenance_and_drop_bad_numbers():
    params = forge_match_params(
        agent_deck_id="burn",
        opponent_deck_id="control",
        seed="11",
        policy_version="checkpoints/bc.pt",
        pool_version="2",
        bridge_version="rlbridge-fase0",
        winner="1",
        turns=40,
    )
    assert params == (
        1, 40, "burn", "control", 11, "checkpoints/bc.pt", "2", "rlbridge-fase0",
        None, None, None, None, None,
    )
    blank = forge_match_params(
        agent_deck_id="  ",
        opponent_deck_id=None,
        seed="nope",
        policy_version=None,
        pool_version=None,
        bridge_version=None,
        winner="draw",
        turns=None,
    )
    assert blank == (None, None, None, None, None, None, None, None, None, None, None, None, None)
    counted = forge_match_params(
        agent_deck_id="burn",
        opponent_deck_id="stompy",
        seed=3,
        policy_version=None,
        pool_version=None,
        bridge_version=None,
        ai_fallback_decisions=4,
        policy_decisions=20,
        ai_fallback_by_kind={"assignCombatDamage": 4},
    )
    assert counted[10] == 4
    assert counted[11] == 20
    assert counted[12] == '{"assignCombatDamage": 4}'
    for column in (
        "agent_deck_id", "opponent_deck_id", "seed",
        "policy_version", "pool_version", "bridge_version",
        "policy_controlled", "protocol_version",
        "ai_fallback_decisions", "policy_decisions", "ai_fallback_by_kind",
    ):
        assert column in INSERT_FORGE_MATCH


def test_maybe_record_skips_without_dsn_or_when_disabled(monkeypatch):
    assert maybe_record_forge_match(**_ROW) is False
    monkeypatch.setenv("FORGE_MATCH_RECORD", "0")
    monkeypatch.setenv("DATABASE_URL", "postgres://unused/db")
    assert maybe_record_forge_match(**_ROW) is False


def _params(**overrides):
    row = dict(_ROW)
    row.update(overrides)
    return forge_match_params(**row)


def test_write_rows_closes_connection_and_passes_timeouts(monkeypatch):
    psycopg2 = pytest.importorskip("psycopg2")
    monkeypatch.setenv("DATABASE_URL", "postgres://fake/db")
    written = []
    seen = {}

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def executemany(self, sql, rows):
            assert sql == INSERT_FORGE_MATCH
            written.extend(rows)

    class _Conn:
        def __init__(self):
            self.closed = False
            self.committed = False

        def cursor(self):
            return _Cursor()

        def commit(self):
            self.committed = True

        def rollback(self):
            return None

        def close(self):
            self.closed = True

        def __enter__(self):
            raise AssertionError("psycopg2's connection context manager does not close")

        def __exit__(self, *args):
            return False

    def connect(dsn, **kwargs):
        seen.update(kwargs)
        conn = _Conn()
        seen["conn"] = conn
        return conn

    monkeypatch.setattr(psycopg2, "connect", connect)
    match_record._write_rows([_params(), _params(seed=12)])
    assert len(written) == 2
    assert seen["connect_timeout"] == CONNECT_TIMEOUT_SECONDS
    assert seen["options"] == f"-c statement_timeout={STATEMENT_TIMEOUT_MS}"
    assert seen["conn"].committed is True
    assert seen["conn"].closed is True


def test_unreachable_database_is_logged_and_does_not_raise(monkeypatch, caplog):
    psycopg2 = pytest.importorskip("psycopg2")
    monkeypatch.setenv("DATABASE_URL", "postgres://down/db")
    monkeypatch.setenv("FORGE_MATCH_RECORD", "1")

    def boom(*args, **kwargs):
        raise psycopg2.OperationalError("simulated down database")

    monkeypatch.setattr(psycopg2, "connect", boom)
    started = time.perf_counter()
    assert maybe_record_forge_match(**_ROW) is True
    assert time.perf_counter() - started < 0.25

    writer = match_record._MatchWriter()
    writer._queue.put_nowait(_params())
    with caplog.at_level("WARNING"):
        writer.flush()
    writer._queue.put_nowait(_params())
    writer.flush()
    assert "forge_matches flush dropped" in caplog.text


def test_slow_database_does_not_block_enqueue(monkeypatch):
    psycopg2 = pytest.importorskip("psycopg2")
    monkeypatch.setenv("DATABASE_URL", "postgres://slow/db")
    monkeypatch.setenv("FORGE_MATCH_RECORD", "1")
    monkeypatch.setattr(match_record, "FLUSH_INTERVAL_SECONDS", 0.01)
    started = threading.Event()
    release = threading.Event()

    def slow_connect(*args, **kwargs):
        started.set()
        release.wait(timeout=2)
        raise psycopg2.OperationalError("slow database")

    monkeypatch.setattr(psycopg2, "connect", slow_connect)
    try:
        t0 = time.perf_counter()
        assert maybe_record_forge_match(**_ROW) is True
        elapsed = time.perf_counter() - t0
        assert elapsed < 0.25
        assert started.wait(1.0)
    finally:
        release.set()


def _flush_one(monkeypatch, dsn: str) -> float:
    monkeypatch.setenv("DATABASE_URL", dsn)
    writer = match_record._MatchWriter()
    writer._queue.put_nowait(_params())
    started = time.perf_counter()
    writer.flush()
    return time.perf_counter() - started


def test_refused_port_flush_returns(monkeypatch):
    pytest.importorskip("psycopg2")
    monkeypatch.setattr(match_record, "CONNECT_TIMEOUT_SECONDS", 2)
    elapsed = _flush_one(monkeypatch, "postgresql://nobody:nobody@127.0.0.1:1/forge")
    assert elapsed < 2


def test_stalled_handshake_is_bounded_by_connect_timeout(monkeypatch):
    pytest.importorskip("psycopg2")
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    monkeypatch.setattr(match_record, "CONNECT_TIMEOUT_SECONDS", 2)
    try:
        elapsed = _flush_one(
            monkeypatch,
            f"postgresql://nobody:nobody@127.0.0.1:{port}/forge",
        )
    finally:
        server.close()
    # libpq treats a timeout below 2s as 2s, so the constant under test is 2.
    # Enqueue is separate and does not wait; this bounds the flush itself.
    assert elapsed < 5


def test_flush_repeats_until_the_queue_is_empty(monkeypatch):
    calls = []

    def write(rows):
        calls.append(list(rows))

    monkeypatch.setattr(match_record, "_write_rows", write)
    writer = match_record._MatchWriter()
    for seed in range(130):
        writer._queue.put_nowait(_params(seed=seed))
    writer.flush()
    assert [len(batch) for batch in calls] == [128, 2]
    assert writer.counters() == {
        "forge_matches_enqueued": 0,
        "forge_matches_written": 130,
        "forge_matches_dropped": 0,
    }
    assert writer._queue.empty()


def test_close_drains_the_queue_until_the_deadline(monkeypatch):
    monkeypatch.setattr(match_record, "MAX_BATCH", 1)

    def slow(_rows):
        time.sleep(0.15)

    monkeypatch.setattr(match_record, "_write_rows", slow)
    writer = match_record._MatchWriter()
    for seed in range(8):
        writer._queue.put_nowait(_params(seed=seed))
    started = time.perf_counter()
    writer.close(timeout=0.35)
    elapsed = time.perf_counter() - started
    counts = writer.counters()
    assert elapsed < 1.0
    assert 0 < counts["forge_matches_written"] < 8
    assert counts["forge_matches_dropped"] > 0
    assert counts["forge_matches_written"] + counts["forge_matches_dropped"] == 8
    assert writer._queue.empty()
