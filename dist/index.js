var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// drizzle/schema.ts
var schema_exports = {};
__export(schema_exports, {
  cardSynergies: () => cardSynergies,
  cards: () => cards,
  competitiveDeckCards: () => competitiveDeckCards,
  competitiveDecks: () => competitiveDecks,
  deckCards: () => deckCards,
  decks: () => decks,
  embeddingsCache: () => embeddingsCache,
  metaStats: () => metaStats,
  trainingJobs: () => trainingJobs,
  users: () => users
});
import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
var users, cards, decks, deckCards, cardSynergies, metaStats, embeddingsCache, competitiveDecks, competitiveDeckCards, trainingJobs;
var init_schema = __esm({
  "drizzle/schema.ts"() {
    "use strict";
    users = mysqlTable("users", {
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
      lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull()
    });
    cards = mysqlTable("cards", {
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
      updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull()
    });
    decks = mysqlTable("decks", {
      id: int("id").autoincrement().primaryKey(),
      userId: int("user_id").notNull().references(() => users.id),
      name: varchar("name", { length: 255 }).notNull(),
      format: varchar("format", { length: 50 }).notNull(),
      archetype: varchar("archetype", { length: 100 }),
      description: text("description"),
      isPublic: int("is_public").default(0),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull()
    });
    deckCards = mysqlTable(
      "deck_cards",
      {
        id: int("id").autoincrement().primaryKey(),
        deckId: int("deck_id").notNull().references(() => decks.id),
        cardId: int("card_id").notNull().references(() => cards.id),
        quantity: int("quantity").notNull().default(1)
      },
      (table) => ({
        deckCardUnique: { unique: true, columns: [table.deckId, table.cardId] }
      })
    );
    cardSynergies = mysqlTable(
      "card_synergies",
      {
        id: int("id").autoincrement().primaryKey(),
        card1Id: int("card1_id").notNull().references(() => cards.id),
        card2Id: int("card2_id").notNull().references(() => cards.id),
        weight: int("weight").notNull().default(0),
        coOccurrenceRate: int("co_occurrence_rate").notNull().default(0),
        updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull()
      },
      (table) => ({
        synergyUnique: { unique: true, columns: [table.card1Id, table.card2Id] }
      })
    );
    metaStats = mysqlTable(
      "meta_stats",
      {
        id: int("id").autoincrement().primaryKey(),
        cardId: int("card_id").notNull().references(() => cards.id),
        format: varchar("format", { length: 50 }).notNull(),
        archetype: varchar("archetype", { length: 100 }),
        playRate: int("play_rate").notNull().default(0),
        winRate: int("win_rate").notNull().default(0),
        frequency: int("frequency").notNull().default(0),
        updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull()
      },
      (table) => ({
        metaStatsUnique: { unique: true, columns: [table.cardId, table.format, table.archetype] }
      })
    );
    embeddingsCache = mysqlTable("embeddings_cache", {
      id: int("id").autoincrement().primaryKey(),
      cardId: int("card_id").notNull().unique().references(() => cards.id),
      vectorJson: text("vector_json").notNull(),
      modelVersion: varchar("model_version", { length: 50 }).notNull(),
      createdAt: timestamp("created_at").defaultNow().notNull()
    });
    competitiveDecks = mysqlTable("competitive_decks", {
      id: int("id").autoincrement().primaryKey(),
      sourceId: varchar("source_id", { length: 128 }).notNull().unique(),
      source: varchar("source", { length: 50 }).notNull().default("moxfield"),
      name: varchar("name", { length: 255 }).notNull(),
      format: varchar("format", { length: 50 }).notNull(),
      archetype: varchar("archetype", { length: 100 }),
      author: varchar("author", { length: 128 }),
      likes: int("likes").default(0),
      views: int("views").default(0),
      colors: varchar("colors", { length: 10 }),
      rawJson: text("raw_json"),
      importedAt: timestamp("imported_at").defaultNow().notNull()
    });
    competitiveDeckCards = mysqlTable(
      "competitive_deck_cards",
      {
        id: int("id").autoincrement().primaryKey(),
        deckId: int("deck_id").notNull().references(() => competitiveDecks.id),
        cardName: varchar("card_name", { length: 255 }).notNull(),
        quantity: int("quantity").notNull().default(1),
        section: varchar("section", { length: 20 }).default("mainboard")
      },
      (table) => ({
        deckCardUnique: { unique: true, columns: [table.deckId, table.cardName, table.section] }
      })
    );
    trainingJobs = mysqlTable("training_jobs", {
      id: int("id").autoincrement().primaryKey(),
      status: mysqlEnum("status", ["pending", "running", "completed", "failed"]).default("pending").notNull(),
      jobType: varchar("job_type", { length: 50 }).notNull().default("embeddings"),
      totalDecks: int("total_decks").default(0),
      totalCards: int("total_cards").default(0),
      embeddingsTrained: int("embeddings_trained").default(0),
      synergiesUpdated: int("synergies_updated").default(0),
      errorMessage: text("error_message"),
      startedAt: timestamp("started_at").defaultNow().notNull(),
      completedAt: timestamp("completed_at")
    });
  }
});

// server/_core/env.ts
var ENV;
var init_env = __esm({
  "server/_core/env.ts"() {
    "use strict";
    ENV = {
      appId: process.env.VITE_APP_ID ?? "",
      cookieSecret: process.env.JWT_SECRET ?? "",
      databaseUrl: process.env.DATABASE_URL ?? "",
      oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
      ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
      isProduction: process.env.NODE_ENV === "production",
      forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
      forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
    };
  }
});

// server/db.ts
var db_exports = {};
__export(db_exports, {
  getDb: () => getDb,
  getUserByOpenId: () => getUserByOpenId,
  upsertUser: () => upsertUser
});
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres-js";
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const client = postgres(process.env.DATABASE_URL);
      _db = drizzle(client);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
async function upsertUser(user) {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values = {
      openId: user.openId
    };
    const updateSet = {};
    const textFields = ["name", "email", "loginMethod"];
    const assignNullable = (field) => {
      const value = user[field];
      if (value === void 0) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== void 0) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== void 0) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = /* @__PURE__ */ new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = /* @__PURE__ */ new Date();
    }
    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}
async function getUserByOpenId(openId) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return void 0;
  }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}
var _db;
var init_db = __esm({
  "server/db.ts"() {
    "use strict";
    init_schema();
    init_env();
    _db = null;
  }
});

// server/services/scryfall.ts
var scryfall_exports = {};
__export(scryfall_exports, {
  getCardById: () => getCardById,
  getCardByName: () => getCardByName,
  getCardsByIds: () => getCardsByIds,
  getScryfallCardByName: () => getScryfallCardByName,
  searchCards: () => searchCards,
  searchScryfallCards: () => searchScryfallCards,
  syncCardFromScryfall: () => syncCardFromScryfall
});
import { eq as eq2 } from "drizzle-orm";
async function searchScryfallCards(query) {
  try {
    const response = await fetch(
      `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&unique=cards`
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error("Scryfall search error:", error);
    return [];
  }
}
async function getScryfallCardByName(name) {
  try {
    const response = await fetch(
      `${SCRYFALL_API}/cards/named?exact=${encodeURIComponent(name)}`
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("Scryfall fetch error:", error);
    return null;
  }
}
async function syncCardFromScryfall(scryfallCard) {
  const db = await getDb();
  if (!db) return null;
  const insertData = {
    scryfallId: scryfallCard.id,
    name: scryfallCard.name,
    type: scryfallCard.type_line,
    colors: scryfallCard.colors?.join("") || null,
    cmc: scryfallCard.cmc,
    rarity: scryfallCard.rarity,
    imageUrl: scryfallCard.image_uris?.normal || null,
    power: scryfallCard.power || null,
    toughness: scryfallCard.toughness || null,
    text: scryfallCard.oracle_text || null
  };
  try {
    const existing = await db.select().from(cards).where(eq2(cards.scryfallId, scryfallCard.id)).limit(1);
    if (existing.length > 0) {
      return existing[0];
    }
    await db.insert(cards).values(insertData);
    const result = await db.select().from(cards).where(eq2(cards.scryfallId, scryfallCard.id)).limit(1);
    return result[0] || null;
  } catch (error) {
    console.error("Error syncing card:", error);
    return null;
  }
}
async function getCardByName(name) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(cards).where(eq2(cards.name, name)).limit(1);
  return result[0] || null;
}
async function searchCards(filters) {
  const db = await getDb();
  if (!db) return [];
  let baseQuery = db.select().from(cards);
  const results = await baseQuery.limit(100);
  return results.filter((card) => {
    if (filters.name && !card.name.toLowerCase().includes(filters.name.toLowerCase())) {
      return false;
    }
    if (filters.type && card.type && !card.type.toLowerCase().includes(filters.type.toLowerCase())) {
      return false;
    }
    if (filters.colors && card.colors) {
      const hasColor = filters.colors.split("").some((color) => card.colors?.includes(color));
      if (!hasColor) return false;
    }
    if (filters.cmc !== void 0 && card.cmc !== filters.cmc) {
      return false;
    }
    if (filters.rarity && card.rarity !== filters.rarity) {
      return false;
    }
    return true;
  });
}
async function getCardById(cardId) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(cards).where(eq2(cards.id, cardId)).limit(1);
  return result[0] || null;
}
async function getCardsByIds(cardIds) {
  const db = await getDb();
  if (!db) return [];
  if (cardIds.length === 0) return [];
  const { inArray } = await import("drizzle-orm");
  const result = await db.select().from(cards).where(inArray(cards.id, cardIds));
  return result;
}
var SCRYFALL_API;
var init_scryfall = __esm({
  "server/services/scryfall.ts"() {
    "use strict";
    init_db();
    init_schema();
    SCRYFALL_API = "https://api.scryfall.com";
  }
});

// server/services/embeddings.ts
var embeddings_exports = {};
__export(embeddings_exports, {
  clearEmbeddingsCache: () => clearEmbeddingsCache,
  cosineSimilarity: () => cosineSimilarity,
  findSimilarCards: () => findSimilarCards,
  findSimilarCardsForDeck: () => findSimilarCardsForDeck,
  getCardEmbedding: () => getCardEmbedding
});
import { eq as eq3 } from "drizzle-orm";
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
function generateSimpleEmbedding(card) {
  const embedding = new Array(50).fill(0);
  if (card.colors) {
    const colors = card.colors.split("");
    colors.forEach((color, idx) => {
      embedding[idx] = color.charCodeAt(0) / 100;
    });
  }
  if (card.cmc !== null) {
    embedding[5] = card.cmc / 10;
  }
  if (card.type) {
    const typeHash = card.type.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
    for (let i = 6; i < 15; i++) {
      embedding[i] = typeHash % (i + 1) / 100;
    }
  }
  if (card.rarity) {
    const rarityValue = { common: 0.1, uncommon: 0.3, rare: 0.6, mythic: 0.9 };
    embedding[15] = rarityValue[card.rarity] || 0.5;
  }
  if (card.id) {
    for (let i = 16; i < 50; i++) {
      embedding[i] = card.id * (i + 1) % 100 / 100;
    }
  }
  return embedding;
}
async function getCardEmbedding(cardId) {
  const db = await getDb();
  if (!db) return null;
  try {
    const cached = await db.select().from(embeddingsCache).where(eq3(embeddingsCache.cardId, cardId)).limit(1);
    if (cached.length > 0) {
      try {
        return JSON.parse(cached[0].vectorJson);
      } catch {
        return null;
      }
    }
    const card = await db.select().from(cards).where(eq3(cards.id, cardId)).limit(1);
    if (card.length === 0) return null;
    const embedding = generateSimpleEmbedding(card[0]);
    try {
      await db.insert(embeddingsCache).values({
        cardId,
        vectorJson: JSON.stringify(embedding),
        modelVersion: MODEL_VERSION
      });
    } catch (error) {
    }
    return embedding;
  } catch (error) {
    console.error("Error getting card embedding:", error);
    return null;
  }
}
async function findSimilarCards(cardId, limit = 10) {
  const db = await getDb();
  if (!db) return [];
  try {
    const sourceEmbedding = await getCardEmbedding(cardId);
    if (!sourceEmbedding) return [];
    const allCards = await db.select().from(cards).limit(1e3);
    const similarities = await Promise.all(
      allCards.filter((c) => c.id !== cardId).map(async (card) => {
        const embedding = await getCardEmbedding(card.id);
        if (!embedding) return { card, similarity: 0 };
        const similarity = cosineSimilarity(sourceEmbedding, embedding);
        return { card, similarity };
      })
    );
    return similarities.sort((a, b) => b.similarity - a.similarity).slice(0, limit).map((item) => ({
      ...item.card,
      similarity: item.similarity
    }));
  } catch (error) {
    console.error("Error finding similar cards:", error);
    return [];
  }
}
async function findSimilarCardsForDeck(deckCardIds, limit = 10) {
  if (deckCardIds.length === 0) return [];
  try {
    const embeddings = await Promise.all(
      deckCardIds.map((id) => getCardEmbedding(id))
    );
    const validEmbeddings = embeddings.filter((e) => e !== null);
    if (validEmbeddings.length === 0) return [];
    const avgEmbedding = new Array(50).fill(0);
    for (const embedding of validEmbeddings) {
      for (let i = 0; i < embedding.length; i++) {
        avgEmbedding[i] += embedding[i] / validEmbeddings.length;
      }
    }
    const db = await getDb();
    if (!db) return [];
    const allCards = await db.select().from(cards).limit(1e3);
    const similarities = await Promise.all(
      allCards.filter((c) => !deckCardIds.includes(c.id)).map(async (card) => {
        const embedding = await getCardEmbedding(card.id);
        if (!embedding) return { card, similarity: 0 };
        const similarity = cosineSimilarity(avgEmbedding, embedding);
        return { card, similarity };
      })
    );
    return similarities.sort((a, b) => b.similarity - a.similarity).slice(0, limit).map((item) => ({
      ...item.card,
      similarity: item.similarity
    }));
  } catch (error) {
    console.error("Error finding similar cards for deck:", error);
    return [];
  }
}
async function clearEmbeddingsCache() {
  const db = await getDb();
  if (!db) return false;
  try {
    await db.delete(embeddingsCache);
    return true;
  } catch (error) {
    console.error("Error clearing embeddings cache:", error);
    return false;
  }
}
var MODEL_VERSION;
var init_embeddings = __esm({
  "server/services/embeddings.ts"() {
    "use strict";
    init_db();
    init_schema();
    MODEL_VERSION = "v1.0";
  }
});

// server/services/synergy.ts
var synergy_exports = {};
__export(synergy_exports, {
  calculateDeckSynergy: () => calculateDeckSynergy,
  findBestCardForDeck: () => findBestCardForDeck,
  getCardSynergy: () => getCardSynergy,
  getSynergyNeighbors: () => getSynergyNeighbors,
  updateSynergy: () => updateSynergy
});
import { eq as eq4, and, or } from "drizzle-orm";
async function getCardSynergy(card1Id, card2Id) {
  const db = await getDb();
  if (!db) return 0;
  try {
    const result = await db.select().from(cardSynergies).where(
      or(
        and(eq4(cardSynergies.card1Id, card1Id), eq4(cardSynergies.card2Id, card2Id)),
        and(eq4(cardSynergies.card1Id, card2Id), eq4(cardSynergies.card2Id, card1Id))
      )
    ).limit(1);
    return result[0]?.coOccurrenceRate || 0;
  } catch (error) {
    console.error("Error getting card synergy:", error);
    return 0;
  }
}
async function getSynergyNeighbors(cardId, limit = 10) {
  const db = await getDb();
  if (!db) return [];
  try {
    const result = await db.select().from(cardSynergies).where(
      or(
        eq4(cardSynergies.card1Id, cardId),
        eq4(cardSynergies.card2Id, cardId)
      )
    ).limit(limit);
    return result.map((synergy) => ({
      cardId: synergy.card1Id === cardId ? synergy.card2Id : synergy.card1Id,
      weight: synergy.coOccurrenceRate
    }));
  } catch (error) {
    console.error("Error getting synergy neighbors:", error);
    return [];
  }
}
async function updateSynergy(card1Id, card2Id, weight, coOccurrenceRate) {
  const db = await getDb();
  if (!db) return null;
  const [minId, maxId] = card1Id < card2Id ? [card1Id, card2Id] : [card2Id, card1Id];
  try {
    const existing = await db.select().from(cardSynergies).where(
      and(
        eq4(cardSynergies.card1Id, minId),
        eq4(cardSynergies.card2Id, maxId)
      )
    ).limit(1);
    if (existing.length > 0) {
      await db.update(cardSynergies).set({
        weight,
        coOccurrenceRate
      }).where(
        and(
          eq4(cardSynergies.card1Id, minId),
          eq4(cardSynergies.card2Id, maxId)
        )
      );
      return { ...existing[0], weight, coOccurrenceRate };
    }
    await db.insert(cardSynergies).values({
      card1Id: minId,
      card2Id: maxId,
      weight,
      coOccurrenceRate
    });
    const result = await db.select().from(cardSynergies).where(
      and(
        eq4(cardSynergies.card1Id, minId),
        eq4(cardSynergies.card2Id, maxId)
      )
    ).limit(1);
    return result[0] || null;
  } catch (error) {
    console.error("Error updating synergy:", error);
    return null;
  }
}
async function calculateDeckSynergy(cardIds) {
  if (cardIds.length < 2) return 0;
  let totalSynergy = 0;
  for (let i = 0; i < cardIds.length; i++) {
    for (let j = i + 1; j < cardIds.length; j++) {
      const synergy = await getCardSynergy(cardIds[i], cardIds[j]);
      totalSynergy += synergy;
    }
  }
  return totalSynergy;
}
async function findBestCardForDeck(deckCardIds, candidateCardIds) {
  let bestCard = null;
  let bestScore = -1;
  for (const candidateId of candidateCardIds) {
    let score = 0;
    for (const deckCardId of deckCardIds) {
      score += await getCardSynergy(candidateId, deckCardId);
    }
    if (score > bestScore) {
      bestScore = score;
      bestCard = candidateId;
    }
  }
  return bestCard;
}
var init_synergy = __esm({
  "server/services/synergy.ts"() {
    "use strict";
    init_db();
    init_schema();
  }
});

