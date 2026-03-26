import { index, integer, pgEnum, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

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

// Decks competitivos importados de fontes externas (Moxfield, MTGGoldfish, etc.)
export const competitiveDecks = pgTable("competitive_decks", {
  id: serial("id").primaryKey(),
  sourceId: varchar("source_id", { length: 128 }).notNull().unique(),
  source: varchar("source", { length: 50 }).notNull().default("moxfield"),
  name: varchar("name", { length: 255 }).notNull(),
  format: varchar("format", { length: 50 }).notNull(),
  archetype: varchar("archetype", { length: 100 }),
  author: varchar("author", { length: 128 }),
  likes: integer("likes").default(0),
  views: integer("views").default(0),
  colors: varchar("colors", { length: 10 }),
  rawJson: text("raw_json"),
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