"""
Pillar 2 — GameStateGNN (PyTorch Geometric).

A heterogeneous graph neural net that encodes a Magic: The Gathering game state
as a graph with TWO node types and FOUR edge types, then produces:

  • π(a|s) — action logits over a fixed action vocabulary (Discrete(512))
  • V(s)   — scalar state value for IMPALA/critic

Node types:
    card    — any card in any zone (battlefield, hand, graveyard, library)
    player  — you (agent) + opponent

Edge types:
    (card,   "controlled_by",  player)   # who owns the card
    (card,   "in_zone",        player)   # attached via zone-type encoded on edge
    (card,   "synergizes_with",card)     # precomputed synergy edges (oracle_text similarity ≥ 0.7)
    (card,   "attacks",        card)     # combat edges during combat

Features:
    card node features: [
        mana_value, power, toughness, loyalty,
        type_bitmap (creature/instant/sorcery/enchantment/artifact/land/planeswalker),
        is_tapped, is_attacking, is_blocking, is_summoning_sick,
        oracle_embedding (384-dim from card_oracle_embeddings table)
    ]  → total: 11 + 384 = 395 dims

    player features: [
        life, max_life_seen, mana_pool_total, mana_pool_colors (5),
        hand_size, library_size, graveyard_size, exile_size,
        turn_number, is_active_player, is_your_turn
    ]  → 14 dims

Output heads:
    action_head(graph_embedding) → [batch, 512] logits
    value_head(graph_embedding) → [batch, 1] scalar

Register with Ray RLlib via:
    ModelCatalog.register_custom_model("game_state_gnn", GameStateGNN)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch_geometric.data import HeteroData
    from torch_geometric.nn import GATConv, HeteroConv, global_mean_pool
except ImportError as e:  # pragma: no cover
    raise ImportError(
        f"GameStateGNN requires torch + torch-geometric. Install via requirements.txt. ({e})"
    )


# ── Config ──────────────────────────────────────────────────────────────────


@dataclass
class GNNConfig:
    card_feat_dim: int = 395        # 11 scalar + 384 embedding
    player_feat_dim: int = 14
    hidden_dim: int = 128
    num_layers: int = 3
    num_heads: int = 4
    num_actions: int = 512
    dropout: float = 0.1
    use_edge_attr: bool = False     # keep simple; can layer on later


# ── Model ───────────────────────────────────────────────────────────────────


class GameStateGNN(nn.Module):
    """Heterogeneous GNN: card/player nodes with four edge relations.

    Per layer: HeteroConv wrapping GATConv for each (src, rel, dst) combination.
    """

    EDGE_RELATIONS = [
        ("card", "controlled_by", "player"),
        ("card", "in_zone", "player"),
        ("card", "synergizes_with", "card"),
        ("card", "attacks", "card"),
    ]

    def __init__(self, config: Optional[GNNConfig] = None):
        super().__init__()
        self.config = config or GNNConfig()
        cfg = self.config

        # ── Input projections: map raw features → hidden_dim so GATConv has
        # consistent channel widths no matter the node type.
        self.card_proj = nn.Linear(cfg.card_feat_dim, cfg.hidden_dim)
        self.player_proj = nn.Linear(cfg.player_feat_dim, cfg.hidden_dim)

        # ── Hetero message-passing stack
        self.convs = nn.ModuleList()
        for _ in range(cfg.num_layers):
            conv_dict: Dict = {}
            for rel in self.EDGE_RELATIONS:
                conv_dict[rel] = GATConv(
                    in_channels=cfg.hidden_dim,
                    out_channels=cfg.hidden_dim // cfg.num_heads,
                    heads=cfg.num_heads,
                    dropout=cfg.dropout,
                    add_self_loops=False,  # explicit: we don't want self-loops on card→player
                )
            self.convs.append(HeteroConv(conv_dict, aggr="sum"))

        # ── Output heads (operate on pooled graph embedding: card_pool ⊕ player_pool)
        pool_dim = cfg.hidden_dim * 2
        self.action_head = nn.Sequential(
            nn.Linear(pool_dim, cfg.hidden_dim),
            nn.ReLU(),
            nn.Dropout(cfg.dropout),
            nn.Linear(cfg.hidden_dim, cfg.num_actions),
        )
        self.value_head = nn.Sequential(
            nn.Linear(pool_dim, cfg.hidden_dim),
            nn.ReLU(),
            nn.Linear(cfg.hidden_dim, 1),
        )

    # ────────────────────────────────────────────────────────────────────────
    def forward(self, data: "HeteroData") -> Dict[str, "torch.Tensor"]:
        """
        Args:
            data: HeteroData with:
                data["card"].x          — [N_card, card_feat_dim]
                data["player"].x        — [N_player, player_feat_dim]
                data["card"].batch      — [N_card]  (graph id per card node)
                data["player"].batch    — [N_player]
                data[rel].edge_index    — [2, E_rel] for each rel in EDGE_RELATIONS

        Returns:
            {"logits": [B, num_actions], "value": [B, 1]}
        """
        x_dict = {
            "card": F.relu(self.card_proj(data["card"].x)),
            "player": F.relu(self.player_proj(data["player"].x)),
        }
        edge_index_dict = {
            rel: data[rel].edge_index
            for rel in self.EDGE_RELATIONS
            if rel in data.edge_types and data[rel].num_edges > 0
        }

        for conv in self.convs:
            if edge_index_dict:
                x_dict = conv(x_dict, edge_index_dict)
            x_dict = {k: F.relu(v) for k, v in x_dict.items()}

        # Pool per-graph (batched). HeteroData batching keeps node-to-graph
        # assignment in `.batch`.
        card_batch = getattr(data["card"], "batch", None)
        player_batch = getattr(data["player"], "batch", None)

        if card_batch is None:
            # Unbatched single graph — synthesize batch indices as all zeros.
            card_batch = torch.zeros(x_dict["card"].size(0), dtype=torch.long, device=x_dict["card"].device)
            player_batch = torch.zeros(x_dict["player"].size(0), dtype=torch.long, device=x_dict["player"].device)

        card_pool = global_mean_pool(x_dict["card"], card_batch)
        player_pool = global_mean_pool(x_dict["player"], player_batch)

        graph_emb = torch.cat([card_pool, player_pool], dim=-1)
        logits = self.action_head(graph_emb)
        value = self.value_head(graph_emb)
        return {"logits": logits, "value": value}

    # ────────────────────────────────────────────────────────────────────────
    def act(self, data: "HeteroData", action_mask: Optional["torch.Tensor"] = None):
        """Inference helper. Applies action mask (for illegal actions) before
        taking argmax.

        action_mask: [B, num_actions] of bool. True = legal, False = illegal.
        """
        self.eval()
        with torch.no_grad():
            out = self.forward(data)
            logits = out["logits"]
            if action_mask is not None:
                logits = logits.masked_fill(~action_mask, float("-inf"))
            probs = F.softmax(logits, dim=-1)
            action = torch.argmax(probs, dim=-1)
            return action, probs, out["value"]


# ── Helper: numpy → HeteroData ──────────────────────────────────────────────


def build_hetero_data(
    card_feats,
    player_feats,
    controlled_by_edges,
    in_zone_edges,
    synergy_edges,
    attacks_edges,
) -> "HeteroData":
    """Factory: build a HeteroData from numpy arrays. Used by MtgForgeEnv.

    Each edge set is a (2, E) int64 tensor/array where row 0 is src and row 1 is dst.
    """
    data = HeteroData()
    data["card"].x = torch.as_tensor(card_feats, dtype=torch.float32)
    data["player"].x = torch.as_tensor(player_feats, dtype=torch.float32)

    data[("card", "controlled_by", "player")].edge_index = torch.as_tensor(
        controlled_by_edges, dtype=torch.long
    )
    data[("card", "in_zone", "player")].edge_index = torch.as_tensor(
        in_zone_edges, dtype=torch.long
    )
    data[("card", "synergizes_with", "card")].edge_index = torch.as_tensor(
        synergy_edges, dtype=torch.long
    )
    data[("card", "attacks", "card")].edge_index = torch.as_tensor(
        attacks_edges, dtype=torch.long
    )
    return data


# ── RLlib registration ─────────────────────────────────────────────────────


def register_with_rllib():
    """Expose the model to Ray under the name 'game_state_gnn'."""
    try:
        from ray.rllib.models import ModelCatalog
    except ImportError:
        return False

    from ray.rllib.models.torch.torch_modelv2 import TorchModelV2

    class RLlibWrapper(TorchModelV2, nn.Module):
        def __init__(self, obs_space, action_space, num_outputs, model_config, name):
            TorchModelV2.__init__(self, obs_space, action_space, num_outputs, model_config, name)
            nn.Module.__init__(self)
            cfg = GNNConfig(num_actions=num_outputs)
            self.gnn = GameStateGNN(cfg)
            self._value_out = None

        def forward(self, input_dict, state, seq_lens):
            # obs is assumed to be a pre-built HeteroData-like dict
            data = input_dict["obs"]
            out = self.gnn(data)
            self._value_out = out["value"].squeeze(-1)
            return out["logits"], state

        def value_function(self):
            return self._value_out

    ModelCatalog.register_custom_model("game_state_gnn", RLlibWrapper)
    return True
