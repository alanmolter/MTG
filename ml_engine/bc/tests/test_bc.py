"""Behavior cloning: action mapping, masked loss, KL anchor, holdout accuracy."""

from __future__ import annotations

from pathlib import Path

import torch

from ml_engine.bc.actions import decision_counts, mapped_action, unmappable_rate
from ml_engine.bc.dataset import load_rows
from ml_engine.bc.eval import evaluate_checkpoint
from ml_engine.bc.record import record_games
from ml_engine.bc.regularize import anchored_rl_step, kl_coeff_for_iter, kl_to_anchor, load_anchor
from ml_engine.bc.train import load_bc_weights, masked_cross_entropy, train_behavior_clone
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
    assert trained["rows"] == 2
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
    same = torch.zeros(2, 4)
    mask = torch.ones(2, 4)
    assert float(kl_to_anchor(same, same.clone(), mask)) == 0.0
