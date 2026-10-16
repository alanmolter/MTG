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
    """One ForgeRLBridge JVM. stdout is the JSON protocol; Forge logs go to stderr."""

    def __init__(self, forge_jar: Path, bridge_jar: Path, *, java: str = "java", cwd: Path | None = None):
        classpath = os.pathsep.join((str(forge_jar), str(bridge_jar)))
        self.proc = subprocess.Popen(
            [java, "-Xmx1G", "-cp", classpath, "forge.rlbridge.ForgeRLBridge"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            cwd=str(cwd or Path.cwd()),
        )

    def command(self, payload: Mapping[str, Any]) -> dict:
        if self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("rlbridge pipes are closed")
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("rlbridge closed stdout")
        return json.loads(line)

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
) -> tuple[list[dict], list[dict]]:
    """Play one AI-vs-AI game. Returns (trainable rows, every decision state)."""

    state = bridge.command({
        "cmd": "new_game",
        "agent_deck": agent_deck,
        "opponent_deck": opponent_deck,
        "seed": seed,
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
                "seed": seed,
                "deck_id": deck_id,
                "opponent_id": opponent_id,
                "split": split,
                "action": action,
                "obs": _encode(state),
            })
        if state.get("terminal"):
            break
        state = bridge.command({"cmd": "step", "action": 0})
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
    for match in matchups:
        game_rows, seen = record_match(bridge, max_steps=max_steps, **match)
        rows.extend(game_rows)
        states.extend(seen)
        seeds.append(int(match["seed"]))
        deck_ids.extend([str(match["deck_id"]), str(match["opponent_id"])])
    write_shard(shard_path, rows)
    counts = decision_counts(states)
    report = RecordReport(
        games=len(matchups),
        decisions=counts["decisions"],
        mapped=counts["mapped"],
        unmappable=counts["unmappable"],
        unmappable_rate=unmappable_rate(counts),
        shard=str(shard_path),
        deck_ids=deck_ids,
        seeds=seeds,
    )
    path = shard_path.parent / "record_report.json"
    path.write_text(json.dumps(report.as_dict(), indent=2), encoding="utf-8")
    return report
