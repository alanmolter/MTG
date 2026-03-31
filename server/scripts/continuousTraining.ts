/**
 * continuousTraining.ts — Self-Play com suporte a diversidade
 *
 * Novos args CLI:
 *   --pool-offset=2000         Offset no catálogo (ex: cartas 2000-4000)
 *   --pool-size=2000           Quantidade de cartas a carregar
 *   --mutation-rate=0.35       Taxa de mutação (padrão 0.15, alto=exploração)
 *   --exploration-mode=true    Inverte bias de peso (sub-exploradas primeiro)
 *   --source=self_play_explore Nome da fonte gravada no card_learning
 *   --inject-random-pct=0.20   % da população reinjetada aleatoriamente a cada 20it
 *   --iterations=100           Número de iterações
 *
 * NOTA: O banco usa os campos:
 *   - type   (string, ex: "Creature — Elf Warrior")
 *   - colors (string concatenada, ex: "WU", "R", "BG", "" para incolor)
 *   - cmc    (integer)
 * Não há colunas legalities, color_identity ou type_line no schema.
 */

import { parseArgs, getFloat, getInt, getBool, getString } from './utils/parseArgs';
import { getDb, closeDb } from '../db';
import { cardLearning, cards as cardsTable } from '../../drizzle/schema';
import { getCardLearningQueue } from '../services/cardLearningQueue';
import { ModelEvaluator } from '../services/modelEvaluation';
import { evaluateDeckQuick } from '../services/deckEvaluationBrain';
import { sql, asc, inArray } from 'drizzle-orm';
import {
  printForgeSelfPlayStatus,
  printForgeTrainingComplete,
} from '../services/forgeStatus';

// ── Parse de argumentos CLI ──────────────────────────────────────
const cliArgs          = parseArgs(process.argv.slice(2));
const POOL_OFFSET      = getInt(cliArgs, 'pool-offset', 0);
const POOL_SIZE        = getInt(cliArgs, 'pool-size', 2000);
const MUTATION_RATE    = getFloat(cliArgs, 'mutation-rate', 0.15);
const EXPLORATION_MODE = getBool(cliArgs, 'exploration-mode', false);
const SOURCE           = getString(cliArgs, 'source', 'self_play') as
  'commander_train' | 'forge_reality' | 'self_play' | 'rl_policy' | 'user_generation';
const INJECT_RANDOM    = getFloat(cliArgs, 'inject-random-pct', 0.0);
const ITERATIONS       = getInt(cliArgs, 'iterations', 100);

const ARCHETYPES       = ['aggro', 'control', 'midrange', 'combo', 'ramp'];
const DECKS_PER_ARCH   = 20;
const MATCHES_PER_DECK = 5;

// ── Tipo local alinhado com o schema real do banco ───────────────
type CardRow = {
  id: number;
  name: string;
  type: string | null;
  colors: string | null;
  cmc: number | null;
  text: string | null;
  rarity: string | null;
  [key: string]: unknown;
};

// ── Carregamento do pool com offset ─────────────────────────────
async function loadPool(): Promise<CardRow[]> {
  const db = await getDb();
  if (!db) throw new Error('[SelfPlay] Banco de dados indisponível');
  // Ordenar por id para garantir que o offset seja determinístico entre runs
  const pool = await db
    .select({
      id: cardsTable.id,
      name: cardsTable.name,
      type: cardsTable.type,
      colors: cardsTable.colors,
      cmc: cardsTable.cmc,
      text: cardsTable.text,
      rarity: cardsTable.rarity,
    })
    .from(cardsTable)
    .orderBy(asc(cardsTable.id))
    .offset(POOL_OFFSET)
    .limit(POOL_SIZE);

  console.log(`[Forge] Pool carregado : ${pool.length} cartas (offset=${POOL_OFFSET})`);
  return pool as CardRow[];
}

// ── Carregamento de pesos com inversão opcional ──────────────────
async function loadWeights(pool: CardRow[]): Promise<Map<string, number>> {
  const db = await getDb();
  if (!db) throw new Error('[SelfPlay] Banco de dados indisponível');
  const names = pool.map(c => c.name);

  const rows = await db
    .select()
    .from(cardLearning)
    .where(inArray(cardLearning.cardName, names));

  const weights = new Map<string, number>();

  for (const row of rows) {
    let w = (row.weight as number) ?? 1.0;

    if (EXPLORATION_MODE) {
      // Inversão do bias: favorece cartas com peso baixo
      // Cartas nunca vistas (peso~1) → exploração=25
      // Cartas saturadas (peso=50)   → exploração~1
      w = 50 / (w + 1);
    }

    weights.set(row.cardName, w);
  }

  // Cartas sem registro → peso neutro (ou alto em exploração)
  for (const card of pool) {
    if (!weights.has(card.name)) {
      weights.set(card.name, EXPLORATION_MODE ? 20.0 : 1.0);
    }
  }

  if (EXPLORATION_MODE) {
    const highExplore = Array.from(weights.values()).filter(w => w > 10).length;
    console.log(`[Brain] Modo exploração: ${highExplore} cartas com bias alto (peso invertido)`);
  }

  return weights;
}

