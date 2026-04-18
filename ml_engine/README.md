# ml_engine

Python side of the 8-pillar MTG AI stack. Node/TypeScript handles the web API,
Drizzle schema, and the financial defense layer (RAG cache + Circuit Breaker).
Everything heavy lives here.

## Layout

```
ml_engine/
├── rag/                    # Pillar 4 — embeddings + FastAPI bridge
│   ├── embedder.py         #   Sentence Transformers (MiniLM, 384-dim)
│   ├── server.py           #   FastAPI on :8765 → /embed, /health
│   └── pgvector_writer.py  #   Bulk-insert card oracle embeddings
├── forge_worker/           # Pillars 6 + 7
│   ├── reward_shaper.py    #   Dense reward shaping
│   ├── loop_guard.py       #   Infinite-loop detection + toxic action log
│   └── tests/              #   pytest
├── models/
│   └── game_state_gnn.py   # Pillar 2 — HeteroConv + GATConv
└── ray_cluster/
    ├── env.py              # Pillar 5 — MtgForgeEnv (Gymnasium)
    └── orchestrator.py     # Pillar 1/7 — IMPALA + PBT league
```

## Quick start

```bash
# 1. Create venv
python -m venv .venv
.venv\Scripts\activate   # Windows
# source .venv/bin/activate  # Linux/mac

# 2. Install deps
pip install -r ml_engine/requirements.txt

# 3. Boot RAG bridge (keep this running during Node dev)
python -m ml_engine.rag.server

# 4. Backfill card embeddings (one-off)
python -m ml_engine.rag.pgvector_writer

# 5. Launch training (long-running)
python -m ml_engine.ray_cluster.orchestrator
```

## Env vars

| var                        | default                          | purpose                                 |
|----------------------------|----------------------------------|-----------------------------------------|
| `DATABASE_URL`             | —                                | Postgres DSN (required by pgvector_writer + orchestrator) |
| `RAG_SERVER_PORT`          | `8765`                           | FastAPI port                            |
| `EMBEDDING_MODEL`          | `sentence-transformers/all-MiniLM-L6-v2` | HuggingFace model id            |
| `FORGE_JAR`                | `forge/forge-gui-desktop.jar`    | path to Forge runnable jar              |
| `FORGE_TIMEOUT_SEC`        | `120`                            | per-turn timeout before env resets      |
| `RAY_RESULTS_DIR`          | `./ray_results`                  | Tune checkpoint root                    |

## Tests

```bash
pytest ml_engine/forge_worker/tests
```
