"""Keep early RL from collapsing off the behavior-cloning policy.

The extra term is KL(current || BC anchor) on the legal action mask, minus
an entropy bonus. It is applied for the first ``bc_kl_iters`` training
iterations. Gradient updates inside one iteration share that coefficient.
"""

from __future__ import annotations

from pathlib import Path

import torch
import torch.nn.functional as F

from ml_engine.bc.train import forward_rows, load_bc_weights, masked_cross_entropy
from ml_engine.models.game_state_gnn import GNNConfig, GameStateGNN


def masked_log_probs(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    legal = mask.to(dtype=torch.bool)
    return F.log_softmax(logits.masked_fill(~legal, -1e9), dim=-1)


def kl_to_anchor(logits: torch.Tensor, anchor_logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    log_pi = masked_log_probs(logits, mask)
    log_bc = masked_log_probs(anchor_logits.detach(), mask)
    pi = log_pi.exp()
    return (pi * (log_pi - log_bc)).sum(dim=-1).mean()


def entropy(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    log_pi = masked_log_probs(logits, mask)
    pi = log_pi.exp()
    return -(pi * log_pi).sum(dim=-1).mean()


def bc_kl_penalty(
    logits: torch.Tensor,
    anchor_logits: torch.Tensor,
    mask: torch.Tensor,
    *,
    iteration: int,
    bc_kl_coeff: float,
    bc_kl_iters: int,
) -> tuple[torch.Tensor, dict[str, float]]:
    """Weighted KL(current || BC anchor). The weight is ``kl_coeff_for_iter``.

    ``bc_kl`` is the term added to the learner loss, so it falls to 0 as the
    schedule decays. ``bc_kl_divergence`` is the unweighted KL.
    """

    coeff = kl_coeff_for_iter(iteration, bc_kl_coeff=bc_kl_coeff, bc_kl_iters=bc_kl_iters)
    divergence = kl_to_anchor(logits, anchor_logits, mask)
    penalty = logits.new_tensor(coeff) * divergence
    return penalty, {
        "bc_kl": float(penalty.detach()),
        "bc_kl_divergence": float(divergence.detach()),
        "bc_kl_coeff": float(coeff),
    }


def kl_coeff_for_iter(iteration: int, *, bc_kl_coeff: float, bc_kl_iters: int) -> float:
    if bc_kl_coeff <= 0 or bc_kl_iters <= 0 or iteration >= bc_kl_iters:
        return 0.0
    remaining = 1.0 - (iteration / bc_kl_iters)
    return bc_kl_coeff * remaining


def anchored_rl_step(
    model: GameStateGNN,
    anchor: GameStateGNN,
    rows: list[dict],
    *,
    kl_coeff: float,
    entropy_coeff: float = 0.01,
    value_coef: float = 0.5,
) -> dict[str, float]:
    """One policy step: expert NLL + value MSE + KL to BC - entropy."""

    device = next(model.parameters()).device
    model.train()
    anchor.eval()
    optim = torch.optim.Adam(model.parameters(), lr=1e-4)
    optim.zero_grad()
    logits, values = forward_rows(model, rows, device)
    with torch.no_grad():
        anchor_logits, _ = forward_rows(anchor, rows, device)
    actions = torch.tensor([int(row["action"]) for row in rows], device=device)
    targets = torch.tensor([float(row["value"]) for row in rows], device=device)
    mask = torch.tensor([row["obs"]["action_mask"] for row in rows], device=device)
    policy = masked_cross_entropy(logits, actions, mask).mean()
    value = F.mse_loss(values, targets)
    kl = kl_to_anchor(logits, anchor_logits, mask)
    ent = entropy(logits, mask)
    loss = policy + value_coef * value + kl_coeff * kl - entropy_coeff * ent
    if not torch.isfinite(loss):
        raise RuntimeError("anchored RL loss is not finite")
    loss.backward()
    optim.step()
    return {
        "loss": float(loss.detach()),
        "policy": float(policy.detach()),
        "value": float(value.detach()),
        "kl": float(kl.detach()),
        "entropy": float(ent.detach()),
        "kl_coeff": kl_coeff,
    }


def load_anchor(checkpoint: Path, config: GNNConfig | None = None) -> GameStateGNN:
    anchor = GameStateGNN(config or GNNConfig())
    load_bc_weights(anchor, checkpoint)
    anchor.eval()
    for param in anchor.parameters():
        param.requires_grad_(False)
    return anchor
