import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const cards = mysqlTable("cards", {
  id: int("id").autoincrement().primaryKey(),
  scryfallId: varchar("scryfall_id", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  type: text("type"),
  colors: varchar("colors", { length: 10 }),
  cmc: int("cmc"),
  rarity: varchar("rarity", { length: 20 }),
  imageUrl: text("image_url"),
  power: varchar("power", { length: 10 }),
  toughness: varchar("toughness", { length: 10 }),
  text: text("text"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type Card = typeof cards.$inferSelect;
export type InsertCard = typeof cards.$inferInsert;

export const decks = mysqlTable("decks", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  format: varchar("format", { length: 50 }).notNull(),
  archetype: varchar("archetype", { length: 100 }),
  description: text("description"),
  isPublic: int("is_public").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type Deck = typeof decks.$inferSelect;
export type InsertDeck = typeof decks.$inferInsert;

export const deckCards = mysqlTable(
  "deck_cards",
  {
    id: int("id").autoincrement().primaryKey(),
    deckId: int("deck_id").notNull().references(() => decks.id),
    cardId: int("card_id").notNull().references(() => cards.id),
    quantity: int("quantity").notNull().default(1),
  },
  (table) => ({
    deckCardUnique: { unique: true, columns: [table.deckId, table.cardId] },
  })
);

export type DeckCard = typeof deckCards.$inferSelect;
export type InsertDeckCard = typeof deckCards.$inferInsert;

export const cardSynergies = mysqlTable(
  "card_synergies",
  {
    id: int("id").autoincrement().primaryKey(),
    card1Id: int("card1_id").notNull().references(() => cards.id),
    card2Id: int("card2_id").notNull().references(() => cards.id),
    weight: int("weight").notNull().default(0),
    coOccurrenceRate: int("co_occurrence_rate").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    synergyUnique: { unique: true, columns: [table.card1Id, table.card2Id] },
  })
);

export type CardSynergy = typeof cardSynergies.$inferSelect;
export type InsertCardSynergy = typeof cardSynergies.$inferInsert;

export const metaStats = mysqlTable(
  "meta_stats",
  {
    id: int("id").autoincrement().primaryKey(),
    cardId: int("card_id").notNull().references(() => cards.id),
    format: varchar("format", { length: 50 }).notNull(),
    archetype: varchar("archetype", { length: 100 }),
    playRate: int("play_rate").notNull().default(0),
    winRate: int("win_rate").notNull().default(0),
    frequency: int("frequency").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    metaStatsUnique: { unique: true, columns: [table.cardId, table.format, table.archetype] },
  })
);

export type MetaStat = typeof metaStats.$inferSelect;
export type InsertMetaStat = typeof metaStats.$inferInsert;

export const embeddingsCache = mysqlTable("embeddings_cache", {
  id: int("id").autoincrement().primaryKey(),
  cardId: int("card_id").notNull().unique().references(() => cards.id),
  vectorJson: text("vector_json").notNull(),
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type EmbeddingsCache = typeof embeddingsCache.$inferSelect;
export type InsertEmbeddingsCache = typeof embeddingsCache.$inferInsert;