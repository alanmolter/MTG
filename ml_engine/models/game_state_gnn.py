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
        own_hand, is_tapped,
        semantic_card_embedding (382 dims: supplied embedding or stable
        name/Oracle-text hashing fallback)
    ]  → total: 11 + 2 + 382 = 395 dims

    player features: [
        life, max_life_seen, mana_pool_total, mana_pool_colors (5),
        hand_size, library_size, graveyard_size, exile_size,
        turn_number, is_active_player, is_your_turn
    ]  → 15 dims

Output heads:
    action scorer(graph_embedding, legal-action source card) → [batch, 512]
    logits.  The source-card conditioning is essential because action slot 1
    means a different spell in different hands.
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
    card_feat_dim: int = 400        # scalar, semantic, controller/zone/combat
    player_feat_dim: int = 15       # must match MtgForgeEnv.observation_space player_feats width
    hidden_dim: int = 128
    num_layers: int = 3
    num_heads: int = 4
    num_actions: int = 512
    action_context_dim: int = 64
    action_descriptor_dim: int = 32
    num_action_kinds: int = 8
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
        # A fixed action id is not a card identity: action 1 is merely the
        # first *currently legal* source in Forge's canonical ordering.  Score
        # it against the source-card node selected by action_source_indices so
        # the policy can learn "cast this removal" rather than a spurious
        # preference for a position in a dynamic list.
        action_dim = min(cfg.action_context_dim, cfg.hidden_dim)
        self.action_state_proj = nn.Linear(pool_dim, action_dim, bias=False)
        self.action_source_proj = nn.Linear(cfg.hidden_dim, action_dim, bias=False)
        self.action_target_card_proj = nn.Linear(cfg.hidden_dim, action_dim, bias=False)
        self.action_target_player_proj = nn.Linear(cfg.hidden_dim, action_dim, bias=False)
        self.action_kind_embedding = nn.Embedding(cfg.num_action_kinds, action_dim)
        self.action_kind_bias = nn.Embedding(cfg.num_action_kinds, 1)
        self.action_descriptor_proj = nn.Linear(cfg.action_descriptor_dim, action_dim, bias=False)
        self.pass_action_key = nn.Parameter(torch.empty(action_dim))
        nn.init.normal_(self.pass_action_key, mean=0.0, std=0.02)
        self.value_head = nn.Sequential(
            nn.Linear(pool_dim, cfg.hidden_dim),
            nn.ReLU(),
            nn.Linear(cfg.hidden_dim, 1),
        )

    # ────────────────────────────────────────────────────────────────────────
    def forward(
        self,
        data: "HeteroData",
        action_source_indices: Optional["torch.Tensor"] = None,
        action_kinds: Optional["torch.Tensor"] = None,
        action_target_indices: Optional["torch.Tensor"] = None,
        action_descriptor_features: Optional["torch.Tensor"] = None,
    ) -> Dict[str, "torch.Tensor"]:
        """
        Args:
            data: HeteroData with:
                data["card"].x          — [N_card, card_feat_dim]
                data["player"].x        — [N_player, player_feat_dim]
                data["card"].batch      — [N_card]  (graph id per card node)
                data["player"].batch    — [N_player]
                data[rel].edge_index    — [2, E_rel] for each rel in EDGE_RELATIONS

        Returns:
            {"logits": [B, num_actions], "value": [B, 1]}.  When
            ``action_source_indices`` is supplied, each action logit is
            conditioned on the corresponding card-node embedding.
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
                updates = conv(x_dict, edge_index_dict)
                x_dict = {k: F.relu(v + updates.get(k, 0)) for k, v in x_dict.items()}
            else:
                x_dict = {k: F.relu(v) for k, v in x_dict.items()}

        # Pool per-graph (batched). HeteroData batching keeps node-to-graph
        # assignment in `.batch`.
        card_batch = getattr(data["card"], "batch", None)
        player_batch = getattr(data["player"], "batch", None)

        if card_batch is None:
            # Unbatched single graph — synthesize batch indices as all zeros.
            card_batch = torch.zeros(x_dict["card"].size(0), dtype=torch.long, device=x_dict["card"].device)
            player_batch = torch.zeros(x_dict["player"].size(0), dtype=torch.long, device=x_dict["player"].device)

        # Padding is not a card. A naive mean over max_cards makes the value
        # and policy heads depend on how much empty observation space remains.
        card_valid = (data["card"].x.abs().sum(dim=-1, keepdim=True) > 0).float()
        card_pool = global_mean_pool(x_dict["card"] * card_valid, card_batch)
        valid_fraction = global_mean_pool(card_valid, card_batch).clamp(min=1.0 / max(1, data["card"].x.size(0)))
        card_pool = card_pool / valid_fraction
        player_pool = global_mean_pool(x_dict["player"], player_batch)

        graph_emb = torch.cat([card_pool, player_pool], dim=-1)
        logits = self.action_head(graph_emb)
        if action_source_indices is not None:
            conditioned = self._conditioned_action_logits(
                graph_emb,
                x_dict["card"],
                x_dict["player"],
                action_source_indices,
                action_kinds,
                action_target_indices,
                action_descriptor_features,
            )
            # A malformed auxiliary mapping must not crash a training job or
            # silently invent a mapping; fall back to the legacy head.  The
            # preflight/capability gate rejects bridges that omit this mapping.
            if conditioned is not None:
                logits = conditioned
        value = self.value_head(graph_emb)
        return {"logits": logits, "value": value}

    def _conditioned_action_logits(
        self,
        graph_embedding: "torch.Tensor",
        card_embeddings: "torch.Tensor",
        player_embeddings: "torch.Tensor",
        action_source_indices: "torch.Tensor",
        action_kinds: Optional["torch.Tensor"],
        action_target_indices: Optional["torch.Tensor"],
        action_descriptor_features: Optional["torch.Tensor"] = None,
    ) -> Optional["torch.Tensor"]:
        """Score legal dynamic actions against their source card entity.

        ``action_source_indices[b, a]`` is a local card-node index for the
        a-th fixed policy output, or ``-1`` for pass/no source.  The env always
        pads each graph to the same card count, allowing a cheap gather from
        the batched node tensor.  Returning ``None`` deliberately preserves
        backward-compatible inference for old snapshots, while training's
        capability gate remains fail-closed about that old contract.
        """
        batch_size = graph_embedding.size(0)
        if not torch.is_tensor(action_source_indices):
            action_source_indices = torch.as_tensor(
                action_source_indices, device=graph_embedding.device
            )
        else:
            action_source_indices = action_source_indices.to(graph_embedding.device)
        if action_source_indices.ndim == 1:
            action_source_indices = action_source_indices.unsqueeze(0)
        if (
            action_source_indices.ndim != 2
            or action_source_indices.shape[0] != batch_size
            or action_source_indices.shape[1] != self.config.num_actions
            or card_embeddings.shape[0] % max(batch_size, 1) != 0
        ):
            return None

        cards_per_graph = card_embeddings.shape[0] // batch_size
        if cards_per_graph <= 0:
            return None
        card_embeddings = card_embeddings.reshape(batch_size, cards_per_graph, -1)
        source_indices = action_source_indices.long()
        valid_source = (source_indices >= 0) & (source_indices < cards_per_graph)
        safe_source = source_indices.clamp(min=0, max=cards_per_graph - 1)
        gathered = torch.gather(
            self.action_source_proj(card_embeddings),
            dim=1,
            index=safe_source.unsqueeze(-1).expand(-1, -1, self.action_state_proj.out_features),
        )
        pass_key = self.pass_action_key.view(1, 1, -1).expand_as(gathered)
        source_key = torch.where(valid_source.unsqueeze(-1), gathered, pass_key)

        if action_kinds is None:
            kinds = valid_source.long()  # 0 pass/no source, 1 play source
        else:
            if not torch.is_tensor(action_kinds):
                action_kinds = torch.as_tensor(action_kinds, device=graph_embedding.device)
            else:
                action_kinds = action_kinds.to(graph_embedding.device)
            if action_kinds.ndim == 1:
                action_kinds = action_kinds.unsqueeze(0)
            if action_kinds.shape != source_indices.shape:
                return None
            kinds = action_kinds.long()
        kinds = kinds.clamp(min=0, max=self.config.num_action_kinds - 1)

        query = torch.tanh(self.action_state_proj(graph_embedding)).unsqueeze(1)
        key = source_key + self.action_kind_embedding(kinds)
        if action_descriptor_features is not None:
            if not torch.is_tensor(action_descriptor_features):
                descriptors = torch.as_tensor(action_descriptor_features, device=graph_embedding.device)
            else:
                descriptors = action_descriptor_features.to(graph_embedding.device)
            if descriptors.ndim == 2:
                descriptors = descriptors.unsqueeze(0)
            if descriptors.shape != (batch_size, self.config.num_actions, self.config.action_descriptor_dim):
                return None
            key = key + self.action_descriptor_proj(descriptors.float())
        if action_target_indices is not None:
            if not torch.is_tensor(action_target_indices):
                target_indices = torch.as_tensor(action_target_indices, device=graph_embedding.device)
            else:
                target_indices = action_target_indices.to(graph_embedding.device)
            if target_indices.ndim == 1:
                target_indices = target_indices.unsqueeze(0)
            if target_indices.shape != source_indices.shape:
                return None
            target_indices = target_indices.long()
            valid_card_target = (target_indices >= 0) & (target_indices < cards_per_graph)
            safe_target = target_indices.clamp(min=0, max=cards_per_graph - 1)
            card_targets = torch.gather(
                self.action_target_card_proj(card_embeddings),
                dim=1,
                index=safe_target.unsqueeze(-1).expand(-1, -1, self.action_state_proj.out_features),
            )
            key = key + torch.where(valid_card_target.unsqueeze(-1), card_targets, torch.zeros_like(card_targets))

            players_per_graph = player_embeddings.shape[0] // batch_size
            if players_per_graph >= 2:
                players = self.action_target_player_proj(
                    player_embeddings.reshape(batch_size, players_per_graph, -1)
                )
                # Bridge contract: -2 names the policy player, -3 the opponent.
                safe_player = torch.where(target_indices == -2, 0, 1)
                player_targets = torch.gather(
                    players,
                    dim=1,
                    index=safe_player.unsqueeze(-1).expand(-1, -1, self.action_state_proj.out_features),
                )
                player_mask = (target_indices == -2) | (target_indices == -3)
                key = key + torch.where(player_mask.unsqueeze(-1), player_targets, torch.zeros_like(player_targets))
        key = torch.tanh(key)
        scale = float(self.action_state_proj.out_features) ** -0.5
        return (query * key).sum(dim=-1) * scale + self.action_kind_bias(kinds).squeeze(-1)

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


def _batched_dict_to_hetero(obs, edge_relations):
    """Convert a RLlib-batched Dict observation into a single batched HeteroData.

    RLlib feeds the model an `obs` dict whose tensors carry a leading batch axis:
        obs["card_feats"]             [B, N_card, card_dim]
        obs["player_feats"]           [B, N_player, player_dim]
        obs["controlled_by_edges"]    [B, 2, E]
        obs["in_zone_edges"]          [B, 2, E]
        obs["synergy_edges"]          [B, 2, E]
        obs["attacks_edges"]          [B, 2, E]

    We flatten along the batch axis so the GNN sees a single big disconnected
    graph and emit `.batch` index vectors so global_mean_pool can un-batch.

    Edge indices must be offset by the per-graph node count (so graph k's edges
    point into [k*N_card, (k+1)*N_card) for card-card edges, and similar offsets
    for card→player edges on the player side).
    """
    # torch is imported at module top; safe to use here
    card_feats = obs["card_feats"]             # [B, N, card_dim]
    player_feats = obs["player_feats"]         # [B, P, player_dim]
    B, N_card, _ = card_feats.shape
    P = player_feats.shape[1]
    device = card_feats.device

    data = HeteroData()
    data["card"].x = card_feats.reshape(B * N_card, -1).float()
    data["player"].x = player_feats.reshape(B * P, -1).float()
    data["card"].batch = torch.arange(B, device=device).repeat_interleave(N_card)
    data["player"].batch = torch.arange(B, device=device).repeat_interleave(P)

    edge_key_map = {
        ("card", "controlled_by", "player"): ("controlled_by_edges", "cp"),
        ("card", "in_zone",       "player"): ("in_zone_edges",       "cp"),
        ("card", "synergizes_with","card"):  ("synergy_edges",       "cc"),
        ("card", "attacks",       "card"):   ("attacks_edges",       "cc"),
    }
    for rel in edge_relations:
        obs_key, kind = edge_key_map[rel]
        if obs_key not in obs:
            continue
        raw = obs[obs_key]  # [B, 2, E]
        if raw.ndim != 3 or raw.shape[1] != 2:
            continue
        E = raw.shape[2]
        # Offset per-graph. For card→player, src gets card offset (k*N_card),
        # dst gets player offset (k*P). For card→card, both get card offsets.
        src_off = torch.arange(B, device=device).view(B, 1) * N_card                 # [B, 1]
        if kind == "cp":
            dst_off = torch.arange(B, device=device).view(B, 1) * P                  # [B, 1]
        else:
            dst_off = torch.arange(B, device=device).view(B, 1) * N_card
        src = (raw[:, 0, :].long() + src_off).reshape(-1)                             # [B*E]
        dst = (raw[:, 1, :].long() + dst_off).reshape(-1)                             # [B*E]
        # Padding is -1. Index 0 is a real card or player, including the edge
        # from the first card to player 0, so a (0, 0) pair must be kept.
        valid = (raw[:, 0, :] >= 0) & (raw[:, 1, :] >= 0)                             # [B, E]
        keep = valid.reshape(-1)
        if keep.any():
            data[rel].edge_index = torch.stack([src[keep], dst[keep]], dim=0)
        else:
            data[rel].edge_index = torch.zeros(2, 0, dtype=torch.long, device=device)
    return data


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
            obs = input_dict["obs"]
            # RLlib may hand us either a plain dict of tensors (Dict space) or a
            # pre-built HeteroData. Handle both.
            if isinstance(obs, HeteroData):
                data = obs
            else:
                data = _batched_dict_to_hetero(obs, GameStateGNN.EDGE_RELATIONS)
            try:
                action_sources = obs.get("action_source_indices") if isinstance(obs, dict) else None
                action_kinds = obs.get("action_kinds") if isinstance(obs, dict) else None
                action_targets = obs.get("action_target_indices") if isinstance(obs, dict) else None
                action_descriptors = obs.get("action_descriptor_features") if isinstance(obs, dict) else None
                out = self.gnn(data, action_sources, action_kinds, action_targets, action_descriptors)
            except RuntimeError as e:
                # CUBLAS_STATUS_EXECUTION_FAILED / cublasSgemm etc. typically
                # mean the CUDA context got corrupted by a prior reshape/OOM
                # failure (see TRAINING_TROUBLESHOOTING.md → "CUBLAS failure").
                # Surface a clear message so users don't chase the wrong ghost.
                msg = str(e).lower()
                if "cublas" in msg or "cuda" in msg:
                    raise RuntimeError(
                        "GNN forward hit a CUDA/CUBLAS failure. This is almost "
                        "always a cascade from an earlier error (OOM, tensor-shape "
                        "mismatch in IMPALA's _make_time_major, or another trial "
                        "killing the learner). Check the FIRST failure in the "
                        "trial log, not this one. See TRAINING_TROUBLESHOOTING.md. "
                        f"Original: {e}"
                    ) from e
                raise
            logits = out["logits"]
            # Apply action mask only when shapes line up. In Phase 3 the env may
            # use MultiDiscrete([4, 128, 128]) → logits has 260 columns while
            # the Forge-native mask is still 512 wide; skip masking in that
            # case (invalid actions get the illegal-action penalty instead).
            if isinstance(obs, dict) and "action_mask" in obs:
                mask = obs["action_mask"]
                if mask.shape[-1] == logits.shape[-1]:
                    mask = mask.to(dtype=torch.bool)
                    # Terminal/dummy rows may have no legal action. Give only
                    # the inert pass slot a finite logit; never unmask 512
                    # invalid actions just to avoid a NaN.
                    all_masked = ~mask.any(dim=-1, keepdim=True)
                    pass_only = torch.zeros_like(mask)
                    pass_only[..., 0] = True
                    effective_mask = mask | (all_masked & pass_only)
                    logits = logits.masked_fill(~effective_mask, float("-1e9"))
            self._value_out = out["value"].squeeze(-1)
            return logits, state

        def value_function(self):
            return self._value_out

    ModelCatalog.register_custom_model("game_state_gnn", RLlibWrapper)
    return True
