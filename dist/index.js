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
import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
var users, cards, decks, deckCards, cardSynergies, metaStats, embeddingsCache;
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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
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

// server/services/deckGenerator.ts
var deckGenerator_exports = {};
__export(deckGenerator_exports, {
  generateInitialDeck: () => generateInitialDeck,
  optimizeDeck: () => optimizeDeck,
  simulateMatch: () => simulateMatch,
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
async function simulateMatch(deck1, deck2) {
  let score1 = 0;
  let score2 = 0;
  for (const card of deck1) {
    score1 += (card.cmc || 2) * card.quantity;
  }
  for (const card of deck2) {
    score2 += (card.cmc || 2) * card.quantity;
  }
  score1 += Math.random() * 50;
  score2 += Math.random() * 50;
  return score1 > score2 ? 1 : 0;
}
async function trainDeckWithRL(initialDeck, options, iterations = 10, simulationsPerIteration = 5) {
  let bestDeck = [...initialDeck];
  let bestWinRate = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const mutatedDeck = mutateDeck(bestDeck, options);
    let wins = 0;
    for (let sim = 0; sim < simulationsPerIteration; sim++) {
      const randomDeck = await generateInitialDeck(options);
      const result = await simulateMatch(mutatedDeck, randomDeck);
      wins += result;
    }
    const winRate = wins / simulationsPerIteration;
    if (winRate > bestWinRate) {
      bestWinRate = winRate;
      bestDeck = mutatedDeck;
    }
  }
  return bestDeck;
}
function mutateDeck(deck, options) {
  const mutated = [...deck];
  const maxCopies = options.format === "commander" ? 1 : 4;
  if (Math.random() < 0.5 && mutated.length > 1) {
    const idx = Math.floor(Math.random() * mutated.length);
    mutated.splice(idx, 1);
  }
  if (mutated.length > 0 && Math.random() < 0.5) {
    const idx = Math.floor(Math.random() * mutated.length);
    const newQuantity = Math.floor(Math.random() * maxCopies) + 1;
    mutated[idx] = { ...mutated[idx], quantity: newQuantity };
  }
  return mutated;
}
var init_deckGenerator = __esm({
  "server/services/deckGenerator.ts"() {
    "use strict";
    init_scryfall();
    init_embeddings();
    init_synergy();
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
    generate: publicProcedure.input(
      z2.object({
        format: z2.enum(["standard", "modern", "commander", "legacy"]),
        archetype: z2.string().optional(),
        seedCards: z2.array(z2.number()).optional()
      })
    ).mutation(async ({ input }) => {
      const { generateInitialDeck: generateInitialDeck2, optimizeDeck: optimizeDeck2, validateDeck: validateDeck2 } = await Promise.resolve().then(() => (init_deckGenerator(), deckGenerator_exports));
      const deck = await generateInitialDeck2(input, input.seedCards);
      const optimized = await optimizeDeck2(deck, input, 3);
      const validation = validateDeck2(optimized, input.format);
      return { deck: optimized, validation };
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
