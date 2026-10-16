"""Tests for dynamic-action conditioning in the policy head."""

from __future__ import annotations

import torch

from ml_engine.models.game_state_gnn import GNNConfig, GameStateGNN, _batched_dict_to_hetero


def _small_model() -> GameStateGNN:
    return GameStateGNN(GNNConfig(
        hidden_dim=8,
        num_layers=1,
        num_heads=2,
        action_context_dim=4,
    ))


def test_dynamic_action_scores_depend_on_the_source_card():
    """Slots 1 and 2 must not be indistinguishable dynamic action labels."""
    model = _small_model()
    with torch.no_grad():
        model.action_state_proj.weight.fill_(1.0)
        model.action_source_proj.weight.fill_(1.0)
        model.action_kind_embedding.weight.zero_()
        model.action_kind_bias.weight.zero_()
        model.pass_action_key.zero_()

    graph = torch.ones((1, 16), dtype=torch.float32)
    players = torch.zeros((2, 8), dtype=torch.float32)
    # Three local card nodes: source 0 is weak, source 1 is strong.
    cards = torch.stack([
        torch.ones(8),
        torch.full((8,), 2.0),
        torch.zeros(8),
    ])
    sources = torch.full((1, 512), -1, dtype=torch.long)
    kinds = torch.zeros((1, 512), dtype=torch.long)
    sources[0, 1] = 0
    sources[0, 2] = 1
    kinds[0, 1:3] = 1

    logits = model._conditioned_action_logits(graph, cards, players, sources, kinds, None)

    assert logits is not None
    assert logits.shape == (1, 512)
    assert logits[0, 1] != logits[0, 2]


def test_malformed_action_source_mapping_falls_back_cleanly():
    model = _small_model()
    graph = torch.zeros((1, 16), dtype=torch.float32)
    cards = torch.zeros((3, 8), dtype=torch.float32)
    players = torch.zeros((2, 8), dtype=torch.float32)
    malformed = torch.zeros((1, 3), dtype=torch.long)

    assert model._conditioned_action_logits(graph, cards, players, malformed, None, None) is None


def test_targeted_actions_use_target_entity_in_policy_score():
    model = _small_model()
    with torch.no_grad():
        model.action_state_proj.weight.fill_(1.0)
        model.action_source_proj.weight.zero_()
        model.action_target_card_proj.weight.fill_(1.0)
        model.action_kind_embedding.weight.zero_()
        model.action_kind_bias.weight.zero_()
        model.pass_action_key.zero_()

    graph = torch.ones((1, 16), dtype=torch.float32)
    cards = torch.stack([torch.zeros(8), torch.ones(8), torch.full((8,), 2.0)])
    players = torch.zeros((2, 8), dtype=torch.float32)
    sources = torch.full((1, 512), -1, dtype=torch.long)
    targets = torch.full((1, 512), -1, dtype=torch.long)
    kinds = torch.zeros((1, 512), dtype=torch.long)
    sources[0, 1:3] = 0
    targets[0, 1] = 1
    targets[0, 2] = 2
    kinds[0, 1:3] = 4

    logits = model._conditioned_action_logits(graph, cards, players, sources, kinds, targets)

    assert logits is not None
    assert logits[0, 1] != logits[0, 2]


def test_abilities_on_same_permanent_have_distinct_policy_scores():
    model = _small_model()
    with torch.no_grad():
        model.action_state_proj.weight.fill_(1.0)
        model.action_source_proj.weight.zero_()
        model.action_target_card_proj.weight.zero_()
        model.action_descriptor_proj.weight.fill_(1.0)
        model.action_kind_embedding.weight.zero_()
        model.action_kind_bias.weight.zero_()
    graph = torch.ones((1, 16), dtype=torch.float32)
    cards = torch.zeros((2, 8), dtype=torch.float32)
    players = torch.zeros((2, 8), dtype=torch.float32)
    sources = torch.full((1, 512), -1, dtype=torch.long)
    kinds = torch.zeros((1, 512), dtype=torch.long)
    descriptors = torch.zeros((1, 512, 32), dtype=torch.float32)
    sources[0, 1:3] = 0
    kinds[0, 1:3] = 5
    descriptors[0, 1, :] = 0.1
    descriptors[0, 2, :] = 0.2

    logits = model._conditioned_action_logits(
        graph, cards, players, sources, kinds, None, descriptors
    )

    assert logits is not None
    assert logits[0, 1] != logits[0, 2]


def test_forge_observation_shape_runs_through_gnn():
    model = _small_model()
    obs = {
        "card_feats": torch.zeros((1, 4, 400)),
        "player_feats": torch.zeros((1, 2, 15)),
        "action_source_indices": torch.full((1, 512), -1, dtype=torch.long),
        "action_target_indices": torch.full((1, 512), -1, dtype=torch.long),
        "action_kinds": torch.zeros((1, 512), dtype=torch.long),
        "action_descriptor_features": torch.zeros((1, 512, 32)),
    }
    obs["card_feats"][0, 0, 9] = 1.0
    for edge in ("controlled_by_edges", "in_zone_edges", "synergy_edges", "attacks_edges"):
        obs[edge] = torch.zeros((1, 2, 4), dtype=torch.long)
    data = _batched_dict_to_hetero(obs, model.EDGE_RELATIONS)
    out = model(data, obs["action_source_indices"], obs["action_kinds"],
                obs["action_target_indices"], obs["action_descriptor_features"])
    assert out["logits"].shape == (1, 512)
    assert torch.isfinite(out["logits"]).all()