// ── Geração de deck com pesos ────────────────────────────────────
function generateDeck(pool: CardRow[], weights: Map<string, number>, archetype: string, deckSize = 60): CardRow[] {
  const deck: CardRow[] = [];
  const used = new Set<string>();

  // Terrenos: ~24 cartas (40% do deck)
  const lands = pool.filter(c => c.type?.toLowerCase().includes('land'));
  const landCount = Math.round(deckSize * 0.40);
  for (let i = 0; i < landCount && lands.length > 0; i++) {
    const land = weightedSample(lands.filter(l => !used.has(l.name)), weights);
    if (land) { deck.push(land); used.add(land.name); }
  }

  // Não-terrenos: resto (até 4 cópias por carta)
  const nonLands = pool.filter(c => !c.type?.toLowerCase().includes('land'));
  while (deck.length < deckSize && nonLands.length > 0) {
    const available = nonLands.filter(c => !used.has(c.name));
    if (available.length === 0) break;
    const card = weightedSample(available, weights);
    if (card) {
      const copies = Math.min(4, deckSize - deck.length);
      for (let i = 0; i < copies && deck.length < deckSize; i++) {
        deck.push(card);
      }
      used.add(card.name);
    }
  }

  return deck;
}

function weightedSample<T extends { name: string }>(pool: T[], weights: Map<string, number>): T | null {
  if (pool.length === 0) return null;
  const total = pool.reduce((sum, c) => sum + (weights.get(c.name) ?? 1.0), 0);
  if (total <= 0) return pool[Math.floor(Math.random() * pool.length)];

  let rand = Math.random() * total;
  for (const card of pool) {
    rand -= weights.get(card.name) ?? 1.0;
    if (rand <= 0) return card;
  }
  return pool[pool.length - 1];
}

// ── Mutação com taxa configurável ────────────────────────────────
function mutateDeck(deck: CardRow[], pool: CardRow[], weights: Map<string, number>): CardRow[] {
  const nonLandPool = pool.filter(c => !c.type?.toLowerCase().includes('land'));
  return deck.map(card => {
    if (Math.random() < MUTATION_RATE && nonLandPool.length > 0) {
      const replacement = weightedSample(nonLandPool, weights);
      return replacement ?? card;
    }
    return card;
  });
}

// ── Crossover entre dois decks ───────────────────────────────────
function crossover(deckA: CardRow[], deckB: CardRow[]): CardRow[] {
  const midpoint = Math.floor(deckA.length / 2);
  return [...deckA.slice(0, midpoint), ...deckB.slice(midpoint)];
}

// ── Geração de deck completamente aleatório (anti-convergência) ──
function generateRandomDeck(pool: CardRow[], deckSize = 60): CardRow[] {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const deck: CardRow[] = [];
  const lands = shuffled.filter(c => c.type?.toLowerCase().includes('land')).slice(0, 24);
  const nonLands = shuffled.filter(c => !c.type?.toLowerCase().includes('land'));
  deck.push(...lands);
  for (const card of nonLands) {
    if (deck.length >= deckSize) break;
    deck.push(card);
  }
  return deck;
}

// ── Verificar convergência (plateau detector) ────────────────────
function detectPlateau(history: number[], window = 5, threshold = 0.5): boolean {
  if (history.length < window) return false;
  const recent = history.slice(-window);
  const delta = Math.abs(recent[recent.length - 1] - recent[0]);
  return delta < threshold;
}

