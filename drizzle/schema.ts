import { boolean, bigserial, customType, index, integer, jsonb, numeric, pgEnum, pgTable, serial, text, timestamp, varchar, real, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Custom pgvector type for Drizzle.
 *
 * Usage: vector(384)("embedding").notNull()
 *
 * Stores as `vector(N)` in Postgres; driver reads back a string like "[0.1,0.2,...]"
 * and we parse to number[]. Writes accept number[] and serialize to the same format.
 */
export const vector = (dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      // pgvector returns "[0.1,0.2,...]"
      if (typeof value !== "string") return [];
      return JSON.parse(value);
    },
  });

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */

export const roleEnum = pgEnum("role", ["user", "admin"]);

export const users = pgTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: serial("id").primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: roleEnum("role").default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const cards = pgTable(
  "cards",
  {
    id: serial("id").primaryKey(),
    scryfallId: varchar("scryfall_id", { length: 64 }).notNull().unique(),
    oracleId: varchar("oracle_id", { length: 64 }),
    name: varchar("name", { length: 255 }).notNull(),
    type: text("type"),
    colors: varchar("colors", { length: 10 }),
    cmc: integer("cmc"),
    rarity: varchar("rarity", { length: 20 }),
    imageUrl: text("image_url"),
    power: varchar("power", { length: 10 }),
    toughness: varchar("toughness", { length: 10 }),
    text: text("text"),
    priceUsd: real("price_usd"),
    isArena: integer("is_arena").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    nameIdx: index("name_idx").on(table.name),
    typeIdx: index("type_idx").on(table.type),
    colorsIdx: index("colors_idx").on(table.colors),
    cmcIdx: index("cmc_idx").on(table.cmc),
    rarityIdx: index("rarity_idx").on(table.rarity),
    oracleIdx: index("oracle_idx").on(table.oracleId),
  })
);

export type Card = typeof cards.$inferSelect;
export type InsertCard = typeof cards.$inferInsert;

export const decks = pgTable("decks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  format: varchar("format", { length: 50 }).notNull(),
  archetype: varchar("archetype", { length: 100 }),
  description: text("description"),
  isPublic: integer("is_public").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Deck = typeof decks.$inferSelect;
export type InsertDeck = typeof decks.$inferInsert;

export const deckCards = pgTable(
  "deck_cards",
  {
    id: serial("id").primaryKey(),
    deckId: integer("deck_id").notNull().references(() => decks.id),
    cardId: integer("card_id").notNull().references(() => cards.id),
    quantity: integer("quantity").notNull().default(1),
  },
  (table) => ({
    deckCardUnique: { unique: true, columns: [table.deckId, table.cardId] },
  })
);

export type DeckCard = typeof deckCards.$inferSelect;
export type InsertDeckCard = typeof deckCards.$inferInsert;

export const cardSynergies = pgTable(
  "card_synergies",
  {
    id: serial("id").primaryKey(),
    card1Id: integer("card1_id").notNull().references(() => cards.id),
    card2Id: integer("card2_id").notNull().references(() => cards.id),
    weight: integer("weight").notNull().default(0),
    coOccurrenceRate: integer("co_occurrence_rate").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    synergyUnique: { unique: true, columns: [table.card1Id, table.card2Id] },
  })
);

export type CardSynergy = typeof cardSynergies.$inferSelect;
export type InsertCardSynergy = typeof cardSynergies.$inferInsert;

export const metaStats = pgTable(
  "meta_stats",
  {
    id: serial("id").primaryKey(),
    cardId: integer("card_id").notNull().references(() => cards.id),
    format: varchar("format", { length: 50 }).notNull(),
    archetype: varchar("archetype", { length: 100 }),
    playRate: integer("play_rate").notNull().default(0),
    winRate: integer("win_rate").notNull().default(0),
    frequency: integer("frequency").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    metaStatsUnique: { unique: true, columns: [table.cardId, table.format, table.archetype] },
  })
);

export type MetaStat = typeof metaStats.$inferSelect;
export type InsertMetaStat = typeof metaStats.$inferInsert;

