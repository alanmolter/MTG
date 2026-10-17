"""Record Forge-AI vs Forge-AI decisions through the rlbridge JSON protocol.

Each snapshot's ``chosen_action`` is kept only when it lands on a legal slot
of the 512-wide mask. The unmappable rate is part of the dataset report.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Protocol

from ml_engine.bc.actions import decision_counts, mapped_action, unmappable_rate
from ml_engine.bc.dataset import write_shard


class Bridge(Protocol):
    def command(self, payload: Mapping[str, Any]) -> dict: ...


class SubprocessBridge:
    """One ForgeRLBridge JVM. stdout is the JSON protocol; Forge logs go to stderr.

    Reads go through ``_StdoutLineReader`` so a hung JVM raises instead of
    blocking the recorder forever. Replies whose ``request_id`` does not match
    the command just sent are discarded.
    """

    def __init__(
        self,
        forge_jar: Path,
        bridge_jar: Path,
        *,
        java: str = "java",
        cwd: Path | None = None,
        step_timeout: float = 12.0,
    ):
        from ml_engine.ray_cluster.env import java_step_timeout_seconds

        classpath = os.pathsep.join((str(forge_jar), str(bridge_jar)))
        self.step_timeout = float(step_timeout)
        self.java_step_timeout_seconds = java_step_timeout_seconds(self.step_timeout)
        self._request_seq = 0
        self._reader = None
        self.stale_replies_discarded = 0
        self.proc = subprocess.Popen(
            [java, "-Xmx1G", "-cp", classpath, "forge.rlbridge.ForgeRLBridge"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            cwd=str(cwd or Path.cwd()),
        )

    def command(self, payload: Mapping[str, Any], *, timeout: float | None = None) -> dict:
        from ml_engine.ray_cluster.env import _StdoutLineReader, response_matches

        if self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("rlbridge pipes are closed")
        self._request_seq += 1
        body = dict(payload)
        body["request_id"] = self._request_seq
        if body.get("cmd") == "new_game":
            body["step_timeout_seconds"] = self.java_step_timeout_seconds
        self.proc.stdin.write(json.dumps(body) + "\n")
        self.proc.stdin.flush()
        if self._reader is None or self._reader.stream is not self.proc.stdout:
            self._reader = _StdoutLineReader(self.proc.stdout)
        deadline = timeout if timeout is not None else (
            max(self.step_timeout, 60.0) if body.get("cmd") == "new_game" else self.step_timeout
        )
        import time
        end = time.monotonic() + deadline
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f"rlbridge {body.get('cmd')} timed out after {deadline}s "
                    f"(request_id={self._request_seq})"
                )
            try:
                line = self._reader.readline(remaining)
            except subprocess.TimeoutExpired as exc:
                raise TimeoutError(
                    f"rlbridge {body.get('cmd')} timed out after {deadline}s "
                    f"(request_id={self._request_seq})"
                ) from exc
            if line == "":
                raise RuntimeError("rlbridge closed stdout")
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict) or not response_matches(parsed, self._request_seq):
                self.stale_replies_discarded += 1
                continue
            return parsed

    def close(self) -> None:
        if self.proc.poll() is not None:
            return
        try:
            self.command({"cmd": "quit"})
        except Exception:
            self.proc.kill()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


@dataclass
class RecordReport:
    games: int
    decisions: int
    mapped: int
    unmappable: int
    unmappable_rate: float
    shard: str
    deck_ids: list[str] = field(default_factory=list)
    seeds: list[int] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "games": self.games,
            "decisions": self.decisions,
            "mapped": self.mapped,
            "unmappable": self.unmappable,
            "unmappable_rate": self.unmappable_rate,
            "shard": self.shard,
            "deck_ids": self.deck_ids,
            "seeds": self.seeds,
        }


def _encode(state: Mapping[str, Any]) -> dict:
    from ml_engine.ray_cluster.env import MtgForgeEnv

    env = MtgForgeEnv({"forge_jar": "stub", "bridge_jar": "stub", "max_cards": 128})
    obs = env._encode_observation(dict(state))
    return {key: value.tolist() for key, value in obs.items()}


def record_match(
    bridge: Bridge,
    *,
    agent_deck: str,
    opponent_deck: str,
    seed: int,
    deck_id: str,
    opponent_id: str,
    split: str,
    max_steps: int = 40,
    game_index: int = 0,
) -> tuple[list[dict], list[dict]]:
    """Play one AI-vs-AI game. Returns (trainable rows, every decision state)."""

    game_id = f"{split}:{deck_id}:{opponent_id}:{seed}:{game_index}"
    state = bridge.command({
        "cmd": "new_game",
        "agent_deck": agent_deck,
        "opponent_deck": opponent_deck,
        "seed": seed,
        # The external controller blocks per decision and fills chosen_action
        # with the Forge AI slot, including attacks, blocks, and targets.
        "agent_policy": "external",
    })
    seen: list[dict] = []
    rows: list[dict] = []
    for _ in range(max_steps):
        if not isinstance(state, dict):
            break
        if state.get("error"):
            break
        seen.append(state)
        action = mapped_action(state)
        if action is not None and not state.get("terminal"):
            rows.append({
                "game_id": game_id,
                "seed": seed,
                "deck_id": deck_id,
                "opponent_id": opponent_id,
                "split": split,
                "action": action,
                "decision_id": state.get("decision_id"),
                "decision_kind": state.get("decision_kind"),
                "chosen_action": state.get("chosen_action"),
                "protocol": 2,
                "label_version": 2,
                "obs": _encode(state),
            })
        if state.get("terminal"):
            break
        # An unmappable decision is not a pass label. Step the hinted slot
        # when it is legal; otherwise pass so the match can continue, and
        # leave the row out of the shard.
        step_action = 0 if action is None else action
        state = bridge.command({
            "cmd": "step",
            "action": step_action,
            "decision_id": state.get("decision_id", 0),
        })
    outcome = 0
    if isinstance(state, dict) and state.get("outcome") in (-1, 0, 1):
        outcome = int(state["outcome"])
    for row in rows:
        row["value"] = outcome
    return rows, seen


def record_games(
    bridge: Bridge,
    matchups: list[dict],
    shard_path,
    *,
    max_steps: int = 40,
) -> RecordReport:
    rows: list[dict] = []
    states: list[dict] = []
    seeds: list[int] = []
    deck_ids: list[str] = []
    for index, match in enumerate(matchups):
        game_rows, seen = record_match(bridge, max_steps=max_steps, game_index=index, **match)
        rows.extend(game_rows)
        states.extend(seen)
        seeds.append(int(match["seed"]))
        deck_ids.extend([str(match["deck_id"]), str(match["opponent_id"])])
    root = shard_path if shard_path.suffix == "" else shard_path.parent
    by_split: dict[str, list[dict]] = {}
    for row in rows:
        by_split.setdefault(str(row.get("split") or "train"), []).append(row)
    written: list[str] = []
    for split_name, split_rows in sorted(by_split.items()):
        path = root / f"{split_name}.jsonl"
        write_shard(path, split_rows)
        written.append(str(path))
    if not written:
        write_shard(root / "train.jsonl", [])
        written.append(str(root / "train.jsonl"))
    counts = decision_counts(states)
    report = RecordReport(
        games=len(matchups),
        decisions=counts["decisions"],
        mapped=counts["mapped"],
        unmappable=counts["unmappable"],
        unmappable_rate=unmappable_rate(counts),
        shard=",".join(written),
        deck_ids=deck_ids,
        seeds=seeds,
    )
    path = shard_path.parent / "record_report.json"
    path.write_text(json.dumps(report.as_dict(), indent=2), encoding="utf-8")
    return report
