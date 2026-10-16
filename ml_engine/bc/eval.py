"""Holdout evaluation for a behavior-cloning checkpoint.

Action accuracy is the fraction of holdout decisions whose legal argmax
matches the Forge AI action. A win rate against Forge AI is reported only
when the bridge actually applies the policy action. The current rlbridge
plays both sides with Forge's AI and ignores ``step`` actions, so win rate
stays unavailable until that controller lands. Accuracy still uses the
holdout split, which does not overlap the train lists.
"""

from __future__ import annotations

from pathlib import Path

import torch

from ml_engine.bc.dataset import load_rows
from ml_engine.bc.train import forward_rows, load_bc_weights
from ml_engine.models.game_state_gnn import GNNConfig, GameStateGNN


def holdout_action_accuracy(model: GameStateGNN, rows: list[dict]) -> dict:
    if not rows:
        raise RuntimeError("holdout BC eval has no rows")
    device = next(model.parameters()).device
    model.eval()
    with torch.no_grad():
        logits, _ = forward_rows(model, rows, device)
    correct = 0
    for index, row in enumerate(rows):
        mask = torch.tensor(row["obs"]["action_mask"], dtype=torch.bool)
        scores = logits[index].masked_fill(~mask, -1e9)
        chosen = int(scores.argmax())
        if chosen == int(row["action"]):
            correct += 1
    return {
        "metric": "holdout_action_accuracy",
        "rows": len(rows),
        "accuracy": correct / len(rows),
        "win_rate": None,
        "win_rate_reason": (
            "rlbridge Forge AI plays both sides and does not apply external "
            "actions, so a win rate vs Forge AI is not measured"
        ),
    }


def evaluate_checkpoint(checkpoint: Path, shard_root: Path, *, config: GNNConfig | None = None) -> dict:
    rows = [row for row in load_rows(shard_root) if row.get("split") == "holdout"]
    if not rows:
        rows = load_rows(shard_root)
    model = GameStateGNN(config or GNNConfig())
    load_bc_weights(model, checkpoint)
    return holdout_action_accuracy(model, rows)
