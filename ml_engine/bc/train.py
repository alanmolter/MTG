"""Supervised warm start: masked cross-entropy plus a value head."""

from __future__ import annotations

from pathlib import Path

import torch
import torch.nn.functional as F

from ml_engine.bc.dataset import load_rows
from ml_engine.models.game_state_gnn import GNNConfig, GameStateGNN, build_hetero_data


def masked_cross_entropy(logits: torch.Tensor, actions: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """``-log softmax(masked logits)`` at the expert action. Illegal slots are -1e9."""

    legal = mask.to(dtype=torch.bool)
    filled = logits.masked_fill(~legal, -1e9)
    log_probs = F.log_softmax(filled, dim=-1)
    picked = log_probs.gather(1, actions.view(-1, 1)).squeeze(1)
    return -picked


def _real_edges(edges: torch.Tensor) -> torch.Tensor:
    """Drop the -1 padding the environment uses for missing edges."""

    raw = edges[0] if edges.ndim == 3 else edges
    valid = (raw[0] >= 0) & (raw[1] >= 0)
    if bool(valid.any()):
        return raw[:, valid]
    return torch.zeros(2, 0, dtype=torch.long, device=edges.device)


def forward_rows(model: GameStateGNN, rows: list[dict], device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    logits = []
    values = []
    for row in rows:
        obs = {key: torch.tensor(value, device=device).unsqueeze(0) for key, value in row["obs"].items()}
        data = build_hetero_data(
            obs["card_feats"][0],
            obs["player_feats"][0],
            _real_edges(obs["controlled_by_edges"]),
            _real_edges(obs["in_zone_edges"]),
            _real_edges(obs["synergy_edges"]),
            _real_edges(obs["attacks_edges"]),
        )
        out = model(
            data,
            obs["action_source_indices"],
            obs["action_kinds"],
            obs["action_target_indices"],
            obs["action_descriptor_features"],
        )
        logits.append(out["logits"])
        values.append(out["value"].view(-1))
    return torch.cat(logits, dim=0), torch.cat(values, dim=0)


def train_behavior_clone(
    shard_root: Path,
    checkpoint: Path,
    *,
    epochs: int = 1,
    value_coef: float = 0.5,
    max_rows: int | None = None,
    config: GNNConfig | None = None,
) -> dict:
    rows = load_rows(shard_root)
    if max_rows is not None:
        rows = rows[:max_rows]
    if not rows:
        raise RuntimeError(f"BC shard {shard_root} has no mapped decisions")
    device = torch.device("cpu")
    model = GameStateGNN(config or GNNConfig()).to(device)
    optim = torch.optim.Adam(model.parameters(), lr=1e-3)
    last_loss = 0.0
    model.train()
    for _ in range(epochs):
        optim.zero_grad()
        logits, values = forward_rows(model, rows, device)
        actions = torch.tensor([int(row["action"]) for row in rows], device=device)
        targets = torch.tensor([float(row["value"]) for row in rows], device=device)
        mask = torch.tensor([row["obs"]["action_mask"] for row in rows], device=device)
        policy = masked_cross_entropy(logits, actions, mask).mean()
        value = F.mse_loss(values, targets)
        loss = policy + value_coef * value
        if not torch.isfinite(loss):
            raise RuntimeError("BC loss is not finite")
        loss.backward()
        optim.step()
        last_loss = float(loss.detach())
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "model": model.state_dict(),
        "loss": last_loss,
        "rows": len(rows),
        "epochs": epochs,
    }
    torch.save(payload, checkpoint)
    return {"loss": last_loss, "rows": len(rows), "checkpoint": str(checkpoint)}


def load_bc_weights(model: torch.nn.Module, path: str | Path) -> None:
    blob = torch.load(Path(path), map_location="cpu")
    state = blob["model"] if isinstance(blob, dict) and "model" in blob else blob
    model.load_state_dict(state)
