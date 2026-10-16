"""Behavior cloning: action mapping, masked loss, KL anchor, holdout accuracy."""

from __future__ import annotations

from pathlib import Path

import torch

from ml_engine.bc.actions import decision_counts, mapped_action, unmappable_rate
from ml_engine.bc.dataset import load_rows, manifest_blocked_deck_ids, training_rows
from ml_engine.bc.eval import evaluate_checkpoint
from ml_engine.bc.record import record_games
from ml_engine.bc.regularize import anchored_rl_step, bc_kl_penalty, kl_coeff_for_iter, kl_to_anchor, load_anchor
from ml_engine.bc.train import load_bc_weights, masked_cross_entropy, train_behavior_clone
from ml_engine.ray_cluster.bc_kl_policy import apply_bc_kl_to_loss
from ml_engine.models.game_state_gnn import GNNConfig, GameStateGNN
from ml_engine.ray_cluster.env import MtgForgeEnv
from ml_engine.ray_cluster.tests.test_env_autoregressive import _minimal_state


TINY = GNNConfig(hidden_dim=8, num_layers=1, num_heads=2, action_context_dim=4)


def _legal(**overrides):
    state = _minimal_state(
        cards=[{"name": "Lightning Bolt", "zone": "hand", "is_instant": True, "oracle_text": "Deal 3 damage."}],
        action_mask=[1, 1] + [0] * 510,
        action_source_indices=[-1, 0] + [-1] * 510,
        action_target_indices=[-1] * 512,
        action_kinds=[0, 1] + [0] * 510,
        chosen_action=1,
        outcome=1,
    )
    state.update(overrides)
    return state


class _Scripted:
    def __init__(self, states):
        self.states = list(states)

    def command(self, _payload):
        if not self.states:
            return {"terminal": True, "outcome": 1}
        return self.states.pop(0)


def test_unmappable_actions_are_counted_and_dropped():
    legal = _legal()
    illegal = _legal(chosen_action=4)
    missing = _legal()
    missing.pop("chosen_action")
    assert mapped_action(legal) == 1
    assert mapped_action(illegal) is None
    assert mapped_action(missing) is None
    counts = decision_counts([legal, illegal, missing])
    assert counts == {"decisions": 3, "mapped": 1, "unmappable": 2}
    assert unmappable_rate(counts) == 2 / 3


def test_record_keeps_seed_deck_and_outcome(tmp_path: Path):
    terminal = _legal(terminal=True, outcome=-1, chosen_action=-1)
    report = record_games(
        _Scripted([_legal(), terminal]),
        [{
            "agent_deck": "4 Lightning Bolt\n56 Mountain",
            "opponent_deck": "4 Counterspell\n56 Island",
            "seed": 11,
            "deck_id": "burn",
            "opponent_id": "control",
            "split": "holdout",
        }],
        tmp_path / "shard.jsonl",
    )
    rows = load_rows(tmp_path)
    assert report.mapped == 1
    assert report.unmappable == 1
    assert rows[0]["seed"] == 11
    assert rows[0]["deck_id"] == "burn"
    assert rows[0]["split"] == "holdout"
    assert rows[0]["value"] == -1
    assert rows[0]["action"] == 1
    env = MtgForgeEnv({"forge_jar": "stub", "bridge_jar": "stub"})
    restored = {}
    for key, value in rows[0]["obs"].items():
        space = env.observation_space[key]
        restored[key] = __import__("numpy").asarray(value, dtype=space.dtype)
    assert env.observation_space.contains(restored)


