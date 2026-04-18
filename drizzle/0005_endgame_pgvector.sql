-- ============================================================================
-- Migration 0005 — ENDGAME ARCHITECTURE
-- Enables pgvector + creates tables for Pillar 4 (RAG/Cache), Pillar 8 (Contextual Weights)
-- Idempotent: safe to run multiple times. Uses IF NOT EXISTS everywhere.
-- ============================================================================

-- ---- pgvector extension ----------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ---- Card Oracle Embeddings (S3 — Sentence Transformers output) ------------
-- 384-dim from all-MiniLM-L6-v2, normalized. One row per card.
CREATE TABLE IF NOT EXISTS card_oracle_embeddings (
  card_id        INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  embedding      vector(384) NOT NULL,
  model_version  VARCHAR(64) NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  text_hash      VARCHAR(64) NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index: cosine distance (<=>) on unit-normalized vectors == 1 - dot product
CREATE INDEX IF NOT EXISTS idx_card_oracle_embed_hnsw
  ON card_oracle_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ---- Semantic Cache (Pillar 4, L0 + L1) ------------------------------------
CREATE TABLE IF NOT EXISTS semantic_cache (
  id              BIGSERIAL PRIMARY KEY,
  query_hash      VARCHAR(64) NOT NULL UNIQUE,      -- SHA256(prompt)  -> L0 exact
  query_embedding vector(384) NOT NULL,             -- MiniLM output   -> L1 semantic
  prompt_preview  TEXT NOT NULL,                    -- first ~400 chars, for debugging
  response_json   JSONB NOT NULL,
  model_used      VARCHAR(64) NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(10, 6) NOT NULL DEFAULT 0,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_hit_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ                       -- optional TTL for errata
);

CREATE INDEX IF NOT EXISTS idx_semcache_embedding_hnsw
  ON semantic_cache USING hnsw (query_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_semcache_expires
  ON semantic_cache (expires_at)
  WHERE expires_at IS NOT NULL;

-- ---- API Budget Ledger (Pillar 4, L2 rate limit + L3 budget breaker) -------
-- One row per hourly bucket. UPSERT on window_start.
CREATE TABLE IF NOT EXISTS api_budget_ledger (
  id            BIGSERIAL PRIMARY KEY,
  window_start  TIMESTAMPTZ NOT NULL UNIQUE,        -- truncated to hour
  call_count    INTEGER NOT NULL DEFAULT 0,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(10, 6) NOT NULL DEFAULT 0,
  trip_count    INTEGER NOT NULL DEFAULT 0,         -- times breaker opened in window
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_budget_window ON api_budget_ledger (window_start DESC);

-- ---- Contextual Weights (Pillar 8) -----------------------------------------
-- Replaces scalar card_learning.weight. Per (card, commander, archetype) tuple.
-- weight_vec: 32-dim learned representation. scalar_synergy: denormalized avg for fast reads.
CREATE TABLE IF NOT EXISTS card_contextual_weight (
  card_id         INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  commander_id    INTEGER REFERENCES cards(id) ON DELETE CASCADE,   -- NULL for non-Commander formats
  archetype       VARCHAR(32) NOT NULL,                              -- aggro/control/midrange/combo/ramp/unknown
  weight_vec      vector(32) NOT NULL,
  scalar_synergy  REAL NOT NULL DEFAULT 0,
  win_count       INTEGER NOT NULL DEFAULT 0,
  loss_count      INTEGER NOT NULL DEFAULT 0,
  match_count     INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (card_id, commander_id, archetype)
);

-- Partial unique for rows without commander (NULL in PK treated specially by Postgres)
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_ctx_weight_no_commander
  ON card_contextual_weight (card_id, archetype)
  WHERE commander_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_card_ctx_weight_hnsw
  ON card_contextual_weight USING hnsw (weight_vec vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_card_ctx_weight_scalar
  ON card_contextual_weight (archetype, scalar_synergy DESC);

CREATE INDEX IF NOT EXISTS idx_card_ctx_weight_commander
  ON card_contextual_weight (commander_id, archetype)
  WHERE commander_id IS NOT NULL;

-- ---- Toxic Actions (Pillar 7 — loop prevention learning signal) ------------
-- Tracks deck/card combinations that trigger Forge engine loops.
CREATE TABLE IF NOT EXISTS toxic_actions (
  id           BIGSERIAL PRIMARY KEY,
  action_hash  VARCHAR(64) NOT NULL UNIQUE,         -- hash of card-tuple / archetype combo
  deck_snap    JSONB NOT NULL,                       -- which cards were on board/deck
  trigger_reason VARCHAR(64) NOT NULL,               -- HARD_TIMEOUT, STATE_REPEATED, TRIGGER_STORM
  trigger_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_toxic_actions_hash ON toxic_actions (action_hash);
CREATE INDEX IF NOT EXISTS idx_toxic_actions_recent ON toxic_actions (last_seen_at DESC);

-- ---- MCTS Tree Persistence (Pillar 5) --------------------------------------
-- Persist MCTS trees across restarts so deckbuilding doesn't start from scratch
CREATE TABLE IF NOT EXISTS mcts_nodes (
  id              BIGSERIAL PRIMARY KEY,
  deck_context    VARCHAR(64) NOT NULL,              -- commander_id|format|archetype hash
  parent_id       BIGINT REFERENCES mcts_nodes(id) ON DELETE CASCADE,
  card_id         INTEGER REFERENCES cards(id),
  visits          INTEGER NOT NULL DEFAULT 0,
  total_value     REAL NOT NULL DEFAULT 0,
  mean_value      REAL NOT NULL DEFAULT 0,
  prior_weight    REAL NOT NULL DEFAULT 1.0,
  depth           INTEGER NOT NULL DEFAULT 0,
  expanded        BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcts_context ON mcts_nodes (deck_context);
CREATE INDEX IF NOT EXISTS idx_mcts_parent ON mcts_nodes (parent_id);
CREATE INDEX IF NOT EXISTS idx_mcts_ucb ON mcts_nodes (deck_context, mean_value DESC, visits);

-- ---- League State (Pillar 1 — PBT champion tracking) -----------------------
-- Node.js reads this to know which agent is "the champion" for UI exposure.
CREATE TABLE IF NOT EXISTS league_state (
  id             BIGSERIAL PRIMARY KEY,
  agent_id       VARCHAR(64) NOT NULL,
  generation     INTEGER NOT NULL DEFAULT 0,
  is_champion    BOOLEAN NOT NULL DEFAULT FALSE,
  archetype_bias VARCHAR(32),
  hyperparams    JSONB,
  episode_reward_mean REAL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_league_state_champion ON league_state (is_champion) WHERE is_champion = TRUE;
CREATE INDEX IF NOT EXISTS idx_league_state_agent ON league_state (agent_id, generation DESC);