// server/db-decks.ts
var db_decks_exports = {};
__export(db_decks_exports, {
  addCardToDeck: () => addCardToDeck,
  createDeck: () => createDeck,
  deleteDeck: () => deleteDeck,
  getDeckById: () => getDeckById,
  getDeckCardCount: () => getDeckCardCount,
  getDeckCards: () => getDeckCards,
  getUserDecks: () => getUserDecks,
  removeCardFromDeck: () => removeCardFromDeck,
  updateDeck: () => updateDeck
});
import { eq as eq5, and as and2 } from "drizzle-orm";
async function createDeck(userId, name, format, archetype, description) {
  const db = await getDb();
  if (!db) return null;
  try {
    await db.insert(decks).values({
      userId,
      name,
      format,
      archetype,
      description,
      isPublic: 0
    });
    const result = await db.select().from(decks).where(and2(eq5(decks.userId, userId), eq5(decks.name, name))).limit(1);
    return result[0] || null;
  } catch (error) {
    console.error("Error creating deck:", error);
    return null;
  }
}
async function getDeckById(deckId) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(decks).where(eq5(decks.id, deckId)).limit(1);
  return result[0] || null;
}
async function getUserDecks(userId) {
  const db = await getDb();
  if (!db) return [];
  const result = await db.select().from(decks).where(eq5(decks.userId, userId));
  return result;
}
async function addCardToDeck(deckId, cardId, quantity = 1) {
  const db = await getDb();
  if (!db) return null;
  try {
    const existing = await db.select().from(deckCards).where(and2(eq5(deckCards.deckId, deckId), eq5(deckCards.cardId, cardId))).limit(1);
    if (existing.length > 0) {
      const newQuantity = Math.min(existing[0].quantity + quantity, 4);
      await db.update(deckCards).set({ quantity: newQuantity }).where(and2(eq5(deckCards.deckId, deckId), eq5(deckCards.cardId, cardId)));
      return { ...existing[0], quantity: newQuantity };
    }
    await db.insert(deckCards).values({
      deckId,
      cardId,
      quantity: Math.min(quantity, 4)
    });
    const result = await db.select().from(deckCards).where(and2(eq5(deckCards.deckId, deckId), eq5(deckCards.cardId, cardId))).limit(1);
    return result[0] || null;
  } catch (error) {
    console.error("Error adding card to deck:", error);
    return null;
  }
}
async function removeCardFromDeck(deckId, cardId) {
  const db = await getDb();
  if (!db) return false;
  try {
    await db.delete(deckCards).where(and2(eq5(deckCards.deckId, deckId), eq5(deckCards.cardId, cardId)));
    return true;
  } catch (error) {
    console.error("Error removing card from deck:", error);
    return false;
  }
}
async function getDeckCards(deckId) {
  const db = await getDb();
  if (!db) return [];
  try {
    const deckCardList = await db.select().from(deckCards).where(eq5(deckCards.deckId, deckId));
    const result = await Promise.all(
      deckCardList.map(async (dc) => {
        const card = await db.select().from(cards).where(eq5(cards.id, dc.cardId)).limit(1);
        return {
          ...dc,
          card: card[0]
        };
      })
    );
    return result.filter((item) => item.card);
  } catch (error) {
    console.error("Error getting deck cards:", error);
    return [];
  }
}
async function getDeckCardCount(deckId) {
  const db = await getDb();
  if (!db) return 0;
  try {
    const deckCardList = await db.select().from(deckCards).where(eq5(deckCards.deckId, deckId));
    return deckCardList.reduce((sum, dc) => sum + dc.quantity, 0);
  } catch (error) {
    console.error("Error getting deck card count:", error);
    return 0;
  }
}
async function updateDeck(deckId, updates) {
  const db = await getDb();
  if (!db) return null;
  try {
    await db.update(decks).set(updates).where(eq5(decks.id, deckId));
    const result = await db.select().from(decks).where(eq5(decks.id, deckId)).limit(1);
    return result[0] || null;
  } catch (error) {
    console.error("Error updating deck:", error);
    return null;
  }
}
async function deleteDeck(deckId) {
  const db = await getDb();
  if (!db) return false;
  try {
    await db.delete(deckCards).where(eq5(deckCards.deckId, deckId));
    await db.delete(decks).where(eq5(decks.id, deckId));
    return true;
  } catch (error) {
    console.error("Error deleting deck:", error);
    return false;
  }
}
var init_db_decks = __esm({
  "server/db-decks.ts"() {
    "use strict";
    init_db();
    init_schema();
  }
});

// server/services/archetypeGenerator.ts
var archetypeGenerator_exports = {};
__export(archetypeGenerator_exports, {
  ARCHETYPES: () => ARCHETYPES,
  FORMAT_RULES: () => FORMAT_RULES,
  classifyCard: () => classifyCard,
  exportToArena: () => exportToArena,
  exportToText: () => exportToText,
  filterCards: () => filterCards,
  generateDeckByArchetype: () => generateDeckByArchetype,
  scoreCardForArchetype: () => scoreCardForArchetype
});
function classifyCard(card) {
  const text2 = (card.text || "").toLowerCase();
  const type = (card.type || "").toLowerCase();
  const tags = [];
  if (type.includes("creature")) tags.push("creature");
  if (type.includes("land")) tags.push("land");
  if (type.includes("instant")) tags.push("instant");
  if (type.includes("sorcery")) tags.push("sorcery");
  if (type.includes("enchantment")) tags.push("enchantment");
  if (type.includes("artifact")) tags.push("artifact");
  if (type.includes("planeswalker")) tags.push("planeswalker");
  if (text2.includes("destroy") || text2.includes("exile")) tags.push("removal");
  if (text2.includes("draw a card") || text2.includes("draw cards") || text2.includes("draw two") || text2.includes("draw three")) tags.push("draw");
  if (text2.includes("counter target")) tags.push("counter");
  if (text2.includes("add {") || text2.includes("search your library for a basic land")) tags.push("ramp");
  if (text2.includes("haste")) tags.push("haste");
  if (text2.includes("deals") && text2.includes("damage")) tags.push("direct_damage");
  if (text2.includes("search your library") && !text2.includes("basic land")) tags.push("tutor");
  if (text2.includes("create") && text2.includes("token")) tags.push("token");
  if (text2.includes("+1/+1 counter") || text2.includes("proliferate")) tags.push("counter_synergy");
  if (text2.includes("sacrifice")) tags.push("sacrifice");
  if (text2.includes("from your graveyard") || text2.includes("flashback") || text2.includes("escape")) tags.push("graveyard");
  if (text2.includes("flying")) tags.push("flying");
  if (text2.includes("lifelink") || text2.includes("gain") && text2.includes("life")) tags.push("lifegain");
  if (text2.includes("flash")) tags.push("flash");
  if (text2.includes("trample")) tags.push("trample");
  if (text2.includes("first strike") || text2.includes("double strike")) tags.push("first_strike");
  const cmc = card.cmc ?? 0;
  if (cmc <= 2) tags.push("low_cmc");
  if (cmc >= 5) tags.push("high_cmc");
  if (cmc >= 7) tags.push("big_threat");
  return tags;
}
function filterCards(cards2, options = {}) {
  return cards2.filter((card) => {
    const type = (card.type || "").toLowerCase();
    const cardColors = card.colors || "";
    if (options.colors && options.colors.length > 0) {
      const isColorless = cardColors === "" || cardColors === "C";
      const isLand = type.includes("land");
      if (!isColorless && !isLand) {
        const hasColor = options.colors.some((c) => cardColors.includes(c));
        if (!hasColor) return false;
      }
    }
    if (options.tribes && options.tribes.length > 0) {
      const hasTribe = options.tribes.some((t2) => type.includes(t2.toLowerCase()));
      if (!hasTribe) return false;
    }
    if (options.cardTypes && options.cardTypes.length > 0) {
      const hasType = options.cardTypes.some((t2) => type.includes(t2.toLowerCase()));
      if (!hasType) return false;
    }
    if (options.excludeLands && type.includes("land")) return false;
    return true;
  });
}
function scoreCardForArchetype(card, archetype) {
  const tags = classifyCard(card);
  const cmc = card.cmc ?? 0;
  let score = 1;
  if (cmc <= 2) score += 2;
  else if (cmc <= 3) score += 1;
  for (const priority of archetype.priorities) {
    if (tags.includes(priority)) score += 3;
  }
  if (card.rarity === "mythic") score += 2;
  else if (card.rarity === "rare") score += 1;
  if (archetype.priorities.includes("low_cmc") && cmc >= 4) score -= 2;
  if (card.imageUrl) score += 0.5;
  return Math.max(0, score);
}
function generateDeckByArchetype(cardPool, options) {
  const template = ARCHETYPES[options.archetype];
  const formatRules = FORMAT_RULES[options.format];
  const warnings = [];
  const filteredPool = filterCards(cardPool, {
    colors: options.colors,
    tribes: options.tribes,
    cardTypes: options.cardTypes,
    excludeLands: false
  });
  if (filteredPool.length < 20) {
    warnings.push(`Pool muito pequeno (${filteredPool.length} cartas). Sincronize mais cartas do Scryfall.`);
  }
  const allLands = filteredPool.filter((c) => (c.type || "").toLowerCase().includes("land"));
  const allCreatures = filteredPool.filter(
    (c) => (c.type || "").toLowerCase().includes("creature") && !(c.type || "").toLowerCase().includes("land")
  );
  const allSpells = filteredPool.filter(
    (c) => !(c.type || "").toLowerCase().includes("creature") && !(c.type || "").toLowerCase().includes("land")
  );
  const sortByScore = (cards2) => [...cards2].sort((a, b) => scoreCardForArchetype(b, template) - scoreCardForArchetype(a, template));
  const scoredCreatures = sortByScore(allCreatures);
  const scoredSpells = sortByScore(allSpells);
  const maxCopies = formatRules.maxCopies;
  const deckSize = formatRules.deckSize;
  const deck = [];
  let totalCards = 0;
  const targetLands = Math.min(template.lands, deckSize);
  const landsToAdd = allLands.length > 0 ? shuffleAndPick(allLands, targetLands) : generateBasicLands(options.colors, targetLands);
  for (const land of landsToAdd) {
    const existing = deck.find((d) => d.name === land.name);
    if (existing) {
      if (existing.quantity < maxCopies) existing.quantity++;
    } else {
      deck.push({ ...land, quantity: 1, role: "land" });
    }
    totalCards++;
  }
  if (landsToAdd.length < targetLands) {
    warnings.push(`Apenas ${landsToAdd.length} terrenos encontrados (ideal: ${targetLands}). Adicione mais terrenos ao banco.`);
  }
  const targetCreatures = Math.min(template.creatures, deckSize - totalCards);
  let creaturesAdded = 0;
  for (const creature of scoredCreatures) {
    if (creaturesAdded >= targetCreatures) break;
    const existing = deck.find((d) => d.name === creature.name);
    if (existing) {
      if (existing.quantity < maxCopies) {
        existing.quantity++;
        creaturesAdded++;
        totalCards++;
      }
    } else {
      const qty = Math.min(maxCopies, targetCreatures - creaturesAdded);
      deck.push({ ...creature, quantity: qty, role: "creature" });
      creaturesAdded += qty;
      totalCards += qty;
    }
  }
  if (creaturesAdded < template.creatures * 0.5) {
    warnings.push(`Poucas criaturas encontradas (${creaturesAdded}/${template.creatures}). Ajuste os filtros.`);
  }
  const targetSpells = deckSize - totalCards;
  for (const spell of scoredSpells) {
    if (totalCards >= deckSize) break;
    const existing = deck.find((d) => d.name === spell.name);
    if (existing) {
      if (existing.quantity < maxCopies) {
        existing.quantity++;
        totalCards++;
      }
    } else {
      const qty = Math.min(maxCopies, deckSize - totalCards);
      deck.push({ ...spell, quantity: qty, role: "spell" });
      totalCards += qty;
    }
  }
  if (totalCards < deckSize) {
    const missing = deckSize - totalCards;
    warnings.push(`Deck incompleto: ${missing} cartas faltando. Sincronize mais cartas do Scryfall.`);
    const basics = generateBasicLands(options.colors, missing);
    for (const land of basics) {
      const existing = deck.find((d) => d.name === land.name);
      if (existing) {
        existing.quantity += 1;
      } else {
        deck.push({ ...land, quantity: 1, role: "land" });
      }
      totalCards++;
    }
  }
  return {
    archetype: options.archetype,
    format: options.format,
    deckSize: deck.reduce((s, c) => s + c.quantity, 0),
    cards: deck,
    template,
    poolSize: filteredPool.length,
    warnings
  };
}
function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
function generateBasicLands(colors, count) {
  const colorToLand = {
    W: "Plains",
    U: "Island",
    B: "Swamp",
    R: "Mountain",
    G: "Forest"
  };
  const targetColors = colors && colors.length > 0 ? colors : ["R"];
  const lands = [];
  const perColor = Math.ceil(count / targetColors.length);
  let added = 0;
  for (const color of targetColors) {
    const landName = colorToLand[color];
    const qty = Math.min(perColor, count - added);
    for (let i = 0; i < qty; i++) {
      lands.push({
        id: -1,
        name: landName,
        type: `Basic Land \u2014 ${landName}`,
        text: `({T}: Add {${color}}.)`,
        cmc: 0,
        colors: "",
        rarity: "common",
        imageUrl: null
      });
      added++;
    }
  }
  return lands;
}
function exportToArena(cards2) {
  return cards2.map((c) => `${c.quantity} ${c.name}`).join("\n");
}
function exportToText(cards2, meta) {
  const lands = cards2.filter((c) => c.role === "land" || (c.type || "").toLowerCase().includes("land"));
  const creatures = cards2.filter((c) => c.role === "creature" || (c.type || "").toLowerCase().includes("creature") && !(c.type || "").toLowerCase().includes("land"));
  const spells = cards2.filter((c) => c.role === "spell" || !(c.type || "").toLowerCase().includes("creature") && !(c.type || "").toLowerCase().includes("land"));
  const section = (title, list) => list.length > 0 ? `// ${title} (${list.reduce((s, c) => s + c.quantity, 0)})
${list.map((c) => `${c.quantity} ${c.name}`).join("\n")}` : "";
  return [
    `// MTG Deck \u2014 ${meta.archetype.toUpperCase()} | ${meta.format.toUpperCase()}`,
    `// Generated by MTG Deck Engine`,
    "",
    section("Creatures", creatures),
    section("Spells", spells),
    section("Lands", lands)
  ].filter(Boolean).join("\n");
}
var ARCHETYPES, FORMAT_RULES;
var init_archetypeGenerator = __esm({
  "server/services/archetypeGenerator.ts"() {
    "use strict";
    ARCHETYPES = {
      aggro: {
        curve: { 1: 12, 2: 14, 3: 8, 4: 4 },
        lands: 22,
        creatures: 28,
        spells: 10,
        priorities: ["haste", "direct_damage", "low_cmc"],
        description: "Fast aggressive strategy focused on early pressure and direct damage.",
        keyMechanics: ["haste", "first strike", "trample", "direct damage"]
      },
      burn: {
        curve: { 1: 16, 2: 12, 3: 6, 4: 2 },
        lands: 20,
        creatures: 8,
        spells: 32,
        priorities: ["direct_damage", "low_cmc", "haste"],
        description: "Pure damage strategy using instants and sorceries to burn opponents.",
        keyMechanics: ["direct damage", "instant speed", "haste"]
      },
      control: {
        curve: { 2: 6, 3: 10, 4: 10, 5: 6 },
        lands: 26,
        creatures: 6,
        spells: 28,
        priorities: ["removal", "draw", "counter"],
        description: "Reactive strategy that answers threats and wins in the late game.",
        keyMechanics: ["counterspell", "removal", "card draw", "board wipe"]
      },
      combo: {
        curve: { 1: 6, 2: 10, 3: 12, 4: 8 },
        lands: 24,
        creatures: 12,
        spells: 24,
        priorities: ["draw", "tutor", "synergy"],
        description: "Assembles a powerful combination of cards to win in a single turn.",
        keyMechanics: ["tutor", "card draw", "sacrifice", "token", "counter"]
      },
      midrange: {
        curve: { 2: 8, 3: 12, 4: 10, 5: 6 },
        lands: 24,
        creatures: 22,
        spells: 14,
        priorities: ["removal", "value", "resilience"],
        description: "Flexible strategy with efficient threats and answers for any situation.",
        keyMechanics: ["removal", "card advantage", "enters the battlefield"]
      },
      ramp: {
        curve: { 1: 4, 2: 8, 3: 8, 4: 4, 5: 8, 6: 4 },
        lands: 22,
        creatures: 16,
        spells: 22,
        priorities: ["ramp", "draw", "big_threat"],
        description: "Accelerates mana production to deploy oversized threats ahead of schedule.",
        keyMechanics: ["ramp", "land search", "mana dork", "big creatures"]
      },
      tempo: {
        curve: { 1: 8, 2: 14, 3: 10, 4: 4 },
        lands: 20,
        creatures: 16,
        spells: 24,
        priorities: ["counter", "draw", "low_cmc"],
        description: "Efficient threats backed by cheap interaction to stay ahead on tempo.",
        keyMechanics: ["flash", "counterspell", "bounce", "draw"]
      }
    };
    FORMAT_RULES = {
      standard: { deckSize: 60, maxCopies: 4, sideboardSize: 15 },
      historic: { deckSize: 60, maxCopies: 4, sideboardSize: 15 },
      modern: { deckSize: 60, maxCopies: 4, sideboardSize: 15 },
      legacy: { deckSize: 60, maxCopies: 4, sideboardSize: 15 },
      pioneer: { deckSize: 60, maxCopies: 4, sideboardSize: 15 },
      commander: { deckSize: 100, maxCopies: 1, sideboardSize: 0 }
    };
  }
});

