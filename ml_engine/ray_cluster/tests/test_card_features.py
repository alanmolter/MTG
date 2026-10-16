"""Regression tests for the stable card-text fallback representation."""

from __future__ import annotations

import numpy as np
import pytest

from ml_engine.ray_cluster.card_features import (
    SEMANTIC_CARD_DIM,
    hashed_oracle_vector,
    semantic_card_vector,
)


def test_text_hash_is_reproducible_and_normalised():
    first = hashed_oracle_vector(
        "Lightning Bolt",
        "Lightning Bolt deals 3 damage to any target.",
    )
    second = hashed_oracle_vector(
        "Lightning Bolt",
        "Lightning Bolt deals 3 damage to any target.",
    )

    assert first.shape == (SEMANTIC_CARD_DIM,)
    assert np.array_equal(first, second)
    assert np.linalg.norm(first) == pytest.approx(1.0, abs=1e-6)


def test_text_hash_distinguishes_meaningfully_different_cards():
    burn = hashed_oracle_vector("Lightning Bolt", "Lightning Bolt deals 3 damage to any target.")
    land = hashed_oracle_vector("Island", "({T}: Add {U}.)")

    assert not np.array_equal(burn, land)


def test_supplied_embedding_is_preferred_and_trimmed_for_state_slots():
    embedding = [float(index) for index in range(384)]
    result = semantic_card_vector({
        "name": "Ignored fallback",
        "oracle_text": "ignored",
        "oracle_embedding": embedding,
    })

    assert result.shape == (SEMANTIC_CARD_DIM,)
    assert np.array_equal(result, np.asarray(embedding[:SEMANTIC_CARD_DIM], dtype=np.float32))


def test_invalid_embedding_falls_back_to_text_without_nan():
    result = semantic_card_vector({
        "name": "Opt",
        "oracle_text": "Scry 1. Draw a card.",
        "oracle_embedding": [float("nan")] * 384,
    })

    assert np.isfinite(result).all()
    assert np.linalg.norm(result) > 0
