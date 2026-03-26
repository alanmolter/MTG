import { getDb } from "../db";
import { competitiveDecks, competitiveDeckCards, cards, metaStats } from "../../drizzle/schema";
import { eq, sql, and } from "drizzle-orm";

export interface MetaStatsResult {
  format: string;
  totalDecks: number;
  topCards: Array<{ name: string; frequency: number; playRate: number }>;
  archetypeDistribution: Array<{ archetype: string; count: number; percentage: number }>;
}

/**
 * Performs analysis of competitive decks to generate meta statistics
 */
export async function performMetaAnalysis(format: string): Promise<MetaStatsResult> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  console.log(`[Meta] Analyzing format: ${format}`);

  // 1. Get total decks in format
  const decksInFormat = await db
    .select({ count: sql<number>`count(*)` })
    .from(competitiveDecks)
    .where(eq(competitiveDecks.format, format));

  const totalDecks = decksInFormat[0]?.count || 0;

  if (totalDecks === 0) {
    return { format, totalDecks: 0, topCards: [], archetypeDistribution: [] };
  }

  // 2. Calculate archetype distribution
  const archetypeStats = await db
    .select({
      archetype: competitiveDecks.archetype,
      count: sql<number>`count(*)`,
    })
    .from(competitiveDecks)
    .where(eq(competitiveDecks.format, format))
    .groupBy(competitiveDecks.archetype)
    .orderBy(sql`count(*) DESC`);

  const archetypeDistribution = archetypeStats.map((a) => ({
    archetype: a.archetype || "Unknown",
    count: a.count,
    percentage: (a.count / totalDecks) * 100,
  }));

  // 3. Calculate card frequencies
  const cardStats = await db
    .select({
      cardName: competitiveDeckCards.cardName,
      decksWithCard: sql<number>`count(distinct ${competitiveDeckCards.deckId})`,
      totalQuantity: sql<number>`sum(${competitiveDeckCards.quantity})`,
    })
    .from(competitiveDeckCards)
    .innerJoin(competitiveDecks, eq(competitiveDeckCards.deckId, competitiveDecks.id))
    .where(and(eq(competitiveDecks.format, format), eq(competitiveDeckCards.section, "mainboard")))
    .groupBy(competitiveDeckCards.cardName)
    .orderBy(sql`count(distinct ${competitiveDeckCards.deckId}) DESC`)
    .limit(50);

  const topCards = cardStats.map((c) => ({
    name: c.cardName,
    frequency: c.decksWithCard,
    playRate: (c.decksWithCard / totalDecks) * 100,
  }));

  // 4. Update meta_stats table for each top card
  // This helps the deck generator and other services find "staples"
  for (const card of topCards) {
    const cardInfo = await db
        .select({ id: cards.id })
        .from(cards)
        .where(eq(cards.name, card.name))
        .limit(1);

    if (cardInfo.length > 0) {
        await db.insert(metaStats).values({
            cardId: cardInfo[0].id,
            format,
            frequency: card.frequency,
            playRate: Math.round(card.playRate),
        }).onConflictDoUpdate({
            target: [metaStats.cardId, metaStats.format, metaStats.archetype],
            set: { 
                frequency: card.frequency, 
                playRate: Math.round(card.playRate),
                updatedAt: new Date()
            }
        });
    }
  }

  return {
    format,
    totalDecks,
    topCards,
    archetypeDistribution,
  };
}

/**
 * Get current meta stats for a format (cached from meta_stats table)
 */
export async function getMetaStats(format: string) {
  const db = await getDb();
  if (!db) return null;

  const topCards = await db
    .select({
      card: cards,
      playRate: metaStats.playRate,
      frequency: metaStats.frequency,
    })
    .from(metaStats)
    .innerJoin(cards, eq(metaStats.cardId, cards.id))
    .where(eq(metaStats.format, format))
    .orderBy(sql`${metaStats.playRate} DESC`)
    .limit(20);

  return {
    format,
    topCards,
  };
}