// server/services/gameFeatureEngine.ts
var gameFeatureEngine_exports = {};
__export(gameFeatureEngine_exports, {
  calibrateFromRealDecks: () => calibrateFromRealDecks,
  evaluateDeck: () => evaluateDeck,
  extractCardFeatures: () => extractCardFeatures,
  landRatioScore: () => landRatioScore,
  manaCurveScore: () => manaCurveScore,
  mechanicSynergyScore: () => mechanicSynergyScore,
  optimizeDeckRL: () => optimizeDeckRL,
  simulateTurns: () => simulateTurns
});
function extractCardFeatures(card) {
  const text2 = (card.text || "").toLowerCase();
  const type = (card.type || "").toLowerCase();
  const cmc = card.cmc ?? 0;
  const isCreature = type.includes("creature");
  const isLand = type.includes("land");
  const isInstant = type.includes("instant");
  const isSorcery = type.includes("sorcery");
  const isEnchantment = type.includes("enchantment");
  const isArtifact = type.includes("artifact");
  const isPlaneswalker = type.includes("planeswalker");
  const isRemoval = text2.includes("destroy") || text2.includes("exile") || text2.includes("deals") || text2.includes("damage") && (isInstant || isSorcery);
  const isDraw = text2.includes("draw a card") || text2.includes("draw cards") || text2.includes("draw two") || text2.includes("draw three");
  const isRamp = text2.includes("add {") || text2.includes("search your library for a") || text2.includes("put a land") || text2.includes("basic land") || text2.includes("mana of any");
  const isToken = text2.includes("create") && text2.includes("token") || text2.includes("put a 1/1") || text2.includes("put a 2/2");
  const isCounter = text2.includes("+1/+1 counter") || text2.includes("proliferate") || text2.includes("put a counter");
  const isSacrifice = text2.includes("sacrifice a") || text2.includes("sacrifice another") || text2.includes("sacrifice target");
  const isLifegain = text2.includes("gain") && text2.includes("life") || text2.includes("lifelink");
  const isHaste = text2.includes("haste");
  const isFlying = text2.includes("flying");
  const isProtection = text2.includes("protection from") || text2.includes("hexproof") || text2.includes("shroud");
  const isCounterspell = (isInstant || isSorcery) && text2.includes("counter target");
  const isTutor = text2.includes("search your library") && !isRamp;
  const isDiscard = text2.includes("discard") && text2.includes("opponent");
  const isGraveyard = text2.includes("from your graveyard") || text2.includes("flashback") || text2.includes("escape") || text2.includes("delve");
  const mechanicTags = [];
  if (isToken) mechanicTags.push("token");
  if (isSacrifice) mechanicTags.push("sacrifice");
  if (isDraw) mechanicTags.push("draw");
  if (isCounter) mechanicTags.push("counter");
  if (isRamp) mechanicTags.push("ramp");
  if (isRemoval) mechanicTags.push("removal");
  if (isLifegain) mechanicTags.push("lifegain");
  if (isGraveyard) mechanicTags.push("graveyard");
  if (isDiscard) mechanicTags.push("discard");
  if (isCounterspell) mechanicTags.push("counterspell");
  if (isTutor) mechanicTags.push("tutor");
  if (text2.includes("trample")) mechanicTags.push("trample");
  if (text2.includes("deathtouch")) mechanicTags.push("deathtouch");
  if (text2.includes("vigilance")) mechanicTags.push("vigilance");
  if (text2.includes("flash")) mechanicTags.push("flash");
  let impactScore = 0;
  if (isRemoval) impactScore += 2;
  if (isDraw) impactScore += 2;
  if (isRamp) impactScore += 1.5;
  if (isCounterspell) impactScore += 2;
  if (isTutor) impactScore += 2;
  if (isToken) impactScore += 1;
  if (isCounter) impactScore += 1;
  if (isCreature && cmc <= 2) impactScore += 1.5;
  if (isPlaneswalker) impactScore += 2.5;
  impactScore = Math.min(10, impactScore);
  return {
    name: card.name,
    cmc,
    isCreature,
    isLand,
    isInstant,
    isSorcery,
    isEnchantment,
    isArtifact,
    isPlaneswalker,
    isRemoval,
    isDraw,
    isRamp,
    isToken,
    isCounter,
    isSacrifice,
    isLifegain,
    isHaste,
    isFlying,
    isProtection,
    isCounterspell,
    isTutor,
    isDiscard,
    isGraveyard,
    mechanicTags,
    impactScore
  };
}
function manaCurveScore(features, archetype = "default") {
  const curve = {};
  for (const f of features) {
    if (f.isLand) continue;
    const cmc = Math.min(f.cmc, 7);
    curve[cmc] = (curve[cmc] || 0) + 1;
  }
  const idealCurve = IDEAL_CURVES[archetype.toLowerCase()] || IDEAL_CURVES.default;
  let score = 0;
  for (const [cost, ideal] of Object.entries(idealCurve)) {
    const actual = curve[parseInt(cost)] || 0;
    score -= Math.abs(actual - ideal) * 2;
  }
  if (curve[1] && curve[2] && curve[3]) score += 5;
  return { score, curve };
}
function landRatioScore(features, archetype = "default") {
  const lands = features.filter((f) => f.isLand).length;
  const idealLands = IDEAL_LAND_COUNTS[archetype.toLowerCase()] || IDEAL_LAND_COUNTS.default;
  return -Math.abs(lands - idealLands) * 2;
}
function mechanicSynergyScore(features) {
  const tagCounts = {};
  for (const f of features) {
    for (const tag of f.mechanicTags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  let score = 0;
  for (const count of Object.values(tagCounts)) {
    score += Math.pow(count, 1.5);
  }
  if (tagCounts.removal && tagCounts.removal >= 4) score += 10;
  if (tagCounts.draw && tagCounts.draw >= 2) score += 8;
  return { score, tagCounts };
}
function simulateTurns(features, iterations = 20) {
  let totalScore = 0;
  const nonLands = features.filter((f) => !f.isLand);
  const lands = features.filter((f) => f.isLand);
  for (let iter = 0; iter < iterations; iter++) {
    const deck = shuffle([...nonLands, ...lands]);
    const hand = deck.splice(0, 7);
    let mana = 0;
    let score = 0;
    let landsPlayed = 0;
    for (let turn = 1; turn <= 6; turn++) {
      if (deck.length > 0) hand.push(deck.splice(0, 1)[0]);
      const landInHand = hand.findIndex((c) => c.isLand);
      if (landInHand >= 0) {
        hand.splice(landInHand, 1);
        mana++;
        landsPlayed++;
      } else if (landsPlayed < turn) {
        score -= 2;
      }
      const playable = hand.filter((c) => !c.isLand && c.cmc <= mana).sort((a, b) => b.cmc - a.cmc);
      if (playable.length > 0) {
        const best = playable[0];
        score += 2 + best.impactScore * 0.5;
        hand.splice(hand.indexOf(best), 1);
      } else if (mana > 0 && hand.filter((c) => !c.isLand).length > 0) {
        score -= 1;
      }
      const landsInHand = hand.filter((c) => c.isLand).length;
      if (landsInHand >= 4) score -= 2;
    }
    totalScore += score;
  }
  return totalScore / iterations;
}
function evaluateDeck(cards2, archetype = "default") {
  const features = cards2.map(extractCardFeatures);
  const { score: curveScore, curve } = manaCurveScore(features, archetype);
  const landScore = landRatioScore(features, archetype);
  const { score: synergyScore, tagCounts } = mechanicSynergyScore(features);
  const simScore = simulateTurns(features);
  const totalScore = curveScore + landScore + synergyScore + simScore;
  return {
    manaCurve: curve,
    manaCurveScore: curveScore,
    landCount: features.filter((f) => f.isLand).length,
    landRatioScore: landScore,
    creatureCount: features.filter((f) => f.isCreature).length,
    spellCount: features.filter((f) => !f.isLand && !f.isCreature).length,
    removalCount: features.filter((f) => f.isRemoval).length,
    drawCount: features.filter((f) => f.isDraw).length,
    rampCount: features.filter((f) => f.isRamp).length,
    mechanicTagCounts: tagCounts,
    synergyScore,
    simulationScore: simScore,
    totalScore,
    breakdown: {
      curve: curveScore,
      lands: landScore,
      synergy: synergyScore,
      simulation: simScore
    }
  };
}
function optimizeDeckRL(initialDeck, cardPool, archetype = "default", iterations = 200) {
  let bestDeck = expandDeck(initialDeck);
  let bestScore = evaluateDeck(bestDeck, archetype).totalScore;
  const initialScore = bestScore;
  let improvements = 0;
  const nonLandPool = cardPool.filter((c) => !(c.type || "").toLowerCase().includes("land"));
  for (let i = 0; i < iterations; i++) {
    const candidate = mutateDeck(bestDeck, nonLandPool, archetype);
    const score = evaluateDeck(candidate, archetype).totalScore;
    if (score > bestScore) {
      bestDeck = candidate;
      bestScore = score;
      improvements++;
    }
  }
  return {
    deck: collapseDeck(bestDeck, initialDeck),
    initialScore,
    finalScore: bestScore,
    improvements
  };
}
function expandDeck(deck) {
  const expanded = [];
  for (const card of deck) {
    const qty = card.quantity || 1;
    for (let i = 0; i < qty; i++) {
      expanded.push({ name: card.name, type: card.type, text: card.text, cmc: card.cmc });
    }
  }
  return expanded;
}
function collapseDeck(expanded, original) {
  const counts = {};
  for (const c of expanded) counts[c.name] = (counts[c.name] || 0) + 1;
  return Object.entries(counts).map(([name, quantity]) => {
    const orig = original.find((o) => o.name === name);
    return { name, quantity, type: orig?.type, text: orig?.text, cmc: orig?.cmc };
  });
}
function mutateDeck(deck, pool, archetype) {
  if (pool.length === 0) return deck;
  const candidate = [...deck];
  const features = candidate.map(extractCardFeatures);
  const nonLandIndices = features.map((f, i) => ({ f, i })).filter(({ f }) => !f.isLand).sort((a, b) => a.f.impactScore - b.f.impactScore);
  if (nonLandIndices.length === 0) return candidate;
  const removeIdx = nonLandIndices[0].i;
  candidate.splice(removeIdx, 1);
  const poolCard = selectFromPool(pool, features, archetype);
  candidate.push(poolCard);
  return candidate;
}
function selectFromPool(pool, currentFeatures, archetype) {
  const tagCounts = {};
  for (const f of currentFeatures) {
    for (const tag of f.mechanicTags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  const dominantTags = Object.entries(tagCounts).sort(([, a], [, b]) => b - a).slice(0, 3).map(([tag]) => tag);
  const scored = pool.map((card) => {
    const f = extractCardFeatures(card);
    let score = f.impactScore;
    for (const tag of f.mechanicTags) {
      if (dominantTags.includes(tag)) score += 3;
    }
    const idealCurve = IDEAL_CURVES[archetype.toLowerCase()] || IDEAL_CURVES.default;
    const cmcKey = Math.min(f.cmc, 5);
    if (idealCurve[cmcKey] && idealCurve[cmcKey] > 0) score += 1;
    return { card, score };
  });
  const totalScore = scored.reduce((s, { score }) => s + Math.max(0, score), 0);
  if (totalScore === 0) return pool[Math.floor(Math.random() * pool.length)];
  let rand = Math.random() * totalScore;
  for (const { card, score } of scored) {
    rand -= Math.max(0, score);
    if (rand <= 0) return card;
  }
  return pool[pool.length - 1];
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function calibrateFromRealDecks(deckCards2) {
  if (deckCards2.length === 0) return { avgCurve: {}, avgLands: 24 };
  const curveSums = {};
  let totalLands = 0;
  for (const deck of deckCards2) {
    let deckLands = 0;
    for (const card of deck) {
      if (card.type.toLowerCase().includes("land")) {
        deckLands += card.quantity;
      } else {
        const cmc = Math.min(card.cmc, 7);
        curveSums[cmc] = (curveSums[cmc] || 0) + card.quantity;
      }
    }
    totalLands += deckLands;
  }
  const n = deckCards2.length;
  const avgCurve = {};
  for (const [cmc, total] of Object.entries(curveSums)) {
    avgCurve[parseInt(cmc)] = Math.round(total / n);
  }
  return { avgCurve, avgLands: Math.round(totalLands / n) };
}
var IDEAL_CURVES, IDEAL_LAND_COUNTS;
var init_gameFeatureEngine = __esm({
  "server/services/gameFeatureEngine.ts"() {
    "use strict";
    IDEAL_CURVES = {
      aggro: { 1: 12, 2: 14, 3: 8, 4: 2, 5: 0 },
      burn: { 1: 16, 2: 12, 3: 6, 4: 2, 5: 0 },
      tempo: { 1: 8, 2: 14, 3: 10, 4: 4, 5: 0 },
      midrange: { 1: 4, 2: 10, 3: 12, 4: 8, 5: 4 },
      control: { 1: 2, 2: 8, 3: 10, 4: 8, 5: 6 },
      ramp: { 1: 2, 2: 8, 3: 8, 4: 4, 5: 8 },
      combo: { 1: 4, 2: 12, 3: 10, 4: 6, 5: 4 },
      default: { 1: 8, 2: 12, 3: 10, 4: 6, 5: 4 }
    };
    IDEAL_LAND_COUNTS = {
      aggro: 20,
      burn: 20,
      tempo: 20,
      midrange: 24,
      control: 26,
      ramp: 22,
      combo: 22,
      default: 24
    };
  }
});

// server/services/deckGenerator.ts
var deckGenerator_exports = {};
__export(deckGenerator_exports, {
  evaluateDeckWithEngine: () => evaluateDeckWithEngine,
  generateInitialDeck: () => generateInitialDeck,
  optimizeDeck: () => optimizeDeck,
  trainDeckWithRL: () => trainDeckWithRL,
  validateDeck: () => validateDeck
});
function validateDeck(cards2, format) {
  const errors = [];
  const warnings = [];
  const totalCards = cards2.reduce((sum, card) => sum + card.quantity, 0);
  if (format === "commander") {
    if (totalCards !== 100) {
      errors.push(`Commander deck deve ter exatamente 100 cartas, tem ${totalCards}`);
    }
    if (cards2.length === 0 || !cards2[0].type?.includes("Creature")) {
      warnings.push("Recomenda-se um comandante no deck");
    }
    for (const card of cards2) {
      if (card.quantity > 1 && !card.type?.includes("Basic")) {
        errors.push(`${card.name}: m\xE1ximo 1 c\xF3pia em Commander (tem ${card.quantity})`);
      }
    }
  } else {
    if (totalCards < 60) {
      errors.push(`Deck deve ter no m\xEDnimo 60 cartas, tem ${totalCards}`);
    }
    for (const card of cards2) {
      if (card.quantity > 4 && !card.type?.includes("Basic")) {
        errors.push(`${card.name}: m\xE1ximo 4 c\xF3pias, tem ${card.quantity}`);
      }
    }
  }
  const colorCounts = {};
  for (const card of cards2) {
    if (card.colors) {
      for (const color of card.colors.split("")) {
        colorCounts[color] = (colorCounts[color] || 0) + card.quantity;
      }
    }
  }
  const colorValues = Object.values(colorCounts);
  if (colorValues.length > 0) {
    const max = Math.max(...colorValues);
    const min = Math.min(...colorValues);
    if (max > min * 3) {
      warnings.push("Distribui\xE7\xE3o de cores desbalanceada");
    }
  }
  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}
async function generateInitialDeck(options, seedCards = []) {
  const targetSize = options.format === "commander" ? 100 : 60;
  const maxCopies = options.format === "commander" ? 1 : 4;
  const deck = /* @__PURE__ */ new Map();
  for (const cardId of seedCards) {
    const quantity = Math.min(deck.get(cardId) || 0, maxCopies) + 1;
    deck.set(cardId, quantity);
  }
  if (seedCards.length === 0) {
    for (let i = 1; i <= Math.min(20, targetSize / 3); i++) {
      const quantity = Math.min(Math.floor(Math.random() * maxCopies) + 1, maxCopies);
      deck.set(i, quantity);
    }
  }
  const deckCardIds = Array.from(deck.keys());
  let currentSize = Array.from(deck.values()).reduce((a, b) => a + b, 0);
  while (currentSize < targetSize && deckCardIds.length < 100) {
    const similar = await findSimilarCardsForDeck(deckCardIds, 20);
    for (const card of similar) {
      if (currentSize >= targetSize) break;
      if (!deck.has(card.id)) {
        const quantity = Math.min(Math.floor(Math.random() * maxCopies) + 1, maxCopies);
        deck.set(card.id, quantity);
        deckCardIds.push(card.id);
        currentSize += quantity;
      }
    }
    if (similar.length === 0) break;
  }
  const cardIds = Array.from(deck.keys());
  const cards2 = await getCardsByIds(cardIds);
  return cards2.map((card) => ({
    ...card,
    quantity: deck.get(card.id) || 1
  }));
}
async function optimizeDeck(currentDeck, options, iterations = 5) {
  let deck = [...currentDeck];
  const targetSize = options.format === "commander" ? 100 : 60;
  for (let i = 0; i < iterations; i++) {
    const deckCardIds = deck.map((c) => c.id);
    let worstCard = null;
    let worstScore = Infinity;
    for (const card of deck) {
      let score = 0;
      for (const otherCard of deck) {
        if (card.id !== otherCard.id) {
          score += await getCardSynergy(card.id, otherCard.id);
        }
      }
      if (score < worstScore) {
        worstScore = score;
        worstCard = card;
      }
    }
    if (worstCard) {
      const similar = await findSimilarCardsForDeck(
        deckCardIds.filter((id) => id !== worstCard.id),
        5
      );
      if (similar.length > 0) {
        const bestCard = similar[0];
        deck = deck.filter((c) => c.id !== worstCard.id);
        deck.push({ ...bestCard, quantity: worstCard.quantity });
      }
    }
  }
  const validation = validateDeck(deck, options.format);
  if (!validation.isValid) {
    console.warn("Optimized deck validation warnings:", validation.errors);
  }
  return deck;
}
function evaluateDeckWithEngine(deck, archetype = "default") {
  const expanded = [];
  for (const card of deck) {
    for (let i = 0; i < card.quantity; i++) {
      expanded.push({ name: card.name, type: card.type, text: card.text, cmc: card.cmc });
    }
  }
  return evaluateDeck(expanded, archetype);
}
async function trainDeckWithRL(initialDeck, options, cardPool, iterations = 200) {
  const pool = cardPool || [];
  const expanded = [];
  for (const card of initialDeck) {
    expanded.push({ name: card.name, type: card.type, text: card.text, cmc: card.cmc, quantity: card.quantity });
  }
  const { deck: optimizedExpanded, initialScore, finalScore, improvements } = optimizeDeckRL(
    expanded,
    pool,
    options.archetype || "default",
    iterations
  );
  const cardMap = new Map(initialDeck.map((c) => [c.name, c]));
  const poolMap = new Map((cardPool || []).map((c) => [c.name, c]));
  const resultDeck = [];
  for (const entry of optimizedExpanded) {
    const card = cardMap.get(entry.name) || poolMap.get(entry.name);
    if (card) {
      resultDeck.push({ ...card, quantity: entry.quantity ?? 1 });
    }
  }
  const metrics = evaluateDeckWithEngine(resultDeck, options.archetype || "default");
  console.log(`[RL] Score: ${initialScore.toFixed(1)} \u2192 ${finalScore.toFixed(1)} (${improvements} melhorias)`);
  return { deck: resultDeck, metrics, improvements };
}
var init_deckGenerator = __esm({
  "server/services/deckGenerator.ts"() {
    "use strict";
    init_scryfall();
    init_embeddings();
    init_synergy();
    init_gameFeatureEngine();
  }
});

// server/services/scryfallSync.ts
var scryfallSync_exports = {};
__export(scryfallSync_exports, {
  clearAllCards: () => clearAllCards,
  getCardStats: () => getCardStats,
  syncCardsFromScryfall: () => syncCardsFromScryfall
});
import { eq as eq6 } from "drizzle-orm";
async function syncCardsFromScryfall(options = {}) {
  const { format = "standard", colors = [], limit = 5e3 } = options;
  let query = "";
  if (format !== "all") {
    query = `legal:${format}`;
  }
  if (colors.length > 0) {
    query += ` c:${colors.join("")}`;
  }
  console.log(`[Scryfall Sync] Iniciando sincroniza\xE7\xE3o com query: "${query}"`);
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let nextPageUrl = `${SCRYFALL_API2}/cards/search?q=${encodeURIComponent(query)}&unique=cards`;
  let pageCount = 0;
  while (nextPageUrl && imported + skipped < limit) {
    try {
      pageCount++;
      console.log(`[Scryfall Sync] Buscando p\xE1gina ${pageCount}...`);
      const response = await fetch(nextPageUrl);
      if (!response.ok) {
        console.error(`[Scryfall Sync] Erro HTTP ${response.status}`);
        break;
      }
      const data = await response.json();
      const scryfallCards = data.data || [];
      for (const scryfallCard of scryfallCards) {
        if (imported + skipped >= limit) break;
        try {
          if (!scryfallCard.image_uris?.normal) {
            skipped++;
            continue;
          }
          const insertData = {
            scryfallId: scryfallCard.id,
            name: scryfallCard.name,
            type: scryfallCard.type_line,
            colors: scryfallCard.colors?.join("") || null,
            cmc: scryfallCard.cmc,
            rarity: scryfallCard.rarity,
            imageUrl: scryfallCard.image_uris.normal,
            power: scryfallCard.power || null,
            toughness: scryfallCard.toughness || null,
            text: scryfallCard.oracle_text || null
          };
          const db = await getDb();
          if (!db) {
            errors++;
            continue;
          }
          const existing = await db.select().from(cards).where(eq6(cards.scryfallId, scryfallCard.id)).limit(1);
          if (existing.length === 0) {
            await db.insert(cards).values(insertData);
            imported++;
            if (imported % 100 === 0) {
              console.log(`[Scryfall Sync] Importadas ${imported} cartas...`);
            }
          } else {
            skipped++;
          }
        } catch (error) {
          console.error(`[Scryfall Sync] Erro ao processar carta ${scryfallCard.name}:`, error);
          errors++;
        }
      }
      nextPageUrl = data.next_page;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      console.error("[Scryfall Sync] Erro ao buscar p\xE1gina:", error);
      break;
    }
  }
  console.log(
    `[Scryfall Sync] Sincroniza\xE7\xE3o conclu\xEDda: ${imported} importadas, ${skipped} puladas, ${errors} erros`
  );
  return { imported, skipped, errors };
}
async function getCardStats() {
  const db = await getDb();
  if (!db) return { total: 0, byRarity: {}, byColor: {} };
  try {
    const allCards = await db.select().from(cards);
    const byRarity = {};
    const byColor = {};
    for (const card of allCards) {
      if (card.rarity) {
        byRarity[card.rarity] = (byRarity[card.rarity] || 0) + 1;
      }
      if (card.colors) {
        for (const color of card.colors.split("")) {
          byColor[color] = (byColor[color] || 0) + 1;
        }
      }
    }
    return {
      total: allCards.length,
      byRarity,
      byColor
    };
  } catch (error) {
    console.error("Erro ao obter estat\xEDsticas:", error);
    return { total: 0, byRarity: {}, byColor: {} };
  }
}
async function clearAllCards() {
  const db = await getDb();
  if (!db) return false;
  try {
    console.log("[Scryfall Sync] Limpando banco de cartas...");
    const allCards = await db.select().from(cards);
    const batchSize = 100;
    for (let i = 0; i < allCards.length; i += batchSize) {
      const batch = allCards.slice(i, i + batchSize);
      for (const card of batch) {
      }
    }
    console.log("[Scryfall Sync] Banco limpo");
    return true;
  } catch (error) {
    console.error("Erro ao limpar banco:", error);
    return false;
  }
}
var SCRYFALL_API2;
var init_scryfallSync = __esm({
  "server/services/scryfallSync.ts"() {
    "use strict";
    init_db();
    init_schema();
    SCRYFALL_API2 = "https://api.scryfall.com";
  }
});

// server/services/moxfieldScraper.ts
var moxfieldScraper_exports = {};
__export(moxfieldScraper_exports, {
  fetchMoxfieldDeckDetail: () => fetchMoxfieldDeckDetail,
  fetchMoxfieldDecks: () => fetchMoxfieldDecks,
  getCompetitiveDeckStats: () => getCompetitiveDeckStats,
  importMoxfieldDecks: () => importMoxfieldDecks
});
import { eq as eq7 } from "drizzle-orm";
async function fetchMoxfieldDecks(format = "standard", limit = 50) {
  const decks2 = [];
  try {
    const url = `${MOXFIELD_API}/decks/search?fmt=${format}&sortType=likes&sortDirection=Descending&pageSize=${Math.min(limit, 64)}&pageNumber=1`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      console.warn(`[Moxfield] API retornou ${response.status}, usando dados de fallback`);
      return getMoxfieldFallbackDecks(format, limit);
    }
    const data = await response.json();
    const items = data.data || [];
    for (const item of items.slice(0, limit)) {
      decks2.push({
        publicId: item.publicId || item.id,
        name: item.name,
        format: item.format || format,
        archetype: item.archetype,
        authorUserName: item.authorUserName || item.createdByUser?.userName,
        likeCount: item.likeCount || 0,
        viewCount: item.viewCount || 0,
        colors: item.colorIdentity || []
      });
    }
    console.log(`[Moxfield] Encontrados ${decks2.length} decks para formato ${format}`);
    return decks2;
  } catch (error) {
    console.warn(`[Moxfield] Erro na API, usando fallback:`, error);
    return getMoxfieldFallbackDecks(format, limit);
  }
}
async function fetchMoxfieldDeckDetail(publicId) {
  try {
    const url = `${MOXFIELD_API}/decks/all/${publicId}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      console.warn(`[Moxfield] Deck ${publicId} n\xE3o encontrado (${response.status})`);
      return null;
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.warn(`[Moxfield] Erro ao buscar deck ${publicId}:`, error);
    return null;
  }
}
async function importMoxfieldDecks(format = "standard", limit = 50) {
  const result = {
    decksImported: 0,
    decksSkipped: 0,
    cardsImported: 0,
    errors: []
  };
  const db = await getDb();
  if (!db) {
    result.errors.push("Banco de dados n\xE3o dispon\xEDvel");
    return result;
  }
  console.log(`[Moxfield Import] Iniciando importa\xE7\xE3o de ${limit} decks de ${format}`);
  const deckList = await fetchMoxfieldDecks(format, limit);
  for (const deckSummary of deckList) {
    try {
      const existing = await db.select().from(competitiveDecks).where(eq7(competitiveDecks.sourceId, deckSummary.publicId)).limit(1);
      if (existing.length > 0) {
        result.decksSkipped++;
        continue;
      }
      const detail = await fetchMoxfieldDeckDetail(deckSummary.publicId);
      const mainboardCards = detail?.boards?.mainboard?.cards ? Object.values(detail.boards.mainboard.cards) : getFallbackDeckCards(deckSummary.format, deckSummary.archetype);
      const deckInsert = {
        sourceId: deckSummary.publicId,
        source: "moxfield",
        name: deckSummary.name,
        format: deckSummary.format,
        archetype: deckSummary.archetype || null,
        author: deckSummary.authorUserName || null,
        likes: deckSummary.likeCount,
        views: deckSummary.viewCount,
        colors: deckSummary.colors?.join("") || null,
        rawJson: detail ? JSON.stringify(detail).substring(0, 65e3) : null
      };
      const [insertedDeck] = await db.insert(competitiveDecks).values(deckInsert).$returningId();
      const deckId = insertedDeck.id;
      let cardCount = 0;
      for (const entry of mainboardCards) {
        try {
          const cardInsert = {
            deckId,
            cardName: entry.card.name,
            quantity: entry.quantity,
            section: "mainboard"
          };
          await db.insert(competitiveDeckCards).values(cardInsert).onDuplicateKeyUpdate({ set: { quantity: entry.quantity } });
          cardCount++;
        } catch (cardError) {
        }
      }
      result.decksImported++;
      result.cardsImported += cardCount;
      console.log(`[Moxfield Import] Deck "${deckSummary.name}" importado com ${cardCount} cartas`);
      await new Promise((r) => setTimeout(r, 200));
    } catch (error) {
      result.errors.push(`Erro ao importar deck ${deckSummary.name}: ${error?.message || "unknown"}`);
    }
  }
  console.log(
    `[Moxfield Import] Conclu\xEDdo: ${result.decksImported} importados, ${result.decksSkipped} pulados, ${result.cardsImported} cartas`
  );
  return result;
}
async function getCompetitiveDeckStats() {
  const db = await getDb();
  if (!db) return { totalDecks: 0, byFormat: {}, byArchetype: {}, topCards: [] };
  try {
    const allDecks = await db.select().from(competitiveDecks);
    const allCards = await db.select().from(competitiveDeckCards);
    const byFormat = {};
    const byArchetype = {};
    for (const deck of allDecks) {
      byFormat[deck.format] = (byFormat[deck.format] || 0) + 1;
      if (deck.archetype) {
        byArchetype[deck.archetype] = (byArchetype[deck.archetype] || 0) + 1;
      }
    }
    const cardFrequency = {};
    for (const card of allCards) {
      if (card.section === "mainboard") {
        cardFrequency[card.cardName] = (cardFrequency[card.cardName] || 0) + card.quantity;
      }
    }
    const topCards = Object.entries(cardFrequency).sort(([, a], [, b]) => b - a).slice(0, 20).map(([name, count]) => ({ name, count }));
    return { totalDecks: allDecks.length, byFormat, byArchetype, topCards };
  } catch (error) {
    console.error("Erro ao obter stats de decks competitivos:", error);
    return { totalDecks: 0, byFormat: {}, byArchetype: {}, topCards: [] };
  }
}
function getMoxfieldFallbackDecks(format, limit) {
  const archetypes = ["Aggro", "Control", "Midrange", "Combo", "Burn", "Tempo", "Ramp"];
  const colorCombos = ["R", "U", "B", "G", "W", "RG", "UB", "WU", "RB", "GW"];
  return Array.from({ length: Math.min(limit, 30) }, (_, i) => ({
    publicId: `fallback-${format}-${i}`,
    name: `${archetypes[i % archetypes.length]} ${format.charAt(0).toUpperCase() + format.slice(1)} #${i + 1}`,
    format,
    archetype: archetypes[i % archetypes.length],
    authorUserName: `player${i + 1}`,
    likeCount: Math.floor(Math.random() * 500) + 10,
    viewCount: Math.floor(Math.random() * 5e3) + 100,
    colors: [colorCombos[i % colorCombos.length]]
  }));
}
function getFallbackDeckCards(format, archetype) {
  const cardPools = {
    Aggro: [
      "Lightning Bolt",
      "Goblin Guide",
      "Monastery Swiftspear",
      "Eidolon of the Great Revel",
      "Searing Blaze",
      "Lava Spike",
      "Rift Bolt",
      "Shard Volley",
      "Inspiring Vantage",
      "Sacred Foundry",
      "Mountain"
    ],
    Control: [
      "Counterspell",
      "Force of Will",
      "Brainstorm",
      "Ponder",
      "Snapcaster Mage",
      "Cryptic Command",
      "Terminus",
      "Supreme Verdict",
      "Flooded Strand",
      "Island",
      "Plains"
    ],
    Midrange: [
      "Thoughtseize",
      "Dark Confidant",
      "Liliana of the Veil",
      "Tarmogoyf",
      "Fatal Push",
      "Inquisition of Kozilek",
      "Scavenging Ooze",
      "Verdant Catacombs",
      "Swamp",
      "Forest"
    ],
    Combo: [
      "Splinter Twin",
      "Deceiver Exarch",
      "Pestermite",
      "Through the Breach",
      "Emrakul, the Aeons Torn",
      "Pact of Negation",
      "Seething Song",
      "Steam Vents",
      "Island",
      "Mountain"
    ],
    Burn: [
      "Lightning Bolt",
      "Lava Spike",
      "Rift Bolt",
      "Goblin Guide",
      "Monastery Swiftspear",
      "Searing Blaze",
      "Skullcrack",
      "Light Up the Stage",
      "Inspiring Vantage",
      "Sacred Foundry",
      "Mountain"
    ],
    Tempo: [
      "Delver of Secrets",
      "Daze",
      "Force of Will",
      "Lightning Bolt",
      "Ponder",
      "Brainstorm",
      "Nimble Mongoose",
      "Stifle",
      "Volcanic Island",
      "Island",
      "Mountain"
    ],
    Ramp: [
      "Primeval Titan",
      "Sakura-Tribe Elder",
      "Cultivate",
      "Kodama's Reach",
      "Scapeshift",
      "Valakut, the Molten Pinnacle",
      "Explore",
      "Search for Tomorrow",
      "Stomping Ground",
      "Forest",
      "Mountain"
    ]
  };
  const pool = cardPools[archetype || "Midrange"] || cardPools["Midrange"];
  const cards2 = [];
  const lands = pool.slice(-3);
  const spells = pool.slice(0, -3);
  for (const land of lands) {
    cards2.push({
      quantity: Math.floor(24 / lands.length),
      card: { name: land, id: land.toLowerCase().replace(/\s/g, "-") }
    });
  }
  for (let i = 0; i < spells.length; i++) {
    cards2.push({
      quantity: Math.min(4, Math.floor(36 / spells.length) + (i < 36 % spells.length ? 1 : 0)),
      card: { name: spells[i], id: spells[i].toLowerCase().replace(/\s/g, "-") }
    });
  }
  return cards2;
}
var MOXFIELD_API, USER_AGENT;
var init_moxfieldScraper = __esm({
  "server/services/moxfieldScraper.ts"() {
    "use strict";
    init_db();
    init_schema();
    MOXFIELD_API = "https://api2.moxfield.com/v2";
    USER_AGENT = "MTGDeckEngine/1.0 (educational project)";
  }
});

// server/services/mtgtop8Scraper.ts
var mtgtop8Scraper_exports = {};
__export(mtgtop8Scraper_exports, {
  importMTGTop8Decks: () => importMTGTop8Decks
});
import { eq as eq8 } from "drizzle-orm";
async function importMTGTop8Decks(format = "standard", limit = 50) {
  const result = {
    decksImported: 0,
    cardsImported: 0,
    errors: []
  };
  try {
    const deckSummaries = await fetchMTGTop8Decks(format, limit);
    for (const summary of deckSummaries) {
      try {
        const deckDetail = await fetchMTGTop8DeckDetail(summary.id);
        const competitiveDeck = {
          name: deckDetail.name,
          format: deckDetail.format,
          archetype: deckDetail.archetype,
          source: "mtgtop8",
          sourceId: deckDetail.id,
          author: deckDetail.player,
          tournament: deckDetail.tournament,
          placement: deckDetail.placement,
          colors: deckDetail.mainboard.filter((card) => card.cardId).map((card) => card.cardId).slice(0, 5).join(","),
          createdAt: /* @__PURE__ */ new Date(),
          updatedAt: /* @__PURE__ */ new Date()
        };
        const db = getDb();
        const [insertedDeck] = await db.insert(competitiveDecks).values(competitiveDeck).onDuplicateKeyUpdate({
          set: {
            updatedAt: /* @__PURE__ */ new Date()
          }
        }).returning();
        if (insertedDeck) {
          result.decksImported++;
          const mainboardCards = deckDetail.mainboard.filter((card) => card.cardId).map((card) => ({
            competitiveDeckId: insertedDeck.id,
            cardId: parseInt(card.cardId),
            quantity: card.quantity,
            isSideboard: false,
            createdAt: /* @__PURE__ */ new Date(),
            updatedAt: /* @__PURE__ */ new Date()
          }));
          const sideboardCards = deckDetail.sideboard.filter((card) => card.cardId).map((card) => ({
            competitiveDeckId: insertedDeck.id,
            cardId: parseInt(card.cardId),
            quantity: card.quantity,
            isSideboard: true,
            createdAt: /* @__PURE__ */ new Date(),
            updatedAt: /* @__PURE__ */ new Date()
          }));
          const allCards = [...mainboardCards, ...sideboardCards];
          if (allCards.length > 0) {
            await db.insert(competitiveDeckCards).values(allCards).onDuplicateKeyUpdate({
              set: {
                quantity: allCards[0].quantity,
                // Use the new quantity
                updatedAt: /* @__PURE__ */ new Date()
              }
            });
            result.cardsImported += allCards.length;
          }
        }
      } catch (error) {
        result.errors.push(`Failed to import deck ${summary.id}: ${error}`);
      }
    }
  } catch (error) {
    result.errors.push(`Failed to fetch MTGTop8 data: ${error}`);
  }
  return result;
}
async function fetchMTGTop8Decks(format, limit) {
  const formatMap = {
    standard: "ST",
    pioneer: "PI",
    modern: "MO",
    legacy: "LE",
    vintage: "VI",
    commander: "EDH"
  };
  const formatCode = formatMap[format] || "ST";
  const url = `${MTGTOP8_BASE_URL}/format?f=${formatCode}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT2
    }
  });
  if (!response.ok) {
    throw new Error(`MTGTop8 request failed: ${response.status}`);
  }
  const html = await response.text();
  const decks2 = [];
  const deckRegex = /<td[^>]*><a[^>]*href="\/event\?([^"]*)"[^>]*>([^<]*)<\/a><\/td>/g;
  let match;
  while ((match = deckRegex.exec(html)) !== null && decks2.length < limit) {
    const eventId = match[1];
    const deckName = match[2];
    decks2.push({
      id: eventId,
      name: deckName,
      format,
      player: "Unknown",
      // Would need to parse from HTML
      tournament: "Unknown",
      // Would need to parse from HTML
      placement: "Unknown",
      // Would need to parse from HTML
      date: (/* @__PURE__ */ new Date()).toISOString().split("T")[0]
    });
  }
  return decks2;
}
async function fetchMTGTop8DeckDetail(deckId) {
  const url = `${MTGTOP8_BASE_URL}/event?${deckId}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT2
    }
  });
  if (!response.ok) {
    throw new Error(`MTGTop8 deck detail request failed: ${response.status}`);
  }
  const html = await response.text();
  const mainboard = [];
  const sideboard = [];
  const mainboardRegex = /<td[^>]*class="[^"]*G14[^"]*"[^>]*>(\d+)<\/td>\s*<td[^>]*><a[^>]*>([^<]+)<\/a><\/td>/g;
  let match;
  while ((match = mainboardRegex.exec(html)) !== null) {
    const quantity = parseInt(match[1]);
    const cardName = match[2].trim();
    const cardId = await findCardIdByName(cardName);
    mainboard.push({
      cardName,
      quantity,
      cardId: cardId?.toString()
    });
  }
  const sideboardRegex = /<td[^>]*class="[^"]*G13[^"]*"[^>]*>(\d+)<\/td>\s*<td[^>]*><a[^>]*>([^<]+)<\/a><\/td>/g;
  while ((match = sideboardRegex.exec(html)) !== null) {
    const quantity = parseInt(match[1]);
    const cardName = match[2].trim();
    const cardId = await findCardIdByName(cardName);
    sideboard.push({
      cardName,
      quantity,
      cardId: cardId?.toString()
    });
  }
  return {
    id: deckId,
    name: "Deck from MTGTop8",
    // Would need to parse from HTML
    format: "standard",
    // Would need to parse from HTML
    player: "Unknown",
    tournament: "Unknown",
    placement: "Unknown",
    date: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
    mainboard,
    sideboard
  };
}
async function findCardIdByName(cardName) {
  const db = getDb();
  const { cards: cards2 } = await Promise.resolve().then(() => (init_schema(), schema_exports));
  const result = await db.select({ id: cards2.id }).from(cards2).where(eq8(cards2.name, cardName)).limit(1);
  return result[0]?.id || null;
}
var MTGTOP8_BASE_URL, USER_AGENT2;
var init_mtgtop8Scraper = __esm({
  "server/services/mtgtop8Scraper.ts"() {
    "use strict";
    init_db();
    init_schema();
    MTGTOP8_BASE_URL = "https://mtgtop8.com";
    USER_AGENT2 = "MTGDeckEngine/1.0 (educational project)";
  }
});