def test_masked_loss_ignores_illegal_slots_and_trains(tmp_path: Path):
    logits = torch.zeros(1, 4)
    logits[0, 3] = 5.0
    loss = masked_cross_entropy(
        logits,
        torch.tensor([1]),
        torch.tensor([[1, 1, 0, 0]]),
    )
    assert torch.isfinite(loss).all()
    open_logits = torch.tensor([[0.0, 0.0, 5.0, 0.0]])
    restricted = masked_cross_entropy(open_logits, torch.tensor([1]), torch.tensor([[1, 1, 0, 0]]))
    unrestricted = masked_cross_entropy(open_logits, torch.tensor([1]), torch.tensor([[1, 1, 1, 1]]))
    assert float(restricted) < float(unrestricted)

    terminal = _legal(terminal=True, chosen_action=-1)
    record_games(
        _Scripted([_legal(), terminal, _legal(split="holdout"), terminal]),
        [
            {
                "agent_deck": "a", "opponent_deck": "b", "seed": 1,
                "deck_id": "a", "opponent_id": "b", "split": "train",
            },
            {
                "agent_deck": "c", "opponent_deck": "d", "seed": 2,
                "deck_id": "c", "opponent_id": "d", "split": "holdout",
            },
        ],
        tmp_path / "rows.jsonl",
    )
    trained = train_behavior_clone(tmp_path, tmp_path / "bc.pt", epochs=1, config=TINY)
    assert trained["rows"] == 1
    assert trained["excluded_rows"] == 1
    model = GameStateGNN(TINY)
    load_bc_weights(model, tmp_path / "bc.pt")
    anchor = load_anchor(tmp_path / "bc.pt", TINY)
    rows = load_rows(tmp_path)
    step = anchored_rl_step(model, anchor, rows, kl_coeff=kl_coeff_for_iter(0, bc_kl_coeff=1.0, bc_kl_iters=5))
    assert step["kl_coeff"] == 1.0
    assert step["entropy"] >= 0
    assert kl_coeff_for_iter(5, bc_kl_coeff=1.0, bc_kl_iters=5) == 0.0
    report = evaluate_checkpoint(tmp_path / "bc.pt", tmp_path, config=TINY)
    assert report["rows"] == 1
    assert 0.0 <= report["accuracy"] <= 1.0
    assert report["win_rate"] is None
    assert set(trained["game_ids"]).isdisjoint(report["game_ids"])
    assert trained["game_ids"] and report["game_ids"]
    (tmp_path / "holdout.jsonl").unlink()
    try:
        evaluate_checkpoint(tmp_path / "bc.pt", tmp_path, config=TINY)
        raise AssertionError("eval fell back to the training split")
    except RuntimeError as exc:
        assert "no holdout" in str(exc)
    same = torch.zeros(2, 4)
    mask = torch.ones(2, 4)
    assert float(kl_to_anchor(same, same.clone(), mask)) == 0.0


def test_train_and_holdout_game_ids_stay_disjoint_and_manifest_holdout_is_dropped():
    blocked = manifest_blocked_deck_ids("2")
    assert "azoriuscontrol_q05" in blocked
    kept, excluded = training_rows(
        [
            {"split": "train", "deck_id": "not-in-pool", "opponent_id": "also-not", "game_id": "keep", "protocol": 2},
            {"split": "train", "deck_id": "azoriuscontrol_q05", "opponent_id": "not-in-pool", "game_id": "leak", "protocol": 2},
            {"split": "holdout", "deck_id": "not-in-pool", "opponent_id": "not-in-pool", "game_id": "held", "protocol": 2},
            {"split": "train", "deck_id": "not-in-pool", "opponent_id": "also-not", "game_id": "v1", "protocol": 1},
        ],
        blocked,
    )
    assert [row["game_id"] for row in kept] == ["keep"]
    assert excluded == 3
    assert {row["game_id"] for row in kept}.isdisjoint({"leak", "held"})


def test_bc_kl_penalty_decays_to_zero():
    logits = torch.zeros(2, 4)
    anchor = torch.tensor([[2.0, 0.0, 0.0, 0.0], [0.0, 2.0, 0.0, 0.0]])
    mask = torch.ones(2, 4)
    penalty0, metrics0 = bc_kl_penalty(
        logits, anchor, mask, iteration=0, bc_kl_coeff=1.0, bc_kl_iters=10,
    )
    _penalty5, metrics5 = bc_kl_penalty(
        logits, anchor, mask, iteration=5, bc_kl_coeff=1.0, bc_kl_iters=10,
    )
    penalty10, metrics10 = bc_kl_penalty(
        logits, anchor, mask, iteration=10, bc_kl_coeff=1.0, bc_kl_iters=10,
    )
    assert metrics0["bc_kl_coeff"] == 1.0
    assert metrics5["bc_kl_coeff"] < metrics0["bc_kl_coeff"]
    assert metrics5["bc_kl"] < metrics0["bc_kl"]
    assert metrics10["bc_kl_coeff"] == 0.0
    assert float(penalty10) == 0.0
    assert metrics10["bc_kl"] == 0.0
    base = torch.tensor(3.0)
    assert float(apply_bc_kl_to_loss(base, penalty0)) == float(base + penalty0)
    assert apply_bc_kl_to_loss([base, base], penalty0)[0].item() == float(base + penalty0)


