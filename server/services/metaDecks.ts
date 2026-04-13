/**
 * Meta Decks Database
 *
 * Decks "Gold Standard" (MTGGoldfish/MTGTop8) para o sistema aprender padrões.
 * Cada arquétipo deve ter pelo menos 2 oponentes para que o winrate não seja
 * distorcido por um único deck muito forte ou muito fraco.
 */

export const META_DECKS = {
  aggro: [
    `
    4 Monastery Swiftspear
    4 Soul-Scar Mage
    4 Play with Fire
    4 Lightning Strike
    4 Kumano Faces Kakkazan
    4 Eidolon of the Great Revel
    2 Chandra, Dressed to Kill
    18 Mountain
    4 Den of the Bugbear
    `,
    `
    4 Thalia, Guardian of Thraben
    4 Adeline, Resplendent Cathar
    4 Hopeful Initiate
    4 Brutal Cathar
    4 Luminarch Aspirant
    4 Skyclave Apparition
    22 Plains
    `,
    `
    4 Goblin Guide
    4 Goblin Bushwhacker
    4 Reckless Bushwhacker
    4 Goblin Grenade
    4 Lightning Bolt
    4 Shard Volley
    4 Goblin Rabblemaster
    20 Mountain
    `
  ],
  control: [
    `
    4 Teferi, Hero of Dominaria
    4 Counterspell
    4 Archmage's Charm
    4 Memory Deluge
    4 Portable Hole
    4 Prismatic Ending
    4 Shark Typhoon
    26 Island
    `,
    `
    4 Farewell
    4 The Wandering Emperor
    4 Memory Deluge
    4 Sunfall
    4 Dissipate
    4 Negate
    26 Plains
    `,
    `
    4 Snapcaster Mage
    4 Force of Will
    4 Brainstorm
    4 Ponder
    4 Daze
    4 Spell Pierce
    4 Jace, the Mind Sculptor
    24 Island
    `
  ],
  midrange: [
    `
    4 Sheoldred, the Apocalypse
    4 Fable of the Mirror-Breaker
    4 Bloodtithe Harvester
    4 Graveyard Trespasser
    4 Fatal Push
    4 Thoughtseize
    24 Swamp
    `,
    `
    4 Questing Beast
    4 Lovestruck Beast
    4 Edgewall Innkeeper
    4 Bonecrusher Giant
    4 Embercleave
    4 Rimrock Knight
    24 Forest
    `,
    `
    4 Tarmogoyf
    4 Dark Confidant
    4 Liliana of the Veil
    4 Inquisition of Kozilek
    4 Terminate
    4 Bloodbraid Elf
    20 Swamp
    `
  ]
};

// ---------------------------------------------------------------------------
// Loader dinâmico: tenta carregar decks reais do banco, cai no hardcoded
// ---------------------------------------------------------------------------

/**
 * Retorna decks de referência para avaliação de winrate.
 * Prioriza decks competitivos reais do banco; usa META_DECKS hardcoded como fallback.
 */
export async function getMetaDecksForArchetype(archetype: string): Promise<string[]> {
  try {
    const { getDb } = await import("../db");
    const { competitiveDecks, competitiveDeckCards } = await import("../../drizzle/schema");
    const { eq, inArray } = await import("drizzle-orm");

    const db = await getDb();
    if (!db) return META_DECKS[archetype as keyof typeof META_DECKS] ?? META_DECKS.aggro;

    // Busca até 3 decks competitivos reais para o arquétipo
    const dbDecks = await db
      .select()
      .from(competitiveDecks)
      .where(eq(competitiveDecks.archetype, archetype))
      .limit(3);

    if (dbDecks.length === 0) {
      return META_DECKS[archetype as keyof typeof META_DECKS] ?? META_DECKS.aggro;
    }

    const deckIds = dbDecks.map((d) => d.id);
    const cardRows = await db
      .select()
      .from(competitiveDeckCards)
      .where(inArray(competitiveDeckCards.deckId, deckIds));

    // Agrupar por deckId e formatar como decklist string
    const byDeck = new Map<number, string[]>();
    for (const row of cardRows) {
      if (!byDeck.has(row.deckId)) byDeck.set(row.deckId, []);
      byDeck.get(row.deckId)!.push(`${row.quantity} ${row.cardName}`);
    }

    const decklists = deckIds
      .map((id) => byDeck.get(id)?.join("\n") ?? "")
      .filter((d) => d.length > 0);

    return decklists.length > 0
      ? decklists
      : META_DECKS[archetype as keyof typeof META_DECKS] ?? META_DECKS.aggro;
  } catch {
    return META_DECKS[archetype as keyof typeof META_DECKS] ?? META_DECKS.aggro;
  }
}