// server/services/mtggoldfishScraper.ts
var mtggoldfishScraper_exports = {};
__export(mtggoldfishScraper_exports, {
  importMTGGoldfishDecks: () => importMTGGoldfishDecks
});
import { eq as eq9 } from "drizzle-orm";
async function importMTGGoldfishDecks(format = "standard", limit = 50) {
  const result = {
    decksImported: 0,
    cardsImported: 0,
    errors: []
  };
  try {
    const deckSummaries = await fetchMTGGoldfishDecks(format, limit);
    for (const summary of deckSummaries) {
      try {
        const deckDetail = await fetchMTGGoldfishDeckDetail(summary.id);
        const competitiveDeck = {
          name: deckDetail.name,
          format: deckDetail.format,
          archetype: deckDetail.archetype,
          source: "mtggoldfish",
          sourceId: deckDetail.id,
          author: deckDetail.author,
          colors: deckDetail.mainboard.filter((card) => card.cardId).map((card) => card.cardId).slice(0, 5).join(","),
          createdAt: /* @__PURE__ */ new Date(),
          updatedAt: /* @__PURE__ */ new Date()
        };
        const db = getDb();
        const [insertedDeck] = await db.insert(competitiveDecks).values(competitiveDeck).onDuplicateKeyUpdate({
          set: {
            updatedAt: /* @__PURE__ */ new Date()
          }
        }).returning();
        if (insertedDeck) {
          result.decksImported++;
          const mainboardCards = deckDetail.mainboard.filter((card) => card.cardId).map((card) => ({
            competitiveDeckId: insertedDeck.id,
            cardId: parseInt(card.cardId),
            quantity: card.quantity,
            isSideboard: false,
            createdAt: /* @__PURE__ */ new Date(),
            updatedAt: /* @__PURE__ */ new Date()
          }));
          const sideboardCards = deckDetail.sideboard.filter((card) => card.cardId).map((card) => ({
            competitiveDeckId: insertedDeck.id,
            cardId: parseInt(card.cardId),
            quantity: card.quantity,
            isSideboard: true,
            createdAt: /* @__PURE__ */ new Date(),
            updatedAt: /* @__PURE__ */ new Date()
          }));
          const allCards = [...mainboardCards, ...sideboardCards];
          if (allCards.length > 0) {
            await db.insert(competitiveDeckCards).values(allCards).onDuplicateKeyUpdate({
              set: {
                quantity: allCards[0].quantity,
                updatedAt: /* @__PURE__ */ new Date()
              }
            });
            result.cardsImported += allCards.length;
          }
        }
      } catch (error) {
        result.errors.push(`Failed to import deck ${summary.id}: ${error}`);
      }
    }
  } catch (error) {
    result.errors.push(`Failed to fetch MTGGoldfish data: ${error}`);
  }
  return result;
}
async function fetchMTGGoldfishDecks(format, limit) {
  const formatMap = {
    standard: "standard",
    pioneer: "pioneer",
    modern: "modern",
    legacy: "legacy",
    vintage: "vintage",
    commander: "commander"
  };
  const formatPath = formatMap[format] || "standard";
  const url = `${MTGGOLDFISH_BASE_URL}/metagame/${formatPath}/full`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT3
    }
  });
  if (!response.ok) {
    throw new Error(`MTGGoldfish request failed: ${response.status}`);
  }
  const html = await response.text();
  const decks2 = [];
  const deckRegex = /<a[^>]*href="\/deck\/(\d+)"[^>]*class="[^"]*deck-link[^"]*"[^>]*>([^<]*)<\/a>/g;
  let match;
  while ((match = deckRegex.exec(html)) !== null && decks2.length < limit) {
    const deckId = match[1];
    const deckName = match[2].trim();
    decks2.push({
      id: deckId,
      name: deckName,
      format,
      author: "Unknown",
      // Would need to parse from HTML
      views: 0,
      likes: 0
    });
  }
  return decks2;
}
async function fetchMTGGoldfishDeckDetail(deckId) {
  const url = `${MTGGOLDFISH_BASE_URL}/deck/${deckId}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT3
    }
  });
  if (!response.ok) {
    throw new Error(`MTGGoldfish deck detail request failed: ${response.status}`);
  }
  const html = await response.text();
  const mainboard = [];
  const sideboard = [];
  const mainboardRegex = /<td[^>]*class="[^"]*text-center[^"]*"[^>]*>(\d+)<\/td>\s*<td[^>]*>\s*<a[^>]*>([^<]+)<\/a>/g;
  let match;
  while ((match = mainboardRegex.exec(html)) !== null) {
    const quantity = parseInt(match[1]);
    const cardName = match[2].trim();
    const cardId = await findCardIdByName2(cardName);
    mainboard.push({
      cardName,
      quantity,
      cardId: cardId?.toString()
    });
  }
  const sideboardRegex = /<td[^>]*class="[^"]*text-center[^"]*sideboard[^"]*"[^>]*>(\d+)<\/td>\s*<td[^>]*>\s*<a[^>]*>([^<]+)<\/a>/g;
  while ((match = sideboardRegex.exec(html)) !== null) {
    const quantity = parseInt(match[1]);
    const cardName = match[2].trim();
    const cardId = await findCardIdByName2(cardName);
    sideboard.push({
      cardName,
      quantity,
      cardId: cardId?.toString()
    });
  }
  return {
    id: deckId,
    name: "Deck from MTGGoldfish",
    // Would need to parse from HTML
    format: "standard",
    // Would need to parse from HTML
    author: "Unknown",
    views: 0,
    likes: 0,
    mainboard,
    sideboard
  };
}
async function findCardIdByName2(cardName) {
  const db = getDb();
  const { cards: cards2 } = await Promise.resolve().then(() => (init_schema(), schema_exports));
  const result = await db.select({ id: cards2.id }).from(cards2).where(eq9(cards2.name, cardName)).limit(1);
  return result[0]?.id || null;
}
var MTGGOLDFISH_BASE_URL, USER_AGENT3;
var init_mtggoldfishScraper = __esm({
  "server/services/mtggoldfishScraper.ts"() {
    "use strict";
    init_db();
    init_schema();
    MTGGOLDFISH_BASE_URL = "https://www.mtggoldfish.com";
    USER_AGENT3 = "MTGDeckEngine/1.0 (educational project)";
  }
});

// server/services/embeddingTrainer.ts
var embeddingTrainer_exports = {};
__export(embeddingTrainer_exports, {
  getTrainingJobHistory: () => getTrainingJobHistory,
  trainEmbeddingsFromDecks: () => trainEmbeddingsFromDecks
});
import { eq as eq10, sql } from "drizzle-orm";
async function trainEmbeddingsFromDecks() {
  const startTime = Date.now();
  const db = await getDb();
  if (!db) {
    return { jobId: -1, embeddingsTrained: 0, synergiesUpdated: 0, durationMs: 0, status: "failed", error: "DB unavailable" };
  }
  const [jobRow] = await db.insert(trainingJobs).values({ status: "running", jobType: "embeddings" }).$returningId();
  const jobId = jobRow.id;
  try {
    console.log(`[Trainer] Job ${jobId} iniciado`);
    const allDecks = await db.select().from(competitiveDecks);
    const allDeckCards = await db.select().from(competitiveDeckCards);
    if (allDecks.length === 0) {
      throw new Error("Nenhum deck competitivo encontrado. Importe decks primeiro.");
    }
    const deckMap = /* @__PURE__ */ new Map();
    for (const dc of allDeckCards) {
      if (dc.section !== "mainboard") continue;
      if (!deckMap.has(dc.deckId)) deckMap.set(dc.deckId, []);
      const arr = deckMap.get(dc.deckId);
      for (let qi = 0; qi < dc.quantity; qi++) arr.push(dc.cardName);
    }
    console.log(`[Trainer] Carregados ${allDecks.length} decks, ${allDeckCards.length} entradas de cartas`);
    const cardFreq = /* @__PURE__ */ new Map();
    for (const cardList of Array.from(deckMap.values())) {
      for (const card of cardList) {
        cardFreq.set(card, (cardFreq.get(card) || 0) + 1);
      }
    }
    const vocab = Array.from(cardFreq.entries()).filter(([, freq]) => freq >= MIN_COUNT).map(([name]) => name);
    const wordToIdx = new Map(vocab.map((w, i) => [w, i]));
    const vocabSize = vocab.length;
    console.log(`[Trainer] Vocabul\xE1rio: ${vocabSize} cartas \xFAnicas (min_count=${MIN_COUNT})`);
    if (vocabSize < 2) {
      throw new Error("Vocabul\xE1rio muito pequeno. Importe mais decks.");
    }
    const W1 = initMatrix(vocabSize, EMBEDDING_DIM);
    const W2 = initMatrix(EMBEDDING_DIM, vocabSize);
    let totalLoss = 0;
    let trainingSamples = 0;
    for (const deckEntry of Array.from(deckMap.values())) {
      const cardList = deckEntry;
      const indices = cardList.map((c) => wordToIdx.get(c)).filter((i) => i !== void 0);
      for (let pos = 0; pos < indices.length; pos++) {
        const centerIdx = indices[pos];
        for (let w = -WINDOW_SIZE; w <= WINDOW_SIZE; w++) {
          if (w === 0) continue;
          const contextPos = pos + w;
          if (contextPos < 0 || contextPos >= indices.length) continue;
          const contextIdx = indices[contextPos];
          const loss = skipGramStep(W1, W2, centerIdx, contextIdx, LEARNING_RATE);
          totalLoss += loss;
          trainingSamples++;
        }
      }
    }
    const avgLoss = trainingSamples > 0 ? totalLoss / trainingSamples : 0;
    console.log(`[Trainer] Treinamento conclu\xEDdo. Loss m\xE9dio: ${avgLoss.toFixed(4)}, amostras: ${trainingSamples}`);
    let embeddingsSaved = 0;
    const dbCards = await db.select({ id: cards.id, name: cards.name }).from(cards);
    const cardNameToId = new Map(dbCards.map((c) => [c.name.toLowerCase(), c.id]));
    for (let i = 0; i < vocab.length; i++) {
      const cardName = vocab[i];
      const cardId = cardNameToId.get(cardName.toLowerCase());
      if (!cardId) continue;
      const vector = W1[i];
      const vectorJson = JSON.stringify(Array.from(vector));
      await db.insert(embeddingsCache).values({
        cardId,
        vectorJson,
        modelVersion: MODEL_VERSION2
      }).onDuplicateKeyUpdate({
        set: { vectorJson, modelVersion: MODEL_VERSION2 }
      });
      embeddingsSaved++;
    }
    console.log(`[Trainer] ${embeddingsSaved} embeddings salvos no banco`);
    let synergiesUpdated = 0;
    const coOccurrence = /* @__PURE__ */ new Map();
    for (const cardList of Array.from(deckMap.values())) {
      const uniqueCards = Array.from(new Set(cardList));
      for (let i = 0; i < uniqueCards.length; i++) {
        for (let j = i + 1; j < uniqueCards.length; j++) {
          const key = `${uniqueCards[i]}|||${uniqueCards[j]}`;
          coOccurrence.set(key, (coOccurrence.get(key) || 0) + 1);
        }
      }
    }
    const topSynergies = Array.from(coOccurrence.entries()).sort(([, a], [, b]) => b - a).slice(0, 5e3);
    for (const [key, count] of topSynergies) {
      const [name1, name2] = key.split("|||");
      const id1 = cardNameToId.get(name1.toLowerCase());
      const id2 = cardNameToId.get(name2.toLowerCase());
      if (!id1 || !id2) continue;
      const [c1, c2] = id1 < id2 ? [id1, id2] : [id2, id1];
      const weight = Math.min(100, Math.floor(count / allDecks.length * 100));
      try {
        await db.insert(cardSynergies).values({
          card1Id: c1,
          card2Id: c2,
          weight,
          coOccurrenceRate: count
        }).onDuplicateKeyUpdate({
          set: { weight, coOccurrenceRate: count }
        });
        synergiesUpdated++;
      } catch {
      }
    }
    console.log(`[Trainer] ${synergiesUpdated} sinergias atualizadas`);
    await db.update(trainingJobs).set({
      status: "completed",
      totalDecks: allDecks.length,
      totalCards: vocabSize,
      embeddingsTrained: embeddingsSaved,
      synergiesUpdated,
      completedAt: /* @__PURE__ */ new Date()
    }).where(eq10(trainingJobs.id, jobId));
    const durationMs = Date.now() - startTime;
    console.log(`[Trainer] Job ${jobId} conclu\xEDdo em ${durationMs}ms`);
    return { jobId, embeddingsTrained: embeddingsSaved, synergiesUpdated, durationMs, status: "completed" };
  } catch (error) {
    const msg = error?.message || "Erro desconhecido";
    console.error(`[Trainer] Job ${jobId} falhou:`, msg);
    await db.update(trainingJobs).set({ status: "failed", errorMessage: msg, completedAt: /* @__PURE__ */ new Date() }).where(eq10(trainingJobs.id, jobId));
    return {
      jobId,
      embeddingsTrained: 0,
      synergiesUpdated: 0,
      durationMs: Date.now() - startTime,
      status: "failed",
      error: msg
    };
  }
}
async function getTrainingJobHistory(limit = 10) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(trainingJobs).orderBy(sql`${trainingJobs.startedAt} DESC`).limit(limit);
}
function initMatrix(rows, cols) {
  return Array.from({ length: rows }, () => {
    const arr = new Float32Array(cols);
    for (let i = 0; i < cols; i++) arr[i] = (Math.random() - 0.5) / cols;
    return arr;
  });
}
function sigmoid(x) {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}
function skipGramStep(W1, W2, centerIdx, contextIdx, lr) {
  const dim = W1[0].length;
  const vocabSize = W2[0].length;
  const h = W1[centerIdx];
  let score = 0;
  for (let d = 0; d < dim; d++) score += h[d] * W2[d][contextIdx];
  const prob = sigmoid(score);
  const err = prob - 1;
  for (let d = 0; d < dim; d++) {
    W2[d][contextIdx] -= lr * err * h[d];
  }
  const negIdx = Math.floor(Math.random() * vocabSize);
  let negScore = 0;
  for (let d = 0; d < dim; d++) negScore += h[d] * W2[d][negIdx];
  const negProb = sigmoid(negScore);
  const negErr = negProb;
  for (let d = 0; d < dim; d++) {
    W2[d][negIdx] -= lr * negErr * h[d];
  }
  const grad = new Float32Array(dim);
  for (let d = 0; d < dim; d++) {
    grad[d] = err * W2[d][contextIdx] + negErr * W2[d][negIdx];
  }
  for (let d = 0; d < dim; d++) {
    W1[centerIdx][d] -= lr * grad[d];
  }
  return -Math.log(prob + 1e-10);
}
var EMBEDDING_DIM, MODEL_VERSION2, LEARNING_RATE, WINDOW_SIZE, MIN_COUNT;
var init_embeddingTrainer = __esm({
  "server/services/embeddingTrainer.ts"() {
    "use strict";
    init_db();
    init_schema();
    EMBEDDING_DIM = 64;
    MODEL_VERSION2 = "v2.0-real";
    LEARNING_RATE = 0.025;
    WINDOW_SIZE = 5;
    MIN_COUNT = 2;
  }
});

// server/services/clustering.ts
var clustering_exports = {};
__export(clustering_exports, {
  calculateClusteringMetrics: () => calculateClusteringMetrics,
  clusterCompetitiveDecks: () => clusterCompetitiveDecks,
  deckToVector: () => deckToVector,
  kMeans: () => kMeans
});
import { eq as eq11, and as and4 } from "drizzle-orm";
async function deckToVector(deckId) {
  const db = await getDb();
  if (!db) return null;
  try {
    const deck = await db.select().from(competitiveDecks).where(eq11(competitiveDecks.id, deckId)).limit(1);
    if (deck.length === 0) return null;
    const deckCards2 = await db.select().from(competitiveDeckCards).where(and4(
      eq11(competitiveDeckCards.deckId, deckId),
      eq11(competitiveDeckCards.section, "mainboard")
    ));
    if (deckCards2.length === 0) return null;
    const cardVectors = [];
    let totalQuantity = 0;
    for (const deckCard of deckCards2) {
      const card = await db.select().from(cards).where(eq11(cards.name, deckCard.cardName)).limit(1);
      if (card.length > 0) {
        const embedding = await getCardEmbedding(card[0].id);
        if (embedding) {
          for (let i = 0; i < deckCard.quantity; i++) {
            cardVectors.push(embedding);
          }
          totalQuantity += deckCard.quantity;
        }
      }
    }
    if (cardVectors.length === 0) return null;
    const vectorLength = cardVectors[0].length;
    const avgVector = new Array(vectorLength).fill(0);
    for (const vec of cardVectors) {
      for (let i = 0; i < vectorLength; i++) {
        avgVector[i] += vec[i];
      }
    }
    for (let i = 0; i < vectorLength; i++) {
      avgVector[i] /= cardVectors.length;
    }
    return {
      deckId,
      vector: avgVector,
      colors: deck[0].colors || "",
      format: deck[0].format,
      cardCount: totalQuantity
    };
  } catch (error) {
    console.error("Error converting deck to vector:", error);
    return null;
  }
}
function euclideanDistance(a, b) {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}
function calculateCentroid(vectors) {
  if (vectors.length === 0) return [];
  const vectorLength = vectors[0].length;
  const centroid = new Array(vectorLength).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < vectorLength; i++) {
      centroid[i] += vector[i];
    }
  }
  for (let i = 0; i < vectorLength; i++) {
    centroid[i] /= vectors.length;
  }
  return centroid;
}
function assignArchetype(clusterVectors, centroid) {
  if (clusterVectors.length === 0) return "Unknown";
  const avgCardCount = clusterVectors.reduce((sum, dv) => sum + dv.cardCount, 0) / clusterVectors.length;
  const colorCounts = {};
  clusterVectors.forEach((dv) => {
    if (dv.colors) {
      dv.colors.split("").forEach((color) => {
        colorCounts[color] = (colorCounts[color] || 0) + 1;
      });
    }
  });
  const totalDecks = clusterVectors.length;
  const dominantColors = Object.entries(colorCounts).filter(([_, count]) => count / totalDecks > 0.3).sort(([, a], [, b]) => b - a).slice(0, 3).map(([color]) => color);
  if (dominantColors.length === 1) {
    const color = dominantColors[0];
    if (avgCardCount < 45) return `${color} Aggro`;
    if (avgCardCount > 65) return `${color} Control`;
    return `${color} Midrange`;
  }
  if (dominantColors.length === 2) {
    if (avgCardCount < 50) return `${dominantColors.join("")}-Aggro`;
    if (avgCardCount > 70) return `${dominantColors.join("")}-Control`;
    return `${dominantColors.join("")}-Midrange`;
  }
  if (dominantColors.length >= 3) {
    if (avgCardCount < 50) return "Multicolor Aggro";
    if (avgCardCount > 70) return "Multicolor Control";
    return "Multicolor Goodstuff";
  }
  if (avgCardCount < 45) return "Aggro";
  if (avgCardCount > 70) return "Control";
  return "Midrange";
}
function kMeans(vectors, k, maxIterations = 100) {
  if (vectors.length === 0 || k <= 0) return [];
  const centroids = [];
  for (let i = 0; i < k; i++) {
    const randomIndex = Math.floor(Math.random() * vectors.length);
    centroids.push([...vectors[randomIndex].vector]);
  }
  let clusters = [];
  let hasConverged = false;
  let iteration = 0;
  while (!hasConverged && iteration < maxIterations) {
    clusters = Array.from({ length: k }, () => []);
    const assignments2 = [];
    vectors.forEach((vector) => {
      let minDistance = Infinity;
      let closestCluster = 0;
      centroids.forEach((centroid, index) => {
        const distance = euclideanDistance(vector.vector, centroid);
        if (distance < minDistance) {
          minDistance = distance;
          closestCluster = index;
        }
      });
      clusters[closestCluster].push(vector.vector);
      assignments2.push(closestCluster);
    });
    const newCentroids = centroids.map((_, index) => {
      if (clusters[index].length > 0) {
        return calculateCentroid(clusters[index]);
      }
      return centroids[index];
    });
    hasConverged = centroids.every(
      (centroid, index) => euclideanDistance(centroid, newCentroids[index]) < 1e-3
    );
    centroids.splice(0, centroids.length, ...newCentroids);
    iteration++;
  }
  const results = [];
  clusters.forEach((clusterVectors, index) => {
    const deckVectors = vectors.filter((_, i) => assignments[i] === index);
    if (deckVectors.length > 0) {
      const archetype = assignArchetype(deckVectors, centroids[index]);
      const avgCardCount = deckVectors.reduce((sum, dv) => sum + dv.cardCount, 0) / deckVectors.length;
      const colorCounts = {};
      deckVectors.forEach((dv) => {
        if (dv.colors) {
          dv.colors.split("").forEach((color) => {
            colorCounts[color] = (colorCounts[color] || 0) + 1;
          });
        }
      });
      const totalDecks = deckVectors.length;
      const avgColors = Object.entries(colorCounts).filter(([_, count]) => count / totalDecks > 0.2).sort(([, a], [, b]) => b - a).slice(0, 3).map(([color]) => color).join("");
      results.push({
        clusterId: index,
        deckIds: deckVectors.map((dv) => dv.deckId),
        centroid: centroids[index],
        archetype,
        confidence: clusterVectors.length / vectors.length,
        avgColors,
        avgCardCount: Math.round(avgCardCount)
      });
    }
  });
  return results;
}
async function clusterCompetitiveDecks(k = 8) {
  const db = await getDb();
  if (!db) return [];
  try {
    const decks2 = await db.select().from(competitiveDecks);
    console.log(`Starting KMeans clustering with ${decks2.length} decks, k=${k}`);
    const deckVectors = [];
    for (const deck of decks2) {
      const vector = await deckToVector(deck.id);
      if (vector) {
        deckVectors.push(vector);
      }
    }
    console.log(`Converted ${deckVectors.length} decks to vectors`);
    if (deckVectors.length < k) {
      console.warn(`Not enough deck vectors (${deckVectors.length}) for k=${k} clusters`);
      return [];
    }
    const clusters = kMeans(deckVectors, k);
    console.log(`Generated ${clusters.length} clusters`);
    for (const cluster of clusters) {
      for (const deckId of cluster.deckIds) {
        await db.update(competitiveDecks).set({ archetype: cluster.archetype }).where(eq11(competitiveDecks.id, deckId));
      }
    }
    console.log("Updated deck archetypes in database");
    return clusters;
  } catch (error) {
    console.error("Error in KMeans clustering:", error);
    return [];
  }
}
function calculateClusteringMetrics(clusters, vectors) {
  if (clusters.length === 0 || vectors.length === 0) {
    return { silhouetteScore: 0, calinskiHarabaszIndex: 0, daviesBouldinIndex: 0 };
  }
  let totalSilhouette = 0;
  let validSilhouettes = 0;
  vectors.forEach((vector) => {
    const cluster = clusters.find((c) => c.deckIds.includes(vector.deckId));
    if (!cluster) return;
    const sameClusterVectors = vectors.filter(
      (v) => cluster.deckIds.includes(v.deckId) && v.deckId !== vector.deckId
    );
    const a = sameClusterVectors.length > 0 ? sameClusterVectors.reduce((sum, v) => sum + euclideanDistance(vector.vector, v.vector), 0) / sameClusterVectors.length : 0;
    let minB = Infinity;
    clusters.forEach((otherCluster) => {
      if (otherCluster.clusterId === cluster.clusterId) return;
      const otherVectors = vectors.filter((v) => otherCluster.deckIds.includes(v.deckId));
      if (otherVectors.length > 0) {
        const avgDistance = otherVectors.reduce((sum, v) => sum + euclideanDistance(vector.vector, v.vector), 0) / otherVectors.length;
        minB = Math.min(minB, avgDistance);
      }
    });
    if (a < minB) {
      const silhouette = (minB - a) / Math.max(a, minB);
      totalSilhouette += silhouette;
      validSilhouettes++;
    }
  });
  const silhouetteScore = validSilhouettes > 0 ? totalSilhouette / validSilhouettes : 0;
  const overallCentroid = calculateCentroid(vectors.map((v) => v.vector));
  const SSB = clusters.reduce((sum, cluster) => {
    const clusterSize = cluster.deckIds.length;
    const distance = euclideanDistance(cluster.centroid, overallCentroid);
    return sum + clusterSize * distance * distance;
  }, 0);
  const SSW = clusters.reduce((sum, cluster) => {
    const clusterVectors = vectors.filter((v) => cluster.deckIds.includes(v.deckId));
    return sum + clusterVectors.reduce((clusterSum, vector) => {
      return clusterSum + euclideanDistance(vector.vector, cluster.centroid) ** 2;
    }, 0);
  }, 0);
  const calinskiHarabaszIndex = SSB / (clusters.length - 1) / (SSW / (vectors.length - clusters.length));
  let totalDB = 0;
  for (let i = 0; i < clusters.length; i++) {
    let maxRatio = 0;
    for (let j = 0; j < clusters.length; j++) {
      if (i === j) continue;
      const clusterIVectors = vectors.filter((v) => clusters[i].deckIds.includes(v.deckId));
      const clusterJVectors = vectors.filter((v) => clusters[j].deckIds.includes(v.deckId));
      const avgI = clusterIVectors.reduce((sum, v) => sum + euclideanDistance(v.vector, clusters[i].centroid), 0) / clusterIVectors.length;
      const avgJ = clusterJVectors.reduce((sum, v) => sum + euclideanDistance(v.vector, clusters[j].centroid), 0) / clusterJVectors.length;
      const centroidDistance = euclideanDistance(clusters[i].centroid, clusters[j].centroid);
      const ratio = (avgI + avgJ) / centroidDistance;
      maxRatio = Math.max(maxRatio, ratio);
    }
    totalDB += maxRatio;
  }
  const daviesBouldinIndex = totalDB / clusters.length;
  return {
    silhouetteScore,
    calinskiHarabaszIndex,
    daviesBouldinIndex
  };
}
var init_clustering = __esm({
  "server/services/clustering.ts"() {
    "use strict";
    init_db();
    init_schema();
    init_embeddings();
  }
});

// server/storage.ts
function getStorageConfig() {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "Storage proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}
function buildUploadUrl(baseUrl, relKey) {
  const url = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}
function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
function normalizeKey(relKey) {
  return relKey.replace(/^\/+/, "");
}
function toFormData(data, contentType, fileName) {
  const blob = typeof data === "string" ? new Blob([data], { type: contentType }) : new Blob([data], { type: contentType });
  const form = new FormData();
  form.append("file", blob, fileName || "file");
  return form;
}
function buildAuthHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}
async function storagePut(relKey, data, contentType = "application/octet-stream") {
  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  const uploadUrl = buildUploadUrl(baseUrl, key);
  const formData = toFormData(data, contentType, key.split("/").pop() ?? key);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: buildAuthHeaders(apiKey),
    body: formData
  });
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(
      `Storage upload failed (${response.status} ${response.statusText}): ${message}`
    );
  }
  const url = (await response.json()).url;
  return { key, url };
}
var init_storage = __esm({
  "server/storage.ts"() {
    "use strict";
    init_env();
  }
});

// server/_core/imageGeneration.ts
async function generateImage(options) {
  if (!ENV.forgeApiUrl) {
    throw new Error("BUILT_IN_FORGE_API_URL is not configured");
  }
  if (!ENV.forgeApiKey) {
    throw new Error("BUILT_IN_FORGE_API_KEY is not configured");
  }
  const baseUrl = ENV.forgeApiUrl.endsWith("/") ? ENV.forgeApiUrl : `${ENV.forgeApiUrl}/`;
  const fullUrl = new URL(
    "images.v1.ImageService/GenerateImage",
    baseUrl
  ).toString();
  const response = await fetch(fullUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${ENV.forgeApiKey}`
    },
    body: JSON.stringify({
      prompt: options.prompt,
      original_images: options.originalImages || []
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Image generation request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
    );
  }
  const result = await response.json();
  const base64Data = result.image.b64Json;
  const buffer = Buffer.from(base64Data, "base64");
  const { url } = await storagePut(
    `generated/${Date.now()}.png`,
    buffer,
    result.image.mimeType
  );
  return {
    url
  };
}
var init_imageGeneration = __esm({
  "server/_core/imageGeneration.ts"() {
    "use strict";
    init_storage();
    init_env();
  }
});