// ── Loop principal ───────────────────────────────────────────────
async function main() {
  const startTotal = Date.now();
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  SELF-PLAY LOOP — FORGE ENGINE');
  console.log(`  Inicio: ${new Date().toLocaleTimeString()}`);
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Motor de regras : Forge (simulacao com variancia estocastica)`);
  console.log(`  Fonte gravada   : ${SOURCE}`);
  console.log(`  Pool offset     : ${POOL_OFFSET} (cartas ${POOL_OFFSET}–${POOL_OFFSET + POOL_SIZE})`);
  console.log(`  Mutation rate   : ${MUTATION_RATE}`);
  console.log(`  Exploração      : ${EXPLORATION_MODE}`);
  console.log(`  Injeção aleat.  : ${(INJECT_RANDOM * 100).toFixed(0)}% a cada 20 it`);
  console.log(`  Iterações       : ${ITERATIONS}`);
  console.log('────────────────────────────────────────────────────────');

  const pool    = await loadPool();
  const weights = await loadWeights(pool);
  const queue   = getCardLearningQueue();

  let totalWins    = 0;
  let totalMatches = 0;
  let totalRulesApplied = 0;
  let bestScore    = 0;
  const scoreHistory: number[] = [];

  // Gerar população inicial (5 arquétipos × 20 decks)
  let population = ARCHETYPES.flatMap(arch =>
    Array.from({ length: DECKS_PER_ARCH }, () => generateDeck(pool, weights, arch))
  );

  console.log(`  [Forge] Arquetipos     : ${ARCHETYPES.join(', ')}`);
  console.log(`  [Forge] Decks/iteracao : ${population.length} (${ARCHETYPES.length} arq × ${DECKS_PER_ARCH} decks)`);
  console.log('────────────────────────────────────────────────────────');

  for (let it = 1; it <= ITERATIONS; it++) {
    // ── Avaliar e ordenar por score ──────────────────────────────
    const scored = population
      .map(deck => ({ deck, score: evaluateDeckQuick(deck, 'modern') }))
      .sort((a, b) => b.score - a.score);

    const currentBest = scored[0]?.score ?? 0;
    if (currentBest > bestScore) bestScore = currentBest;
    scoreHistory.push(currentBest);

    // ── Detectar plateau e aumentar mutation rate dinamicamente ──
    let effectiveMutation = MUTATION_RATE;
    if (detectPlateau(scoreHistory)) {
      effectiveMutation = Math.min(0.50, MUTATION_RATE * 2);
      if (it % 10 === 0) {
        process.stdout.write(`\n  [Explore] Plateau detectado — mutation escalada para ${effectiveMutation.toFixed(2)}`);
      }
    }

    // ── Selecionar elite (top 25%) ───────────────────────────────
    const eliteSize = Math.max(1, Math.floor(scored.length * 0.25));
    const elite     = scored.slice(0, eliteSize).map(s => s.deck);

    // ── Simular partidas (Forge) ─────────────────────────────────
    for (const { deck } of scored.slice(0, eliteSize)) {
      for (let m = 0; m < MATCHES_PER_DECK; m++) {
        const opponentArch = ARCHETYPES[m % ARCHETYPES.length];
        const opponent     = generateDeck(pool, weights, opponentArch);
        const result       = ModelEvaluator.simulateMatch(deck, opponent);
        const won          = result.winner === 'A';

        if (won) totalWins++;
        totalMatches++;
        totalRulesApplied++;

        const delta = won ? 0.05 : -0.02;
        await queue.enqueueBatch(deck.map(c => ({
          cardName: c.name,
          delta,
          source: SOURCE,
          win: won,
        })));
      }
    }

    // ── Evoluir próxima geração ──────────────────────────────────
    const offspring: CardRow[][] = [];

    // Crossover entre pares da elite
    while (offspring.length < population.length * 0.5) {
      const a = elite[Math.floor(Math.random() * elite.length)];
      const b = elite[Math.floor(Math.random() * elite.length)];
      offspring.push(mutateDeck(crossover(a, b), pool, weights));
    }

    // Mutação simples da elite
    while (offspring.length < population.length * 0.8) {
      const parent = elite[Math.floor(Math.random() * elite.length)];
      offspring.push(mutateDeck(parent, pool, weights));
    }

    // Reinjeção de decks aleatórios a cada 20 iterações (anti-convergência)
    if (INJECT_RANDOM > 0 && it % 20 === 0) {
      const injectCount = Math.floor(population.length * INJECT_RANDOM);
      const injected    = Array.from({ length: injectCount }, () => generateRandomDeck(pool));
      offspring.push(...injected);
      process.stdout.write(`\n  [Explore] it:${it} — ${injectCount} decks aleatórios injetados`);
    }

    population = [...elite, ...offspring];

    // ── Log a cada 10 iterações ──────────────────────────────────
    if (it % 10 === 0 || it === ITERATIONS) {
      printForgeSelfPlayStatus(it, totalMatches, totalWins, totalRulesApplied);
    }
  }

  // ── Flush da queue ────────────────────────────────────────────
  await queue.flush();

  printForgeTrainingComplete(
    totalMatches,
    totalWins,
    totalRulesApplied,
    Date.now() - startTotal
  );

  console.log(`  Iteracoes completas : ${ITERATIONS}`);
  console.log(`  Decks gerados       : ${ITERATIONS * population.length}`);
  console.log(`  Melhor score visto  : ${bestScore.toFixed(4)}`);
  console.log(`  Pool offset usado   : ${POOL_OFFSET}`);
  console.log(`  Fonte gravada       : ${SOURCE}`);
  console.log('════════════════════════════════════════════════════════');

  await closeDb();
}

main().catch(console.error);
