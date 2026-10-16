"""Deterministic, local semantic features for Forge card snapshots.

The Forge bridge cannot rely on a network service or a database lookup for
every game decision.  This module therefore provides a small, deterministic
fallback representation for a card's visible identity and Oracle text.  It is
not meant to replace a pretrained card embedding: when a 384-dimensional
embedding is present, :func:`semantic_card_vector` preserves it.  When one is
not present, a signed feature hash gives the policy enough information to
distinguish cards and share signal between rules-text tokens (``destroy``,
``flying``, ``draw``, etc.).

Python's built-in ``hash`` is deliberately *not* used: its process-randomised
seed would make the same replay encode differently after every restart,
invalidating reproducibility and checkpoints.
"""

from __future__ import annotations

from collections import Counter
import hashlib
import re
from typing import Any, Mapping, Sequence

import numpy as np


# Slots 0..10 of card_feats are numeric/type features; 11 and 12 represent
# private-hand visibility and tapped state.  The remaining slots are semantic.
SEMANTIC_CARD_DIM = 382
_TOKEN_RE = re.compile(r"[a-z0-9]+", re.IGNORECASE)
_MAX_TEXT_CHARS = 8_192
_MAX_FEATURE_TOKENS = 512


def _tokens(value: object) -> list[str]:
    """Normalise text into a bounded, portable token sequence."""
    if not isinstance(value, str):
        return []
    return _TOKEN_RE.findall(value.lower()[:_MAX_TEXT_CHARS])


def _hash_slot_and_sign(feature: str, dim: int) -> tuple[int, float]:
    """Map a feature to one signed hashing-trick coordinate stably."""
    digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
    number = int.from_bytes(digest, byteorder="little", signed=False)
    return number % dim, 1.0 if (number >> 63) == 0 else -1.0


def hashed_oracle_vector(
    name: object,
    oracle_text: object,
    *,
    dim: int = SEMANTIC_CARD_DIM,
) -> np.ndarray:
    """Return a unit-norm semantic vector derived from public card text.

    Names are tagged separately from Oracle words.  Adjacent Oracle bigrams
    retain useful short constructs such as ``deals damage`` and ``draw card``
    without requiring a heavyweight language model inside every Forge worker.
    """
    if dim <= 0:
        raise ValueError("dim must be positive")

    name_tokens = _tokens(name)
    oracle_tokens = _tokens(oracle_text)
    features: list[str] = [f"name:{token}" for token in name_tokens]
    features.extend(f"oracle:{token}" for token in oracle_tokens)
    features.extend(
        f"oracle_bigram:{left}_{right}"
        for left, right in zip(oracle_tokens, oracle_tokens[1:])
    )
    # Bound adversarial or unexpectedly verbose custom-card text.  Count
    # features instead of appending indefinitely so repeated words do not
    # change runtime unboundedly.
    counts = Counter(features[:_MAX_FEATURE_TOKENS])
    vector = np.zeros(dim, dtype=np.float32)
    for feature, frequency in counts.items():
        slot, sign = _hash_slot_and_sign(feature, dim)
        vector[slot] += sign * min(float(frequency), 3.0)

    norm = float(np.linalg.norm(vector))
    if norm > 0.0:
        vector /= norm
    return vector


def semantic_card_vector(
    card: Mapping[str, Any], *, dim: int = SEMANTIC_CARD_DIM
) -> np.ndarray:
    """Prefer a supplied embedding; otherwise derive a deterministic fallback.

    The upstream embedding contract is 384 dimensions.  Two positions are
    reserved in the environment for mutable zone/tapped state, so the first
    ``dim`` values are retained.  A malformed or non-finite embedding falls
    back to text rather than contaminating a rollout with NaNs.
    """
    raw_embedding: object = card.get("oracle_embedding")
    if isinstance(raw_embedding, Sequence) and not isinstance(raw_embedding, (str, bytes)):
        try:
            embedding = np.asarray(raw_embedding, dtype=np.float32).reshape(-1)
        except (TypeError, ValueError):
            embedding = np.empty(0, dtype=np.float32)
        if embedding.size >= dim and np.isfinite(embedding[:dim]).all():
            return embedding[:dim].copy()
    return hashed_oracle_vector(card.get("name", ""), card.get("oracle_text", ""), dim=dim)