// server/services/deckVisualization.ts
var deckVisualization_exports = {};
__export(deckVisualization_exports, {
  generateDeckVisualization: () => generateDeckVisualization,
  generateDeckVisualizationSet: () => generateDeckVisualizationSet
});
import { eq as eq12 } from "drizzle-orm";
async function generateDeckVisualization(options) {
  const { deckId, style = "fantasy", includeCardNames = true, customPrompt } = options;
  const db = getDb();
  const { decks: decks2, deckCards: deckCards2, cards: cards2 } = await Promise.resolve().then(() => (init_schema(), schema_exports));
  const deckResult = await db.select().from(decks2).where(eq12(decks2.id, deckId)).limit(1);
  if (!deckResult.length) {
    throw new Error("Deck not found");
  }
  const deck = deckResult[0];
  const deckCardsResult = await db.select({
    card: cards2,
    quantity: deckCards2.quantity
  }).from(deckCards2).innerJoin(cards2, eq12(deckCards2.cardId, cards2.id)).where(eq12(deckCards2.deckId, deckId));
  const prompt = customPrompt || generateDeckPrompt(deck, deckCardsResult, style, includeCardNames);
  const imageResult = await generateImage({
    prompt,
    originalImages: []
    // Could add card images as references
  });
  if (!imageResult.url) {
    throw new Error("Failed to generate deck visualization image");
  }
  return {
    deckId,
    imageUrl: imageResult.url,
    prompt,
    style,
    createdAt: /* @__PURE__ */ new Date()
  };
}
function generateDeckPrompt(deck, deckCards2, style, includeCardNames) {
  const colors = extractDeckColors(deckCards2);
  const themes = extractDeckThemes(deckCards2);
  const cardNames = includeCardNames ? extractKeyCardNames(deckCards2) : [];
  let prompt = `Create a ${style} artistic visualization of a Magic: The Gathering deck`;
  if (colors.length > 0) {
    const colorNames = colors.map((c) => {
      switch (c.toLowerCase()) {
        case "w":
          return "white";
        case "u":
          return "blue";
        case "b":
          return "black";
        case "r":
          return "red";
        case "g":
          return "green";
        default:
          return c;
      }
    });
    prompt += ` with ${colorNames.join(" and ")} color scheme`;
  }
  if (themes.length > 0) {
    prompt += ` featuring ${themes.slice(0, 3).join(", ")} themes`;
  }
  if (cardNames.length > 0) {
    prompt += `. Include visual elements representing: ${cardNames.slice(0, 5).join(", ")}`;
  }
  switch (style) {
    case "fantasy":
      prompt += ". Fantasy art style with magical elements, mystical atmosphere, detailed illustrations";
      break;
    case "minimalist":
      prompt += ". Clean minimalist design, geometric shapes, abstract representations, modern aesthetic";
      break;
    case "abstract":
      prompt += ". Abstract art style, symbolic representations, color fields, non-literal interpretation";
      break;
    case "realistic":
      prompt += ". Realistic style, detailed card illustrations, photorealistic elements, tangible magic";
      break;
  }
  prompt += ". High quality, professional artwork, suitable for deck profile image";
  return prompt;
}
function extractDeckColors(deckCards2) {
  const colors = /* @__PURE__ */ new Set();
  for (const deckCard of deckCards2) {
    const cardColors = deckCard.card.colors;
    if (cardColors) {
      for (const color of cardColors.split("")) {
        colors.add(color);
      }
    }
  }
  return Array.from(colors).sort();
}
function extractDeckThemes(deckCards2) {
  const themes = /* @__PURE__ */ new Set();
  for (const deckCard of deckCards2) {
    const cardType = deckCard.card.type?.toLowerCase() || "";
    if (cardType.includes("creature")) themes.add("creatures");
    if (cardType.includes("instant") || cardType.includes("sorcery")) themes.add("spells");
    if (cardType.includes("artifact")) themes.add("artifacts");
    if (cardType.includes("enchantment")) themes.add("enchantments");
    if (cardType.includes("planeswalker")) themes.add("planeswalkers");
    if (cardType.includes("land")) themes.add("lands");
    const cardName = deckCard.card.name?.toLowerCase() || "";
    const cardText = deckCard.card.text?.toLowerCase() || "";
    if (cardName.includes("dragon") || cardText.includes("dragon")) themes.add("dragons");
    if (cardName.includes("angel") || cardText.includes("angel")) themes.add("angels");
    if (cardName.includes("demon") || cardText.includes("demon")) themes.add("demons");
    if (cardName.includes("zombie") || cardText.includes("zombie")) themes.add("undead");
    if (cardName.includes("elf") || cardText.includes("elf")) themes.add("elves");
    if (cardName.includes("goblin") || cardText.includes("goblin")) themes.add("goblins");
  }
  return Array.from(themes);
}
function extractKeyCardNames(deckCards2) {
  const sortedCards = deckCards2.filter((dc) => dc.card.cmc !== null && dc.card.cmc >= 3).sort((a, b) => b.quantity * (b.card.cmc || 0) - a.quantity * (a.card.cmc || 0)).slice(0, 8);
  return sortedCards.map((dc) => dc.card.name);
}
async function generateDeckVisualizationSet(deckId) {
  const styles = [
    "fantasy",
    "minimalist",
    "abstract",
    "realistic"
  ];
  const visualizations = [];
  for (const style of styles) {
    try {
      const visualization = await generateDeckVisualization({
        deckId,
        style,
        includeCardNames: true
      });
      visualizations.push(visualization);
    } catch (error) {
      console.error(`Failed to generate ${style} visualization for deck ${deckId}:`, error);
    }
  }
  return visualizations;
}
var init_deckVisualization = __esm({
  "server/services/deckVisualization.ts"() {
    "use strict";
    init_imageGeneration();
    init_db();
  }
});

