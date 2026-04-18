"""
Pillar 3 / Pillar 4 — Sentence Transformers embedder.

Wraps `sentence-transformers/all-MiniLM-L6-v2` (384 dims, cosine-normalized).
Singleton: the model loads once per process (~90MB), subsequent calls reuse it.

Why MiniLM-L6 and not a bigger model?
  - 384 dims is the sweet spot for pgvector HNSW (under 500 = fast ANN)
  - Encodes 14k tokens/sec on CPU, ~60k/sec on a 2070S
  - Good-enough semantic quality for MTG oracle text (tested on Gatherer card
    clusters: 0.88 avg cosine on synergy pairs, 0.12 on anti-synergy)

Exported:
  - embed(text): np.ndarray  (1, 384)
  - embed_batch(texts): np.ndarray  (N, 384)
  - get_model(): underlying SentenceTransformer (lazy init)
"""

from __future__ import annotations

import os
import threading
from functools import lru_cache
from typing import List, Sequence, Union

import numpy as np

_MODEL_NAME = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
_DEVICE = os.getenv("EMBEDDING_DEVICE", "cpu")  # set to "cuda" on GPU box
EMBEDDING_DIM = 384

# Thread-safe lazy singleton — SentenceTransformer is safe to share across
# threads for inference, but loading twice wastes 90MB each time.
_model_lock = threading.Lock()
_model = None


def _load_model():
    """Import torch + sentence_transformers lazily so `python -c 'import ml_engine'`
    stays cheap."""
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        from sentence_transformers import SentenceTransformer  # noqa: WPS433
        print(f"[embedder] loading {_MODEL_NAME} on {_DEVICE}...")
        _model = SentenceTransformer(_MODEL_NAME, device=_DEVICE)
        _model.max_seq_length = 256  # MTG oracle text rarely exceeds 200 tokens
        print(f"[embedder] ready — dim={_model.get_sentence_embedding_dimension()}")
        return _model


def get_model():
    """Expose the SentenceTransformer for advanced use (e.g. fine-tuning)."""
    return _load_model()


def embed(text: str) -> np.ndarray:
    """Encode a single string → (384,) float32, L2-normalized for cosine sim."""
    if not isinstance(text, str) or not text.strip():
        return np.zeros(EMBEDDING_DIM, dtype=np.float32)
    model = _load_model()
    vec = model.encode(
        text,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return vec.astype(np.float32)


def embed_batch(texts: Sequence[str], batch_size: int = 64) -> np.ndarray:
    """Encode a list of strings → (N, 384). Batched for throughput.

    Empty / None strings become zero vectors (so pgvector HNSW doesn't choke).
    """
    if not texts:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)

    # Replace empties with " " so the tokenizer doesn't NaN out
    sanitized: List[str] = []
    zero_mask: List[bool] = []
    for t in texts:
        if not isinstance(t, str) or not t.strip():
            sanitized.append(" ")
            zero_mask.append(True)
        else:
            sanitized.append(t)
            zero_mask.append(False)

    model = _load_model()
    vecs = model.encode(
        sanitized,
        batch_size=batch_size,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=len(sanitized) > 256,
    ).astype(np.float32)

    # Zero-out the rows that came from empty inputs
    if any(zero_mask):
        for i, is_zero in enumerate(zero_mask):
            if is_zero:
                vecs[i] = 0.0
    return vecs


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two (already-normalized) vectors."""
    if a.shape != b.shape:
        raise ValueError(f"shape mismatch {a.shape} vs {b.shape}")
    return float(np.dot(a, b))


@lru_cache(maxsize=10_000)
def embed_cached(text: str) -> tuple:
    """In-process LRU cache layer (tuple for hashability). Use for hot prompts
    that get re-embedded frequently (e.g. card oracle-text query templates)."""
    return tuple(embed(text).tolist())