export const embeddingsCache = pgTable("embeddings_cache", {
  id: serial("id").primaryKey(),
  cardId: integer("card_id").notNull().unique().references(() => cards.id),
  vectorJson: text("vector_json").notNull(),
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type EmbeddingsCache = typeof embeddingsCache.$inferSelect;
export type InsertEmbeddingsCache = typeof embeddingsCache.$inferInsert;

// Decks competitivos importados de fontes externas (MTGGoldfish, MTGTop8)
export const competitiveDecks = pgTable("competitive_decks", {
  id: serial("id").primaryKey(),
  sourceId: varchar("source_id", { length: 128 }).notNull().unique(),
  source: varchar("source", { length: 50 }).notNull().default("mtggoldfish"),
  name: varchar("name", { length: 255 }).notNull(),
  format: varchar("format", { length: 50 }).notNull(),
  archetype: varchar("archetype", { length: 100 }),
  author: varchar("author", { length: 128 }),
  likes: integer("likes").default(0),
  views: integer("views").default(0),
  colors: varchar("colors", { length: 10 }),
  rawJson: text("raw_json"),
  /** Marca decks gerados sinteticamente (fallback quando API está indisponível).
   *  Decks sintéticos são excluídos do treinamento de embeddings para evitar
   *  contaminação com co-ocorrências que não existem em decks reais. */
  isSynthetic: boolean("is_synthetic").notNull().default(false),
  importedAt: timestamp("imported_at").defaultNow().notNull(),
});

export type CompetitiveDeck = typeof competitiveDecks.$inferSelect;
export type InsertCompetitiveDeck = typeof competitiveDecks.$inferInsert;

// Cartas de cada deck competitivo
export const competitiveDeckCards = pgTable(
  "competitive_deck_cards",
  {
    id: serial("id").primaryKey(),
    deckId: integer("deck_id").notNull().references(() => competitiveDecks.id),
    cardName: varchar("card_name", { length: 255 }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    section: varchar("section", { length: 20 }).default("mainboard"),
  },
  (table) => ({
    deckCardUnique: { unique: true, columns: [table.deckId, table.cardName, table.section] },
  })
);

export type CompetitiveDeckCard = typeof competitiveDeckCards.$inferSelect;
export type InsertCompetitiveDeckCard = typeof competitiveDeckCards.$inferInsert;

// Log de jobs de treinamento de embeddings
export const statusEnum = pgEnum("status", ["pending", "running", "completed", "failed"]);

export const trainingJobs = pgTable("training_jobs", {
  id: serial("id").primaryKey(),
  status: statusEnum("status").default("pending").notNull(),
  jobType: varchar("job_type", { length: 50 }).notNull().default("embeddings"),
  totalDecks: integer("total_decks").default(0),
  totalCards: integer("total_cards").default(0),
  embeddingsTrained: integer("embeddings_trained").default(0),
  synergiesUpdated: integer("synergies_updated").default(0),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export type TrainingJob = typeof trainingJobs.$inferSelect;
export type InsertTrainingJob = typeof trainingJobs.$inferInsert;

export const deckShares = pgTable("deck_shares", {
  id: serial("id").primaryKey(),
  shareId: varchar("share_id", { length: 255 }).notNull().unique(),
  deckId: integer("deck_id").notNull().references(() => decks.id),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  decklist: text("decklist").notNull(),
  format: varchar("format", { length: 50 }).notNull(),
  colors: text("colors"), 
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
});

export type DeckShare = typeof deckShares.$inferSelect;
export type InsertDeckShare = typeof deckShares.$inferInsert;

export const cardLearning = pgTable(
  "card_learning",
  {
    id: serial("id").primaryKey(),
    cardName: varchar("card_name", { length: 255 }).notNull().unique(),
    weight: real("weight").notNull().default(1.0),
    winCount: integer("win_count").notNull().default(0),
    lossCount: integer("loss_count").notNull().default(0),
    avgScore: real("avg_score").notNull().default(0.0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    weightIdx: index("learning_weight_idx").on(table.weight),
  })
);

export type CardLearning = typeof cardLearning.$inferSelect;
export type InsertCardLearning = typeof cardLearning.$inferInsert;

// Decisões do RL REINFORCE para retroalimentação em card_learning
export const rlDecisions = pgTable(
  "rl_decisions",
  {
    id: serial("id").primaryKey(),
    deckId: integer("deck_id"),
    cardName: varchar("card_name", { length: 255 }).notNull(),
    policyProbability: real("policy_probability").notNull().default(0),
    reward: real("reward"),
    /** false = aguardando resultado da partida; true = já processado em card_learning */
    processed: boolean("processed").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    processedIdx: index("rl_decisions_processed_idx").on(table.processed),
    cardNameIdx: index("rl_decisions_card_idx").on(table.cardName),
  })
);

export type RlDecision = typeof rlDecisions.$inferSelect;
export type InsertRlDecision = typeof rlDecisions.$inferInsert;

// ═══════════════════════════════════════════════════════════════════════════
//  ENDGAME ARCHITECTURE TABLES  (migration 0005)
// ═══════════════════════════════════════════════════════════════════════════

/** S3 — 384-dim MiniLM embeddings of Oracle text, used by semantic cache + RAG. */
export const cardOracleEmbeddings = pgTable("card_oracle_embeddings", {
  cardId: integer("card_id")
    .primaryKey()
    .references(() => cards.id, { onDelete: "cascade" }),
  embedding: vector(384)("embedding").notNull(),
  modelVersion: varchar("model_version", { length: 64 }).notNull().default("all-MiniLM-L6-v2"),
  textHash: varchar("text_hash", { length: 64 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CardOracleEmbedding = typeof cardOracleEmbeddings.$inferSelect;
export type InsertCardOracleEmbedding = typeof cardOracleEmbeddings.$inferInsert;

/** Pillar 4 — Semantic cache for LLM responses. L0 (exact hash) + L1 (vector similarity). */
export const semanticCache = pgTable("semantic_cache", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  queryHash: varchar("query_hash", { length: 64 }).notNull().unique(),
  queryEmbedding: vector(384)("query_embedding").notNull(),
  promptPreview: text("prompt_preview").notNull(),
  responseJson: jsonb("response_json").notNull(),
  modelUsed: varchar("model_used", { length: 64 }).notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  hitCount: integer("hit_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastHitAt: timestamp("last_hit_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export type SemanticCacheEntry = typeof semanticCache.$inferSelect;
export type InsertSemanticCacheEntry = typeof semanticCache.$inferInsert;

/** Pillar 4 — Hourly bucket ledger for rate limiting + budget breaker. */
export const apiBudgetLedger = pgTable("api_budget_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().unique(),
  callCount: integer("call_count").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  tripCount: integer("trip_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ApiBudgetLedger = typeof apiBudgetLedger.$inferSelect;
export type InsertApiBudgetLedger = typeof apiBudgetLedger.$inferInsert;

/** Pillar 8 — Contextual weights: replaces scalar card_learning.weight with
 *  a 32-dim vector sensitive to (commander, archetype). */
export const cardContextualWeight = pgTable(
  "card_contextual_weight",
  {
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    commanderId: integer("commander_id").references(() => cards.id, { onDelete: "cascade" }),
    archetype: varchar("archetype", { length: 32 }).notNull(),
    weightVec: vector(32)("weight_vec").notNull(),
    scalarSynergy: real("scalar_synergy").notNull().default(0),
    winCount: integer("win_count").notNull().default(0),
    lossCount: integer("loss_count").notNull().default(0),
    matchCount: integer("match_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    scalarIdx: index("idx_card_ctx_weight_scalar").on(table.archetype, table.scalarSynergy),
    commanderIdx: index("idx_card_ctx_weight_commander").on(table.commanderId, table.archetype),
  })
);

export type CardContextualWeight = typeof cardContextualWeight.$inferSelect;
export type InsertCardContextualWeight = typeof cardContextualWeight.$inferInsert;

/** Pillar 7 — Toxic actions registry: deck/card combos that trigger Forge loops. */
export const toxicActions = pgTable("toxic_actions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actionHash: varchar("action_hash", { length: 64 }).notNull().unique(),
  deckSnap: jsonb("deck_snap").notNull(),
  triggerReason: varchar("trigger_reason", { length: 64 }).notNull(),
  triggerCount: integer("trigger_count").notNull().default(1),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ToxicAction = typeof toxicActions.$inferSelect;
export type InsertToxicAction = typeof toxicActions.$inferInsert;

/** Pillar 5 — MCTS tree persistence across runs. */
export const mctsNodes = pgTable(
  "mcts_nodes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deckContext: varchar("deck_context", { length: 64 }).notNull(),
    parentId: integer("parent_id"),
    cardId: integer("card_id").references(() => cards.id),
    visits: integer("visits").notNull().default(0),
    totalValue: real("total_value").notNull().default(0),
    meanValue: real("mean_value").notNull().default(0),
    priorWeight: real("prior_weight").notNull().default(1.0),
    depth: integer("depth").notNull().default(0),
    expanded: boolean("expanded").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    contextIdx: index("idx_mcts_context").on(table.deckContext),
    ucbIdx: index("idx_mcts_ucb").on(table.deckContext, table.meanValue, table.visits),
  })
);

export type MctsNode = typeof mctsNodes.$inferSelect;
export type InsertMctsNode = typeof mctsNodes.$inferInsert;

/** Pillar 1 — PBT league state exposed to Node API for serving champion agents. */
export const leagueState = pgTable(
  "league_state",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentId: varchar("agent_id", { length: 64 }).notNull(),
    generation: integer("generation").notNull().default(0),
    isChampion: boolean("is_champion").notNull().default(false),
    archetypeBias: varchar("archetype_bias", { length: 32 }),
    hyperparams: jsonb("hyperparams"),
    episodeRewardMean: real("episode_reward_mean"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("idx_league_state_agent").on(table.agentId, table.generation),
  })
);

export type LeagueState = typeof leagueState.$inferSelect;
export type InsertLeagueState = typeof leagueState.$inferInsert;