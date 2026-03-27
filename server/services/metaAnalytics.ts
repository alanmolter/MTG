import { extractCardFeatures, CardFeatures } from "./gameFeatureEngine";
import { searchCards } from "./scryfall";

/**
 * Meta Analytics Service
 * 
 * Este serviço analisa decks reais (ex: Moxfield) para extrair padrões de "Gold Standard".
 * Permite que o Cérebro de Avaliação use benchmarks reais em vez de teóricos.
 */

export interface MetaBenchmark {
  archetype: string;
  avgCurve: Record<number, number>;
  avgRoles: Record<string, number>;
  avgTags: Record<string, number>;
  sampleSize: number;
  lastUpdated: string;
  topCards: { name: string, count: number }[];
}

export class MetaAnalytics {
  private benchmarks: Record<string, MetaBenchmark> = {};

  /**
   * Converte uma string de decklist (Moxfield/Arena) em um objeto de deck processável
   */
  public static async parseDecklist(decklist: string): Promise<any[]> {
    const lines = decklist.split("\n");
    const deck: any[] = [];
    const { getCardByName } = await import("./scryfall");

    for (const line of lines) {
      const match = line.trim().match(/^(\d+)x?\s+(.+)$/);
      if (match) {
        const qty = parseInt(match[1]);
        const name = match[2].trim();
        
        // Buscar info da carta no banco local
        const cardData = await getCardByName(name);
        if (cardData) {
          deck.push({
            ...cardData,
            name: cardData.name,
            quantity: qty
          });
        }
      }
    }
    return deck;
  }

  /**
   * Analisa um deck individual (formato: lista de cartas com quantidade)
   */
  public static analyzeDeck(cards: any[]): {
    curve: Record<number, number>;
    roles: Record<string, number>;
    tags: Record<string, number>;
  } {
    const curve: Record<number, number> = {};
    const roles: Record<string, number> = {};
    const tags: Record<string, number> = {};

    for (const card of cards) {
      const features = extractCardFeatures(card);
      const qty = card.quantity || 1;

      // Curve (apenas não-terrenos)
      if (!features.isLand) {
        const cmc = Math.min(features.cmc, 7);
        curve[cmc] = (curve[cmc] || 0) + qty;
      }

      // Roles
      for (const role of features.roles) {
        roles[role] = (roles[role] || 0) + qty;
      }

      // Tags
      for (const tag of features.mechanicTags) {
        tags[tag] = (tags[tag] || 0) + qty;
      }
    }

    return { curve, roles, tags };
  }

  /**
   * Processa uma coleção de decks para gerar um benchmark agregado
   */
  public generateBenchmark(archetype: string, decks: any[][]): MetaBenchmark {
    const totalCurve: Record<number, number> = {};
    const totalRoles: Record<string, number> = {};
    const totalTags: Record<string, number> = {};
    const n = decks.length;

    for (const deck of decks) {
      const analysis = MetaAnalytics.analyzeDeck(deck);
      
      // Agregar Curve
      for (const [cmcStr, count] of Object.entries(analysis.curve)) {
        const cmc = parseInt(cmcStr);
        totalCurve[cmc] = (totalCurve[cmc] || 0) + count;
      }

      // Agregar Roles
      for (const [role, count] of Object.entries(analysis.roles)) {
        totalRoles[role] = (totalRoles[role] || 0) + count;
      }

      // Agregar Tags
      for (const [tag, count] of Object.entries(analysis.tags)) {
        totalTags[tag] = (totalTags[tag] || 0) + count;
      }
    }

    // Calcular Médias
    const avgCurve: Record<number, number> = {};
    for (const [cmcStr, total] of Object.entries(totalCurve)) {
      const cmc = parseInt(cmcStr);
      avgCurve[cmc] = total / n;
    }

    const avgRoles: Record<string, number> = {};
    for (const [role, total] of Object.entries(totalRoles)) {
      avgRoles[role] = total / n;
    }

    const avgTags: Record<string, number> = {};
    for (const [tag, total] of Object.entries(totalTags)) {
      avgTags[tag] = total / n;
    }

    const benchmark: MetaBenchmark = {
      archetype,
      avgCurve,
      avgRoles,
      avgTags,
      sampleSize: n,
      lastUpdated: new Date().toISOString(),
      topCards: [] // TODO: extrair cartas mais frequentes
    };

    this.benchmarks[archetype] = benchmark;
    return benchmark;
  }

  public getBenchmark(archetype: string): MetaBenchmark | null {
    return this.benchmarks[archetype] || null;
  }
}

export const metaAnalyzer = new MetaAnalytics();
