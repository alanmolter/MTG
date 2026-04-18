"""
Pillar 4 + 5 — FastAPI bridge between Node and Python.

Exposes three routes on http://127.0.0.1:8765:

  POST /embed          — body {"text": "..."} or {"text": ["a", "b", ...]}
                         → {"embedding": [...]} or {"embeddings": [[...],[...]]}

  GET  /health         — liveness probe for run-stack.ps1

  POST /embed/cards    — admin: trigger pgvector_writer backfill in background

The server runs with `--workers 1` because the SentenceTransformer model is
loaded in-process and sharing across workers would multiply RAM 4×. For our
use case (one client = Node ragCache.ts) a single worker handles >500 req/s.

Launch:
    python -m ml_engine.rag.server
    # or:
    uvicorn ml_engine.rag.server:app --host 127.0.0.1 --port 8765
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import List, Union

from fastapi import BackgroundTasks, FastAPI, HTTPException
from pydantic import BaseModel, Field

from .embedder import EMBEDDING_DIM, embed, embed_batch, get_model

app = FastAPI(
    title="ml_engine RAG bridge",
    version="0.1.0",
    docs_url="/docs",
    redoc_url=None,
)

# ── Request / Response schemas ───────────────────────────────────────────────


class EmbedRequest(BaseModel):
    text: Union[str, List[str]] = Field(..., description="single string or list")


class EmbedSingleResponse(BaseModel):
    embedding: List[float]
    dim: int
    model: str
    elapsed_ms: float


class EmbedBatchResponse(BaseModel):
    embeddings: List[List[float]]
    dim: int
    model: str
    elapsed_ms: float


class HealthResponse(BaseModel):
    status: str
    model: str
    dim: int
    device: str


class AdminBackfillResponse(BaseModel):
    kicked_off: bool
    message: str


# ── Startup: preload the model so first request isn't slow ──────────────────


@app.on_event("startup")
async def _warm_model():
    # Fire in a thread so startup doesn't block if the HF cache is cold
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, get_model)


# ── Routes ──────────────────────────────────────────────────────────────────


@app.get("/health", response_model=HealthResponse)
def health():
    model = get_model()
    return HealthResponse(
        status="ok",
        model=os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"),
        dim=model.get_sentence_embedding_dimension(),
        device=str(model.device),
    )


@app.post("/embed")
def embed_endpoint(req: EmbedRequest):
    start = time.perf_counter()
    if isinstance(req.text, str):
        vec = embed(req.text)
        elapsed = (time.perf_counter() - start) * 1000
        return EmbedSingleResponse(
            embedding=vec.tolist(),
            dim=EMBEDDING_DIM,
            model=os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2"),
            elapsed_ms=round(elapsed, 2),
        )
    if isinstance(req.text, list):
        if not req.text:
            raise HTTPException(status_code=400, detail="empty list")
        if len(req.text) > 512:
            raise HTTPException(status_code=400, detail="batch > 512 not supported in one call")
        vecs = embed_batch(req.text)
        elapsed = (time.perf_counter() - start) * 1000
        return EmbedBatchResponse(
            embeddings=vecs.tolist(),
            dim=EMBEDDING_DIM,
            model=os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2"),
            elapsed_ms=round(elapsed, 2),
        )
    raise HTTPException(status_code=400, detail="text must be str or list[str]")


@app.post("/embed/cards", response_model=AdminBackfillResponse)
def admin_backfill_cards(background: BackgroundTasks):
    """Admin endpoint: schedule a full card_oracle_embeddings rebuild.
    Returns 202-ish immediately; writer runs in the background thread pool."""
    try:
        from .pgvector_writer import backfill_card_embeddings
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"writer import failed: {e}")

    background.add_task(backfill_card_embeddings)
    return AdminBackfillResponse(
        kicked_off=True,
        message="Backfill started. Follow progress via server logs.",
    )


# ── CLI entrypoint ──────────────────────────────────────────────────────────


def main():
    import uvicorn
    port = int(os.getenv("RAG_SERVER_PORT", "8765"))
    host = os.getenv("RAG_SERVER_HOST", "127.0.0.1")
    print(f"[rag.server] listening on http://{host}:{port}")
    uvicorn.run(
        "ml_engine.rag.server:app",
        host=host,
        port=port,
        workers=1,
        log_level="info",
    )


if __name__ == "__main__":
    main()