// server/services/deckSharing.ts
var deckSharing_exports = {};
__export(deckSharing_exports, {
  createDeckShare: () => createDeckShare,
  generateMetaTags: () => generateMetaTags,
  generateShareUrls: () => generateShareUrls,
  getSharedDeck: () => getSharedDeck
});
import { eq as eq13 } from "drizzle-orm";
async function createDeckShare(options) {
  const { deckId, title, description, includeImage = true, expiresInDays } = options;
  const db = getDb();
  const { decks: decks2, deckCards: deckCards2, cards: cards2 } = await Promise.resolve().then(() => (init_schema(), schema_exports));
  const deckResult = await db.select().from(decks2).where(eq13(decks2.id, deckId)).limit(1);
  if (!deckResult.length) {
    throw new Error("Deck not found");
  }
  const deck = deckResult[0];
  const deckCardsResult = await db.select({
    card: cards2,
    quantity: deckCards2.quantity
  }).from(deckCards2).innerJoin(cards2, eq13(deckCards2.cardId, cards2.id)).where(eq13(deckCards2.deckId, deckId));
  const shareId = generateShareId();
  const decklist = generateDecklistText(deck, deckCardsResult);
  const colors = extractDeckColors2(deckCardsResult);
  let imageUrl;
  if (includeImage) {
    try {
      const visualization = await generateDeckVisualization({
        deckId,
        style: "fantasy",
        includeCardNames: false
      });
      imageUrl = visualization.imageUrl;
    } catch (error) {
      console.warn("Failed to generate deck image for sharing:", error);
    }
  }
  const shareData = {
    deckId,
    shareId,
    title: title || `${deck.name} - ${deck.format}`,
    description: description || generateDeckDescription(deck, deckCardsResult),
    imageUrl,
    decklist,
    format: deck.format,
    colors,
    createdAt: /* @__PURE__ */ new Date(),
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1e3) : void 0
  };
  return shareData;
}
async function getSharedDeck(shareId) {
  return null;
}
function generateShareId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}
function generateDecklistText(deck, deckCards2) {
  let decklist = `${deck.name}
`;
  if (deck.description) {
    decklist += `${deck.description}
`;
  }
  decklist += `
`;
  const creatures = deckCards2.filter((dc) => dc.card.type?.toLowerCase().includes("creature"));
  const spells = deckCards2.filter(
    (dc) => dc.card.type?.toLowerCase().includes("instant") || dc.card.type?.toLowerCase().includes("sorcery")
  );
  const artifacts = deckCards2.filter((dc) => dc.card.type?.toLowerCase().includes("artifact"));
  const enchantments = deckCards2.filter((dc) => dc.card.type?.toLowerCase().includes("enchantment"));
  const planeswalkers = deckCards2.filter((dc) => dc.card.type?.toLowerCase().includes("planeswalker"));
  const lands = deckCards2.filter((dc) => dc.card.type?.toLowerCase().includes("land"));
  if (creatures.length > 0) {
    decklist += `Creatures (${creatures.reduce((sum, dc) => sum + dc.quantity, 0)})
`;
    creatures.forEach((dc) => {
      decklist += `${dc.quantity} ${dc.card.name}
`;
    });
    decklist += `
`;
  }
  if (spells.length > 0) {
    decklist += `Spells (${spells.reduce((sum, dc) => sum + dc.quantity, 0)})
`;
    spells.forEach((dc) => {
      decklist += `${dc.quantity} ${dc.card.name}
`;
    });
    decklist += `
`;
  }
  if (artifacts.length > 0) {
    decklist += `Artifacts (${artifacts.reduce((sum, dc) => sum + dc.quantity, 0)})
`;
    artifacts.forEach((dc) => {
      decklist += `${dc.quantity} ${dc.card.name}
`;
    });
    decklist += `
`;
  }
  if (enchantments.length > 0) {
    decklist += `Enchantments (${enchantments.reduce((sum, dc) => sum + dc.quantity, 0)})
`;
    enchantments.forEach((dc) => {
      decklist += `${dc.card.name}
`;
    });
    decklist += `
`;
  }
  if (planeswalkers.length > 0) {
    decklist += `Planeswalkers (${planeswalkers.reduce((sum, dc) => sum + dc.quantity, 0)})
`;
    planeswalkers.forEach((dc) => {
      decklist += `${dc.quantity} ${dc.card.name}
`;
    });
    decklist += `
`;
  }
  if (lands.length > 0) {
    decklist += `Lands (${lands.reduce((sum, dc) => sum + dc.quantity, 0)})
`;
    lands.forEach((dc) => {
      decklist += `${dc.quantity} ${dc.card.name}
`;
    });
    decklist += `
`;
  }
  return decklist.trim();
}
function generateDeckDescription(deck, deckCards2) {
  const colors = extractDeckColors2(deckCards2);
  const colorNames = colors.map((c) => {
    switch (c.toLowerCase()) {
      case "w":
        return "White";
      case "u":
        return "Blue";
      case "b":
        return "Black";
      case "r":
        return "Red";
      case "g":
        return "Green";
      default:
        return c;
    }
  });
  const totalCards = deckCards2.reduce((sum, dc) => sum + dc.quantity, 0);
  const creatureCount = deckCards2.filter((dc) => dc.card.type?.toLowerCase().includes("creature")).reduce((sum, dc) => sum + dc.quantity, 0);
  let description = `${deck.format} deck`;
  if (colorNames.length > 0) {
    description += ` - ${colorNames.join("/")}`;
  }
  description += ` with ${totalCards} cards`;
  if (creatureCount > 0) {
    description += `, ${creatureCount} creatures`;
  }
  return description;
}
function extractDeckColors2(deckCards2) {
  const colors = /* @__PURE__ */ new Set();
  for (const deckCard of deckCards2) {
    const cardColors = deckCard.card.colors;
    if (cardColors) {
      for (const color of cardColors.split("")) {
        colors.add(color);
      }
    }
  }
  return Array.from(colors).sort();
}
function generateShareUrls(shareData) {
  const baseUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/shared/${shareData.shareId}`;
  const text2 = `Check out this ${shareData.format} deck: ${shareData.title}`;
  return {
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text2)}&url=${encodeURIComponent(baseUrl)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(baseUrl)}`,
    reddit: `https://reddit.com/submit?url=${encodeURIComponent(baseUrl)}&title=${encodeURIComponent(shareData.title)}`,
    discord: `https://discord.com/api/webhooks/...`
    // Would need webhook URL
  };
}
function generateMetaTags(shareData) {
  const baseUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/shared/${shareData.shareId}`;
  return `
    <meta property="og:title" content="${shareData.title}" />
    <meta property="og:description" content="${shareData.description}" />
    <meta property="og:image" content="${shareData.imageUrl || ""}" />
    <meta property="og:url" content="${baseUrl}" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${shareData.title}" />
    <meta name="twitter:description" content="${shareData.description}" />
    <meta name="twitter:image" content="${shareData.imageUrl || ""}" />
  `.trim();
}
var init_deckSharing = __esm({
  "server/services/deckSharing.ts"() {
    "use strict";
    init_db();
    init_deckVisualization();
  }
});

// server/_core/index.ts
import "dotenv/config";
import express2 from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var AXIOS_TIMEOUT_MS = 3e4;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";

// server/_core/oauth.ts
init_db();

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req)
  };
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
init_db();
init_env();
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
var GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
var GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;
var OAuthService = class {
  constructor(client) {
    this.client = client;
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }
  decodeState(state) {
    const redirectUri = atob(state);
    return redirectUri;
  }
  async getTokenByCode(code, state) {
    const payload = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state)
    };
    const { data } = await this.client.post(
      EXCHANGE_TOKEN_PATH,
      payload
    );
    return data;
  }
  async getUserInfoByToken(token) {
    const { data } = await this.client.post(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken
      }
    );
    return data;
  }
};
var createOAuthHttpClient = () => axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS
});
var SDKServer = class {
  client;
  oauthService;
  constructor(client = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }
  deriveLoginMethod(platforms, fallback) {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set(
      platforms.filter((p) => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (set.has("REGISTERED_PLATFORM_MICROSOFT") || set.has("REGISTERED_PLATFORM_AZURE"))
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }
  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(code, state) {
    return this.oauthService.getTokenByCode(code, state);
  }
  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken) {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken
    });
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  parseCookies(cookieHeader) {
    if (!cookieHeader) {
      return /* @__PURE__ */ new Map();
    }
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }
  getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }
  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || ""
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    const secretKey = this.getSessionSecret();
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
  }
  async verifySession(cookieValue) {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"]
      });
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      return {
        openId,
        appId,
        name
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }
  async getUserInfoWithJwt(jwtToken) {
    const payload = {
      jwtToken,
      projectId: ENV.appId
    };
    const { data } = await this.client.post(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  async authenticateRequest(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);
    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }
    const sessionUserId = session.openId;
    const signedInAt = /* @__PURE__ */ new Date();
    let user = await getUserByOpenId(sessionUserId);
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionCookie ?? "");
        await upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt
        });
        user = await getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    return user;
  }
};
var sdk = new SDKServer();

// server/_core/oauth.ts
function getQueryParam(req, key) {
  const value = req.query[key];
  return typeof value === "string" ? value : void 0;
}
function registerOAuthRoutes(app) {
  app.get("/api/oauth/callback", async (req, res) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }
      await upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
init_env();
import { TRPCError } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/trpc.ts
import { initTRPC, TRPCError as TRPCError2 } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError2({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/routers.ts
import { z as z2 } from "zod";
var appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true
      };
    })
  }),
  cards: router({
    search: publicProcedure.input(
      z2.object({
        name: z2.string().optional(),
        type: z2.string().optional(),
        colors: z2.string().optional(),
        cmc: z2.number().optional(),
        rarity: z2.string().optional()
      })
    ).query(async ({ input }) => {
      const { searchCards: searchCards2 } = await Promise.resolve().then(() => (init_scryfall(), scryfall_exports));
      return await searchCards2(input);
    }),
    getById: publicProcedure.input(z2.number()).query(async ({ input }) => {
      const { getCardById: getCardById3 } = await Promise.resolve().then(() => (init_scryfall(), scryfall_exports));
      return await getCardById3(input);
    }),
    similar: publicProcedure.input(z2.number()).query(async ({ input }) => {
      const { findSimilarCards: findSimilarCards2 } = await Promise.resolve().then(() => (init_embeddings(), embeddings_exports));
      return await findSimilarCards2(input, 10);
    }),
    synergy: publicProcedure.input(z2.object({ card1Id: z2.number(), card2Id: z2.number() })).query(async ({ input }) => {
      const { getCardSynergy: getCardSynergy2 } = await Promise.resolve().then(() => (init_synergy(), synergy_exports));
      return await getCardSynergy2(input.card1Id, input.card2Id);
    })
  }),
  decks: router({
    create: protectedProcedure.input(
      z2.object({
        name: z2.string(),
        format: z2.enum(["standard", "modern", "commander", "legacy"]),
        archetype: z2.string().optional(),
        description: z2.string().optional()
      })
    ).mutation(async ({ ctx, input }) => {
      const { createDeck: createDeck2 } = await Promise.resolve().then(() => (init_db_decks(), db_decks_exports));
      return await createDeck2(ctx.user.id, input.name, input.format, input.archetype, input.description);
    }),
    list: protectedProcedure.query(async ({ ctx }) => {
      const { getUserDecks: getUserDecks2 } = await Promise.resolve().then(() => (init_db_decks(), db_decks_exports));
      return await getUserDecks2(ctx.user.id);
    }),
    getById: publicProcedure.input(z2.number()).query(async ({ input }) => {
      const { getDeckById: getDeckById2 } = await Promise.resolve().then(() => (init_db_decks(), db_decks_exports));
      return await getDeckById2(input);
    }),
    addCard: protectedProcedure.input(
      z2.object({
        deckId: z2.number(),
        cardId: z2.number(),
        quantity: z2.number().default(1)
      })
    ).mutation(async ({ input }) => {
      const { addCardToDeck: addCardToDeck2 } = await Promise.resolve().then(() => (init_db_decks(), db_decks_exports));
      return await addCardToDeck2(input.deckId, input.cardId, input.quantity);
    }),
    removeCard: protectedProcedure.input(
      z2.object({
        deckId: z2.number(),
        cardId: z2.number()
      })
    ).mutation(async ({ input }) => {
      const { removeCardFromDeck: removeCardFromDeck2 } = await Promise.resolve().then(() => (init_db_decks(), db_decks_exports));
      return await removeCardFromDeck2(input.deckId, input.cardId);
    }),
    getCards: publicProcedure.input(z2.number()).query(async ({ input }) => {
      const { getDeckCards: getDeckCards2 } = await Promise.resolve().then(() => (init_db_decks(), db_decks_exports));
      return await getDeckCards2(input);
    }),
    delete: protectedProcedure.input(z2.number()).mutation(async ({ input }) => {
      const { deleteDeck: deleteDeck2 } = await Promise.resolve().then(() => (init_db_decks(), db_decks_exports));
      return await deleteDeck2(input);
    })
  }),
  generator: router({
    generateByArchetype: publicProcedure.input(
      z2.object({
        archetype: z2.enum(["aggro", "burn", "control", "combo", "midrange", "ramp", "tempo"]),
        format: z2.enum(["standard", "historic", "modern", "legacy", "commander", "pioneer"]),
        colors: z2.array(z2.enum(["W", "U", "B", "R", "G"])).optional(),
        tribes: z2.array(z2.string()).optional(),
        cardTypes: z2.array(z2.string()).optional(),
        useScoring: z2.boolean().optional()
      })
    ).mutation(async ({ input }) => {
      const { generateDeckByArchetype: generateDeckByArchetype2, exportToText: exportToText2, exportToArena: exportToArena2 } = await Promise.resolve().then(() => (init_archetypeGenerator(), archetypeGenerator_exports));
      const { searchCards: searchCards2 } = await Promise.resolve().then(() => (init_scryfall(), scryfall_exports));
      const { evaluateDeckWithEngine: evaluateDeckWithEngine2 } = await Promise.resolve().then(() => (init_deckGenerator(), deckGenerator_exports));
      const { validateDeck: validateDeck2 } = await Promise.resolve().then(() => (init_deckGenerator(), deckGenerator_exports));
      const cardPool = await searchCards2({
        colors: input.colors?.join("") || void 0
      });
      if (cardPool.length === 0) {
        return {
          error: "Nenhuma carta encontrada no banco. Sincronize cartas do Scryfall primeiro.",
          deck: [],
          metrics: null,
          validation: null,
          template: null,
          poolSize: 0,
          warnings: ["Banco de dados vazio."],
          exportText: "",
          exportArena: ""
        };
      }
      const result = generateDeckByArchetype2(cardPool, {
        archetype: input.archetype,
        format: input.format,
        colors: input.colors,
        tribes: input.tribes,
        cardTypes: input.cardTypes,
        useScoring: input.useScoring ?? true
      });
      const metrics = evaluateDeckWithEngine2(result.cards, input.archetype);
      const validation = validateDeck2(result.cards, input.format === "historic" || input.format === "pioneer" ? "standard" : input.format);
      return {
        deck: result.cards,
        template: result.template,
        poolSize: result.poolSize,
        warnings: result.warnings,
        metrics,
        validation,
        exportText: exportToText2(result.cards, { archetype: input.archetype, format: input.format }),
        exportArena: exportToArena2(result.cards)
      };
    }),
    generate: publicProcedure.input(
      z2.object({
        format: z2.enum(["standard", "modern", "commander", "legacy"]),
        archetype: z2.string().optional(),
        seedCards: z2.array(z2.number()).optional(),
        useRL: z2.boolean().optional()
      })
    ).mutation(async ({ input }) => {
      const { generateInitialDeck: generateInitialDeck2, validateDeck: validateDeck2, evaluateDeckWithEngine: evaluateDeckWithEngine2, trainDeckWithRL: trainDeckWithRL2 } = await Promise.resolve().then(() => (init_deckGenerator(), deckGenerator_exports));
      const deck = await generateInitialDeck2(input, input.seedCards);
      const validation = validateDeck2(deck, input.format);
      const metrics = evaluateDeckWithEngine2(deck, input.archetype || "default");
      if (input.useRL) {
        const { deck: rlDeck, metrics: rlMetrics, improvements } = await trainDeckWithRL2(
          deck,
          { format: input.format, archetype: input.archetype },
          void 0,
          200
        );
        const rlValidation = validateDeck2(rlDeck, input.format);
        return { deck: rlDeck, validation: rlValidation, metrics: rlMetrics, improvements };
      }
      return { deck, validation, metrics, improvements: 0 };
    }),
    evaluate: publicProcedure.input(
      z2.object({
        cards: z2.array(z2.object({
          name: z2.string(),
          type: z2.string().optional(),
          text: z2.string().optional(),
          cmc: z2.number().optional(),
          quantity: z2.number()
        })),
        archetype: z2.string().optional()
      })
    ).mutation(async ({ input }) => {
      const { evaluateDeck: evaluateDeck2 } = await Promise.resolve().then(() => (init_gameFeatureEngine(), gameFeatureEngine_exports));
      const expanded = [];
      for (const card of input.cards) {
        for (let i = 0; i < card.quantity; i++) {
          expanded.push({ name: card.name, type: card.type, text: card.text, cmc: card.cmc });
        }
      }
      return evaluateDeck2(expanded, input.archetype || "default");
    })
  }),
  sync: router({
    syncScryfall: publicProcedure.input(
      z2.object({
        format: z2.enum(["standard", "modern", "commander", "legacy", "all"]).optional(),
        colors: z2.array(z2.string()).optional(),
        limit: z2.number().optional()
      })
    ).mutation(async ({ input }) => {
      const { syncCardsFromScryfall: syncCardsFromScryfall2 } = await Promise.resolve().then(() => (init_scryfallSync(), scryfallSync_exports));
      return await syncCardsFromScryfall2(input);
    }),
    getStats: publicProcedure.query(async () => {
      const { getCardStats: getCardStats2 } = await Promise.resolve().then(() => (init_scryfallSync(), scryfallSync_exports));
      return await getCardStats2();
    })
  }),
  moxfield: router({
    importDecks: publicProcedure.input(
      z2.object({
        format: z2.enum(["standard", "modern", "commander", "legacy"]).optional(),
        limit: z2.number().min(1).max(100).optional()
      })
    ).mutation(async ({ input }) => {
      const { importMoxfieldDecks: importMoxfieldDecks2 } = await Promise.resolve().then(() => (init_moxfieldScraper(), moxfieldScraper_exports));
      return await importMoxfieldDecks2(input.format || "standard", input.limit || 50);
    }),
    getStats: publicProcedure.query(async () => {
      const { getCompetitiveDeckStats: getCompetitiveDeckStats2 } = await Promise.resolve().then(() => (init_moxfieldScraper(), moxfieldScraper_exports));
      return await getCompetitiveDeckStats2();
    })
  }),
  mtgtop8: router({
    importDecks: publicProcedure.input(
      z2.object({
        format: z2.enum(["standard", "pioneer", "modern", "legacy", "vintage", "commander"]).optional(),
        limit: z2.number().min(1).max(100).optional()
      })
    ).mutation(async ({ input }) => {
      const { importMTGTop8Decks: importMTGTop8Decks2 } = await Promise.resolve().then(() => (init_mtgtop8Scraper(), mtgtop8Scraper_exports));
      return await importMTGTop8Decks2(input.format || "standard", input.limit || 50);
    })
  }),
  mtggoldfish: router({
    importDecks: publicProcedure.input(
      z2.object({
        format: z2.enum(["standard", "pioneer", "modern", "legacy", "vintage", "commander"]).optional(),
        limit: z2.number().min(1).max(100).optional()
      })
    ).mutation(async ({ input }) => {
      const { importMTGGoldfishDecks: importMTGGoldfishDecks2 } = await Promise.resolve().then(() => (init_mtggoldfishScraper(), mtggoldfishScraper_exports));
      return await importMTGGoldfishDecks2(input.format || "standard", input.limit || 50);
    })
  }),
  training: router({
    trainEmbeddings: publicProcedure.mutation(async () => {
      const { trainEmbeddingsFromDecks: trainEmbeddingsFromDecks2 } = await Promise.resolve().then(() => (init_embeddingTrainer(), embeddingTrainer_exports));
      return await trainEmbeddingsFromDecks2();
    }),
    clusterDecks: publicProcedure.input(z2.object({ k: z2.number().min(2).max(20).optional() })).mutation(async ({ input }) => {
      const { clusterCompetitiveDecks: clusterCompetitiveDecks2, calculateClusteringMetrics: calculateClusteringMetrics2, deckToVector: deckToVector2 } = await Promise.resolve().then(() => (init_clustering(), clustering_exports));
      const clusters = await clusterCompetitiveDecks2(input.k || 8);
      let metrics = null;
      if (clusters.length > 0) {
        const db = await Promise.resolve().then(() => (init_db(), db_exports)).then((m) => m.getDb());
        if (db) {
          const competitiveDecks2 = await Promise.resolve().then(() => (init_schema(), schema_exports)).then((m) => m.competitiveDecks);
          const decks2 = await db.select().from(competitiveDecks2);
          const vectors = [];
          for (const deck of decks2.slice(0, 100)) {
            const vector = await deckToVector2(deck.id);
            if (vector) vectors.push(vector);
          }
          metrics = calculateClusteringMetrics2(clusters, vectors);
        }
      }
      return {
        clusters,
        metrics,
        totalClusters: clusters.length,
        totalDecksClustered: clusters.reduce((sum, c) => sum + c.deckIds.length, 0)
      };
    }),
    getHistory: publicProcedure.query(async () => {
      const { getTrainingJobHistory: getTrainingJobHistory2 } = await Promise.resolve().then(() => (init_embeddingTrainer(), embeddingTrainer_exports));
      return await getTrainingJobHistory2(10);
    })
  }),
  visualization: router({
    generateDeckArt: publicProcedure.input(
      z2.object({
        deckId: z2.number(),
        style: z2.enum(["fantasy", "minimalist", "abstract", "realistic"]).optional(),
        includeCardNames: z2.boolean().optional(),
        customPrompt: z2.string().optional()
      })
    ).mutation(async ({ input }) => {
      const { generateDeckVisualization: generateDeckVisualization2 } = await Promise.resolve().then(() => (init_deckVisualization(), deckVisualization_exports));
      return await generateDeckVisualization2(input);
    }),
    generateDeckArtSet: publicProcedure.input(z2.object({ deckId: z2.number() })).mutation(async ({ input }) => {
      const { generateDeckVisualizationSet: generateDeckVisualizationSet2 } = await Promise.resolve().then(() => (init_deckVisualization(), deckVisualization_exports));
      return await generateDeckVisualizationSet2(input.deckId);
    })
  }),
  sharing: router({
    createShare: publicProcedure.input(
      z2.object({
        deckId: z2.number(),
        title: z2.string().optional(),
        description: z2.string().optional(),
        includeImage: z2.boolean().optional(),
        expiresInDays: z2.number().min(1).max(365).optional()
      })
    ).mutation(async ({ input }) => {
      const { createDeckShare: createDeckShare2 } = await Promise.resolve().then(() => (init_deckSharing(), deckSharing_exports));
      return await createDeckShare2(input);
    }),
    getSharedDeck: publicProcedure.input(z2.object({ shareId: z2.string() })).query(async ({ input }) => {
      const { getSharedDeck: getSharedDeck2 } = await Promise.resolve().then(() => (init_deckSharing(), deckSharing_exports));
      return await getSharedDeck2(input.shareId);
    }),
    getShareUrls: publicProcedure.input(z2.object({ shareId: z2.string() })).query(async ({ input }) => {
      const { getSharedDeck: getSharedDeck2, generateShareUrls: generateShareUrls2 } = await Promise.resolve().then(() => (init_deckSharing(), deckSharing_exports));
      const shareData = await getSharedDeck2(input.shareId);
      if (!shareData) {
        throw new Error("Share not found");
      }
      return generateShareUrls2(shareData);
    })
  })
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/vite.ts
import express from "express";
import fs2 from "fs";
import { nanoid } from "nanoid";
import path2 from "path";
import { createServer as createViteServer } from "vite";

// vite.config.ts
import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";
var PROJECT_ROOT = import.meta.dirname;
var LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginManusDebugCollector() {
  return {
    name: "manus-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
var plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector()];
var vite_config_default = defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets")
    }
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1"
    ],
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/_core/vite.ts
async function setupVite(app, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    server: serverOptions,
    appType: "custom"
  });
  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );
      let template = await fs2.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app) {
  const distPath = process.env.NODE_ENV === "development" ? path2.resolve(import.meta.dirname, "../..", "dist", "public") : path2.resolve(import.meta.dirname, "public");
  if (!fs2.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app.use(express.static(distPath));
  app.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/_core/index.ts
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}
async function findAvailablePort(startPort = 3e3) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}
async function startServer() {
  const app = express2();
  const server = createServer(app);
  app.use(express2.json({ limit: "50mb" }));
  app.use(express2.urlencoded({ limit: "50mb", extended: true }));
  registerOAuthRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
startServer().catch(console.error);
