import { Card } from "../../drizzle/schema";
import { getCardById, getCardsByIds } from "./scryfall";
import { findSimilarCardsForDeck } from "./embeddings";
import { getCardSynergy } from "./synergy";
import { evaluateDeck as evaluateDeckBase, optimizeDeckRL, extractCardFeatures, type DeckMetrics } from "./gameFeatureEngine";
import { evaluateDeckWithBrain as evaluateDeckBrain, evaluateDeckQuick, type EvaluationResult } from "./deckEvaluationBrain";
import { modelLearningService } from "./modelLearning";

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

  // Buscar pesos de aprendizado (Se existirem)
  const learningWeights = await modelLearningService.getCardWeights();

  // Buscar cartas similares para preencher o deck (Com Pesos de Aprendizado)
  const deckCardIds = Array.from(deck.keys());
  let currentSize = Array.from(deck.values()).reduce((a, b) => a + b, 0);

  while (currentSize < targetSize && deckCardIds.length < 100) {
    const similar = await findSimilarCardsForDeck(deckCardIds, 40);

    for (const card of similar) {
      if (currentSize >= targetSize) break;
      
      const weight = learningWeights[card.name] || 1.0;
      const chance = Math.random() * (weight * 2.0); // Aumenta a chance de cartas com peso maior

      if (!deck.has(card.id) && chance > 0.5) {
        const quantity = Math.min(Math.floor(Math.random() * maxCopies) + 1, maxCopies);
        deck.set(card.id, quantity);
        deckCardIds.push(card.id);
        currentSize += quantity;
      }
    }
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
  return evaluateDeckBase(expanded, archetype);
}

/**
 * Avalia um deck usando o novo Deck Evaluation Brain (cérebro do sistema).
 * Fornece análise completa com score normalizado, tier e recomendações.
 */
export async function evaluateDeckWithBrain(
  deck: (Card & { quantity: number })[],
  archetype: string = "default"
): Promise<EvaluationResult> {
  // Expandir deck com quantidades para avaliação
  const expanded: any[] = [];
  for (const card of deck) {
    for (let i = 0; i < card.quantity; i++) {
      expanded.push({ ...card });
    }
  }
  return await evaluateDeckBrain(expanded, archetype);
}

/**
 * Avaliação rápida para loops de otimização.
 * Retorna apenas o score normalizado (0-100).
 */
export function evaluateDeckQuickScore(
  deck: (Card & { quantity: number })[],
  archetype: string = "default"
): number {
  // Expandir deck com quantidades para avaliação
  const expanded: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[] = [];
  for (const card of deck) {
    for (let i = 0; i < card.quantity; i++) {
      expanded.push({ name: card.name, type: card.type, text: card.text, cmc: card.cmc });
    }
  }
  return evaluateDeckQuick(expanded, archetype);
}

/**
 * Treina um deck usando RL melhorado com Game Feature Engine.
 * Usa a nova função evaluate_deck do Deck Evaluation Brain para melhor qualidade.
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
    iterations,
    (cards, arch) => ({ totalScore: evaluateDeckQuick(cards, arch) })
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

  // CORREÇÃO (Problema 3): Retroalimenta card_learning com o resultado da otimização RL.
  // O bridge converte o score em reward e enfileira os deltas via CardLearningQueue,
  // eliminando o isolamento do RL em relação ao ciclo de aprendizado tabular.
  try {
    const { getRLToCardLearningBridge } = await import("./rlToCardLearningBridge");
    const bridge = getRLToCardLearningBridge();
    await bridge.feedbackFromDeckOptimization(resultDeck, finalScore);
  } catch (bridgeErr) {
    // Não-crítico: falha no bridge não deve interromper a geração do deck
    console.warn("[RL] Bridge feedback failed (non-critical):", bridgeErr);
  }

  return { deck: resultDeck, metrics, improvements };
}
