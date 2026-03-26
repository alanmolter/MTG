import { Card } from "../../drizzle/schema";
import { getCardById, getCardsByIds } from "./scryfall";
import { findSimilarCardsForDeck } from "./embeddings";
import { getCardSynergy } from "./synergy";
import { evaluateDeck, optimizeDeckRL, extractCardFeatures, type DeckMetrics } from "./gameFeatureEngine";

interface DeckGeneratorOptions {
  format: "standard" | "modern" | "commander" | "legacy";
  archetype?: string;
  targetSize?: number;
}

interface DeckValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validações de regras MTG
 */
export function validateDeck(
  cards: (Card & { quantity: number })[],
  format: string
): DeckValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Contar total de cartas
  const totalCards = cards.reduce((sum, card) => sum + card.quantity, 0);

  // Validações por formato
  if (format === "commander") {
    if (totalCards !== 100) {
      errors.push(`Commander deck deve ter exatamente 100 cartas, tem ${totalCards}`);
    }

    // Verificar se há um comandante (deve ser a primeira carta)
    if (cards.length === 0 || !cards[0].type?.includes("Creature")) {
      warnings.push("Recomenda-se um comandante no deck");
    }

    // Máximo 1 cópia de cada carta (exceto básicas)
    for (const card of cards) {
      if (card.quantity > 1 && !card.type?.includes("Basic")) {
        errors.push(`${card.name}: máximo 1 cópia em Commander (tem ${card.quantity})`);
      }
    }
  } else {
    // Standard, Modern, Legacy
    if (totalCards < 60) {
      errors.push(`Deck deve ter no mínimo 60 cartas, tem ${totalCards}`);
    }

    // Máximo 4 cópias de cada carta (exceto básicas)
    for (const card of cards) {
      if (card.quantity > 4 && !card.type?.includes("Basic")) {
        errors.push(`${card.name}: máximo 4 cópias, tem ${card.quantity}`);
      }
    }
  }

  // Validação de cores (aviso se muito desbalanceado)
  const colorCounts: Record<string, number> = {};
  for (const card of cards) {
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
      warnings.push("Distribuição de cores desbalanceada");
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Gera um deck inicial baseado em arquétipos
 */
export async function generateInitialDeck(
  options: DeckGeneratorOptions,
  seedCards: number[] = []
): Promise<(Card & { quantity: number })[]> {
  const targetSize = options.format === "commander" ? 100 : 60;
  const maxCopies = options.format === "commander" ? 1 : 4;
  const deck: Map<number, number> = new Map();

  // Adicionar cartas iniciais (seed)
  for (const cardId of seedCards) {
    const quantity = Math.min(deck.get(cardId) || 0, maxCopies) + 1;
    deck.set(cardId, quantity);
  }

  // Se não temos seed, gerar cartas aleatórias
  if (seedCards.length === 0) {
    // Simular seleção aleatória (em produção, usar dados de meta real)
    for (let i = 1; i <= Math.min(20, targetSize / 3); i++) {
      const quantity = Math.min(Math.floor(Math.random() * maxCopies) + 1, maxCopies);
      deck.set(i, quantity);
    }
  }

  // Buscar cartas similares para preencher o deck
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

    // Evitar loop infinito
    if (similar.length === 0) break;
  }

  // Converter para formato esperado
  const cardIds = Array.from(deck.keys());
  const cards = await getCardsByIds(cardIds);

  return cards.map((card) => ({
    ...card,
    quantity: deck.get(card.id) || 1,
  }));
}

/**
 * Otimiza um deck removendo cartas fracas e adicionando cartas fortes
 */
export async function optimizeDeck(
  currentDeck: (Card & { quantity: number })[],
  options: DeckGeneratorOptions,
  iterations: number = 5
): Promise<(Card & { quantity: number })[]> {
  let deck = [...currentDeck];
  const targetSize = options.format === "commander" ? 100 : 60;

  for (let i = 0; i < iterations; i++) {
    // Encontrar cartas fracas (com baixa sinergia)
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

    // Tentar substituir pela melhor carta similar
    if (worstCard) {
      const similar = await findSimilarCardsForDeck(
        deckCardIds.filter((id) => id !== worstCard!.id),
        5
      );

      if (similar.length > 0) {
        const bestCard = similar[0];
        deck = deck.filter((c) => c.id !== worstCard!.id);
        deck.push({ ...bestCard, quantity: worstCard.quantity });
      }
    }
  }

  // Validar deck final
  const validation = validateDeck(deck, options.format);
  if (!validation.isValid) {
    console.warn("Optimized deck validation warnings:", validation.errors);
  }

  return deck;
}

/**
 * Avalia um deck usando a Game Feature Engine (curva + terrenos + sinergia + simulação).
 */
export function evaluateDeckWithEngine(
  deck: (Card & { quantity: number })[],
  archetype: string = "default"
): DeckMetrics {
  // Expandir deck com quantidades para avaliação
  const expanded: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[] = [];
  for (const card of deck) {
    for (let i = 0; i < card.quantity; i++) {
      expanded.push({ name: card.name, type: card.type, text: card.text, cmc: card.cmc });
    }
  }
  return evaluateDeck(expanded, archetype);
}

/**
 * Treina um deck usando RL melhorado com Game Feature Engine.
 * Substitui o RL antigo baseado apenas em simulação de partidas.
 */
export async function trainDeckWithRL(
  initialDeck: (Card & { quantity: number })[],
  options: DeckGeneratorOptions,
  cardPool?: Card[],
  iterations: number = 200
): Promise<{ deck: (Card & { quantity: number })[]; metrics: DeckMetrics; improvements: number }> {
  // Usar pool fornecido ou gerar um básico
  const pool: Card[] = cardPool || [];

  const expanded: { name: string; type?: string | null; text?: string | null; cmc?: number | null; quantity?: number }[] = [];
  for (const card of initialDeck) {
    expanded.push({ name: card.name, type: card.type, text: card.text, cmc: card.cmc, quantity: card.quantity });
  }

  const { deck: optimizedExpanded, initialScore, finalScore, improvements } = optimizeDeckRL(
    expanded,
    pool,
    options.archetype || "default",
    iterations
  );

  // Reconstruir deck com objetos Card completos
  const cardMap = new Map(initialDeck.map((c) => [c.name, c]));
  const poolMap = new Map((cardPool || []).map((c) => [c.name, c]));

  const resultDeck: (Card & { quantity: number })[] = [];
  for (const entry of optimizedExpanded) {
    const card = cardMap.get(entry.name) || poolMap.get(entry.name);
    if (card) {
      resultDeck.push({ ...card, quantity: entry.quantity ?? 1 });
    }
  }

  const metrics = evaluateDeckWithEngine(resultDeck, options.archetype || "default");

  console.log(`[RL] Score: ${initialScore.toFixed(1)} → ${finalScore.toFixed(1)} (${improvements} melhorias)`);

  return { deck: resultDeck, metrics, improvements };
}
