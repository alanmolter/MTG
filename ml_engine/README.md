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
pytest ml_engine
```

## Behavior cloning and deck pool v2

Deck pool v1 stays the 14 Challenger lists. v2 is a separate manifest at
`ml_engine/ray_cluster/data/deck_pool/v2/` built from MIT-licensed MTGJSON
constructed decks and the Standard/Pioneer rows in the Postgres tournament
export. `deck_quality` plus Forge `cardsfolder` filename resolution decide
what is written. Rejections, licenses, and the train / holdout / benchmark
split are in `manifest.json` and `rejections.json`. Holdout is the newest
set inside each archetype and color pair, so a group is not split across
train and eval. Select it with `DECK_POOL_VERSION=2`.

Record Forge-AI vs Forge-AI decisions through rlbridge (the jar must be
rebuilt after `rlbridge_src` changes; see `rlbridge_src/README.md`):

```bash
python -m ml_engine.scripts.e2e_preflight --stage bc --work bc_smoke
```

That stores seed, deck id, the 512-wide mask, and the mapped action, and
prints the unmappable rate. Train the GNN with masked cross-entropy and a
value head, then start IMPALA from those weights:

```bash
python -m ml_engine.ray_cluster.orchestrator --bc-checkpoint bc_smoke/bc.pt --bc-kl-coeff 0.5 --bc-kl-iters 50
```

The KL term is `KL(current || BC)` on the legal mask and decays to 0 after
`--bc-kl-iters`. IMPALA's `entropy_coeff` stays on. The smoke checkpoint
uses a small GNN so the preflight can finish; a checkpoint that initializes
the training model has to be saved from the default `GNNConfig`. Holdout
eval reports action accuracy. Win rate versus Forge AI is not measured:
rlbridge still lets Forge's AI play both sides and does not apply `step`
actions.

Windows, one shot:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\e2e-preflight.ps1
```

The script prints PASS or FAIL for postgres, rlbridge, deck pools, database
lists that have cards, the BC record/train step, the RLlib config, and eval.
If a stopped container named `mtg-pgvector` was left by the old compose
service `db`, the script removes that stopped container and starts service
`postgres`. A container that is already running is reused.