def test_record_bridge_discards_stale_replies_and_times_out(monkeypatch, tmp_path: Path):
    import json
    import subprocess
    import time

    from ml_engine.bc.record import SubprocessBridge

    class _Stdin:
        def write(self, _text: str) -> None:
            return None

        def flush(self) -> None:
            return None

    class _Stdout:
        def __init__(self, lines: list[str], delay: float = 0.0):
            self._lines = list(lines)
            self._delay = delay

        def readline(self) -> str:
            if self._delay:
                time.sleep(self._delay)
            return self._lines.pop(0) if self._lines else ""

    class _Proc:
        def __init__(self, stdout: _Stdout):
            self.stdin = _Stdin()
            self.stdout = stdout

        def poll(self):
            return None

    hanging = {}

    def _popen(*_args, **_kwargs):
        stdout = hanging["stdout"]
        return _Proc(stdout)

    monkeypatch.setattr(subprocess, "Popen", _popen)
    hanging["stdout"] = _Stdout([
        json.dumps({"request_id": 0, "turn": -1}) + "\n",
        json.dumps({"request_id": 1, "ok": True, "turn": 1}) + "\n",
    ])
    bridge = SubprocessBridge(tmp_path / "forge.jar", tmp_path / "bridge.jar", step_timeout=2.0)
    parsed = bridge.command({"cmd": "ping"}, timeout=2.0)
    assert parsed["turn"] == 1
    assert bridge.stale_replies_discarded == 1
    assert bridge.java_step_timeout_seconds < bridge.step_timeout

    hanging["stdout"] = _Stdout([], delay=1.0)
    slow = SubprocessBridge(tmp_path / "forge.jar", tmp_path / "bridge.jar", step_timeout=2.0)
    try:
        slow.command({"cmd": "ping"}, timeout=0.2)
        raise AssertionError("readline returned without a timeout")
    except TimeoutError:
        pass


def test_db_pool_manifest_excludes_holdout_near():
    from ml_engine.bc.dataset import db_pool_excluded_deck_ids, training_rows

    manifest = {"decks": [
        {"deck_id": 1, "split": "train", "holdout_near": False, "exclude_from_train": False},
        {"deck_id": 2, "split": "train", "holdout_near": True, "exclude_from_train": True},
        {"deck_id": 3, "split": "holdout", "holdout_near": False, "exclude_from_train": True},
        {"deck_id": 4, "split": "benchmark", "holdout_near": False, "exclude_from_train": True},
    ]}
    blocked = db_pool_excluded_deck_ids(manifest)
    assert blocked == {"2", "3", "4"}
    rows = [{"split": "train", "deck_id": str(i)} for i in (1, 2, 3, 4)]
    kept, excluded = training_rows(rows, blocked)
    assert [r["deck_id"] for r in kept] == ["1"] and excluded == 3


def test_committed_pool_v3_manifest_blocks_holdout_near():
    import json
    from ml_engine.bc.dataset import DB_POOLS_ROOT, manifest_blocked_deck_ids

    path = DB_POOLS_ROOT / "v3" / "manifest.json"
    if not path.is_file():
        return
    manifest = json.loads(path.read_text(encoding="utf-8"))
    blocked = manifest_blocked_deck_ids("3")
    for deck in manifest["decks"]:
        if deck.get("holdout_near"):
            assert deck.get("exclude_from_train") is True
            assert str(deck["deck_id"]) in blocked
