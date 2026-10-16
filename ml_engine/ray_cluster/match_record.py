"""Queue ``forge_matches`` rows and flush them off the RL worker.

The table is optional. When ``DATABASE_URL`` is unset, or
``FORGE_MATCH_RECORD=0``, nothing is queued. Rows are batched on a daemon
thread and written with a connect timeout and a statement timeout. The
connection is closed after every flush: ``with psycopg2.connect(...)`` only
ends the transaction, so leaving that as the only cleanup leaked sessions.

A slow or unreachable database is logged and the batch is dropped. Episode
step and reset only enqueue, so they do not wait on Postgres.
"""

from __future__ import annotations

import atexit
import logging
import os
import queue
import threading
from typing import Any, Optional, Sequence


logger = logging.getLogger("ml_engine.ray_cluster.match_record")

# Bounds a flush when Postgres accepts the TCP connection and then stalls.
CONNECT_TIMEOUT_SECONDS = 3
STATEMENT_TIMEOUT_MS = 3000
FLUSH_INTERVAL_SECONDS = 1.0
MAX_BATCH = 128
MAX_QUEUED = 4096

INSERT_FORGE_MATCH = """
INSERT INTO forge_matches (
    winner, turns, agent_deck_id, opponent_deck_id, seed,
    policy_version, pool_version, bridge_version
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
"""


def forge_match_params(
    *,
    agent_deck_id: Optional[str],
    opponent_deck_id: Optional[str],
    seed: Any,
    policy_version: Optional[str],
    pool_version: Optional[str],
    bridge_version: Optional[str],
    winner: Any = None,
    turns: Any = None,
) -> tuple:
    def _text(value: Any) -> Optional[str]:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    def _int(value: Any) -> Optional[int]:
        if value is None or value == "":
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    return (
        _int(winner),
        _int(turns),
        _text(agent_deck_id),
        _text(opponent_deck_id),
        _int(seed),
        _text(policy_version),
        _text(pool_version),
        _text(bridge_version),
    )


class _MatchWriter:
    """Background batch writer. ``enqueue`` never waits on the database."""

    def __init__(self) -> None:
        self._queue: queue.Queue = queue.Queue(maxsize=MAX_QUEUED)
        self._stop = threading.Event()
        self._flush_on_stop = True
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()

    def enqueue(self, params: tuple) -> bool:
        self._ensure_started()
        try:
            self._queue.put_nowait(params)
        except queue.Full:
            logger.warning("forge_matches queue full; dropping row")
            return False
        return True

    def flush(self) -> None:
        """Write queued rows. Database errors are logged and the rows dropped."""
        rows = self._drain()
        if not rows:
            return
        with self._write_lock:
            try:
                _write_rows(rows)
            except Exception as exc:
                logger.warning(
                    "forge_matches flush dropped %s row(s): %s",
                    len(rows),
                    exc,
                )

    def close(self, timeout: float = CONNECT_TIMEOUT_SECONDS + 1) -> None:
        """Stop the thread, flush what is left, and return even if Postgres stalls."""
        self._flush_on_stop = True
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=timeout)
            if thread.is_alive():
                logger.warning(
                    "forge_matches writer still running after %.1fs; skip the extra flush",
                    timeout,
                )
                return
        self.flush()

    def shutdown_for_tests(self, timeout: float = 0.5) -> None:
        """Stop the thread without writing. Used so tests do not touch a real database."""
        self._flush_on_stop = False
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=timeout)
        self._drain()

    def _ensure_started(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="forge-match-writer",
                daemon=True,
            )
            self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(FLUSH_INTERVAL_SECONDS):
            self.flush()
        if self._flush_on_stop:
            self.flush()

    def _drain(self) -> list:
        rows = []
        while len(rows) < MAX_BATCH:
            try:
                rows.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return rows


_writer: Optional[_MatchWriter] = None
_writer_lock = threading.Lock()
_atexit_registered = False


def _get_writer() -> _MatchWriter:
    global _writer, _atexit_registered
    with _writer_lock:
        if _writer is None:
            _writer = _MatchWriter()
        if not _atexit_registered:
            atexit.register(close_match_writer)
            _atexit_registered = True
        return _writer


def reset_match_writer_for_tests() -> None:
    """Drop the singleton so one test's thread cannot write during the next."""
    global _writer
    with _writer_lock:
        writer = _writer
        _writer = None
    if writer is not None:
        writer.shutdown_for_tests()


def flush_match_writer() -> None:
    """Flush pending rows. Safe to call when recording is disabled."""
    with _writer_lock:
        writer = _writer
    if writer is not None:
        writer.flush()


def close_match_writer() -> None:
    """Flush and stop the background thread. Idempotent."""
    with _writer_lock:
        writer = _writer
    if writer is not None:
        writer.close()


def _write_rows(rows: Sequence[tuple]) -> None:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL unset")
    import psycopg2

    conn = psycopg2.connect(
        dsn,
        connect_timeout=int(CONNECT_TIMEOUT_SECONDS),
        options=f"-c statement_timeout={int(STATEMENT_TIMEOUT_MS)}",
    )
    try:
        with conn.cursor() as cur:
            cur.executemany(INSERT_FORGE_MATCH, rows)
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def maybe_record_forge_match(**kwargs: Any) -> bool:
    """Enqueue one match row. Never connects and never raises on a full queue."""
    if os.environ.get("FORGE_MATCH_RECORD", "1") == "0":
        return False
    if not os.environ.get("DATABASE_URL"):
        return False
    params = forge_match_params(**kwargs)
    return _get_writer().enqueue(params)
