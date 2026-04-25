/**
 * trainCommander.ts — Commander Intelligence com suporte a diversidade
 *
 * Novos args CLI:
 *   --forbidden-color=W|U|B|R|G   Exclui identidades que contenham essa cor
 *   --exploration-mode=true        Inverte bias de peso (favorece cartas sub-exploradas)
 *   --source=commander_diversity   Nome da fonte gravada no card_learning
 *   --mutation-rate=0.25           Taxa de mutação para o loop genético
 *   --iterations=300               Número de iterações
 *
 * NOTA: O banco usa os campos:
 *   - type   (string, ex: "Legendary Creature — Elf Warrior")
 *   - colors (string concatenada, ex: "WU", "R", "BG")
 *   - cmc    (integer)
 * Não há colunas legalities, color_identity ou type_line no schema.
 */

import { parseArgs, getFloat, getInt, getBool, getString } from './utils/parseArgs';
import { describeTrainingPool, isArenaOnlyTraining } from './utils/poolFilter';
import { getDb, closeDb } from '../db';
import { cardLearning, cards as cardsTable } from '../../drizzle/schema';
import { getCardLearningQueue } from '../services/cardLearningQueue';
import { ModelEvaluator } from '../services/modelEvaluation';
import { evaluateDeckQuick } from '../services/deckEvaluationBrain';
import { sql, inArray, asc } from 'drizzle-orm';
import {
  printForgeSelfPlayStatus,
  printForgeTrainingComplete,
} from '../services/forgeStatus';

// ── Parse de argumentos CLI ──────────────────────────────────────
const cliArgs        = parseArgs(process.argv.slice(2));
const FORBIDDEN_COLOR: string | null = getString(cliArgs, 'forbidden-color', '') || null;
const EXPLORATION_MODE: boolean      = getBool(cliArgs, 'exploration-mode', false);
const SOURCE                         = getString(cliArgs, 'source', 'commander_train') as
  'commander_train' | 'forge_reality' | 'self_play' | 'rl_policy' | 'user_generation';
const MUTATION_RATE: number          = getFloat(cliArgs, 'mutation-rate', 0.15);
const ITERATIONS: number             = getInt(cliArgs, 'iterations', 300);
const MATCHES_PER_IT: number         = 5;

// ── Tipo local alinhado com o schema real do banco ───────────────
// O banco usa: id, name, type (string), colors (string), cmc (int)
type CardRow = {
  id: number;
  name: string;
  type: string | null;
  colors: string | null;  // ex: "WU", "R", "BG", "" (incolor)
  cmc: number | null;
  text: string | null;
  rarity: string | null;
  [key: string]: unknown;
};

// ── Helpers de identidade de cor ─────────────────────────────────
// No banco, colors é uma string concatenada (ex: "WU", "R", "BG")
// Para Commander, usamos colors como proxy de color_identity

function isAllowedColor(colors: string): boolean {
  if (!FORBIDDEN_COLOR) return true;
  return !colors.includes(FORBIDDEN_COLOR);
}

function isSubsetColors(cardColors: string, commanderColors: string): boolean {
  if (!cardColors || cardColors === '') return true; // incolor é sempre legal
  for (const color of cardColors) {
    if (!commanderColors.includes(color)) return false;
  }
  return true;
}

// ── Carregamento do pool Commander ──────────────────────────────
// Como não há coluna legalities, carregamos cartas com cmc <= 6
// e filtramos por tipo para simular o pool Commander
async function loadCommanderPool(): Promise<CardRow[]> {
  const db = await getDb();
  if (!db) throw new Error('[Commander] Banco de dados indisponível');

  // Filtramos por cmc <= 8 para incluir cartas Commander típicas
  // e excluímos a cor proibida se especificada.
  //
  // Arena-only mode (TRAINING_POOL_ARENA_ONLY=1): adicionamos AND is_arena = 1
  // ao WHERE para restringir o espaço de busca ao catálogo do MTG Arena
  // (~3k Standard, ~12k Pioneer/Historic). O resto do filtro permanece
  // idêntico — é um corte adicional, não um caminho alternativo.
  const arenaOnly = isArenaOnlyTraining();
  const arenaFilter = arenaOnly ? sql` AND is_arena = 1` : sql``;
  let pool: CardRow[];

  if (FORBIDDEN_COLOR) {
    // Excluir cartas que contenham a cor proibida
    pool = await db.execute(sql`
      SELECT id, name, type, colors, cmc, text, rarity
      FROM cards
      WHERE (colors IS NULL OR colors NOT LIKE ${'%' + FORBIDDEN_COLOR + '%'})
        AND (cmc IS NULL OR cmc <= 8)
        ${arenaFilter}
      ORDER BY RANDOM()
      LIMIT 2000
    `) as unknown as CardRow[];
  } else {
    pool = await db.execute(sql`
      SELECT id, name, type, colors, cmc, text, rarity
      FROM cards
      WHERE (cmc IS NULL OR cmc <= 8)
        ${arenaFilter}
      ORDER BY RANDOM()
      LIMIT 2000
    `) as unknown as CardRow[];
  }

  if (FORBIDDEN_COLOR) {
    console.log(`[Commander] Pool carregado: ${pool.length} cartas (sem cor ${FORBIDDEN_COLOR})`);
  } else {
    console.log(`[Commander] Pool carregado: ${pool.length} cartas`);
  }

  return pool;
}

// ── Carregamento de pesos com inversão opcional ──────────────────
async function loadWeights(pool: CardRow[]): Promise<Map<string, number>> {
  const db = await getDb();
  if (!db) throw new Error('[Commander] Banco de dados indisponível');
  const names = pool.map(c => c.name);

  const rows = await db
    .select()
    .from(cardLearning)
    .where(inArray(cardLearning.cardName, names));

  const weights = new Map<string, number>();

  for (const row of rows) {
    let weight = (row.weight as number) ?? 1.0;

    if (EXPLORATION_MODE) {
      // Inversão: cartas com peso baixo ganham bias alto (modo exploração)
      // peso=1   → exploração=25   (muito sub-explorada)
      // peso=10  → exploração=4.5  (moderadamente explorada)
      // peso=50  → exploração=0.98 (já saturada, ignorar)
      weight = 50 / (weight + 1);
    }

    weights.set(row.cardName, weight);
  }

  // Cartas sem histórico recebem peso neutro (ou alto em exploração)
  for (const card of pool) {
    if (!weights.has(card.name)) {
      weights.set(card.name, EXPLORATION_MODE ? 15.0 : 1.0);
    }
  }

  if (EXPLORATION_MODE) {
    const highExplore = Array.from(weights.values()).filter(w => w > 10).length;
    console.log(`[Commander] Modo exploração: ${highExplore} cartas com bias alto (peso invertido)`);
  }

  return weights;
}

// ── Geração de deck Commander com bias de peso ───────────────────
function generateCommanderDeck(pool: CardRow[], weights: Map<string, number>): CardRow[] {
  // Selecionar comandante (lendário, cor permitida)
  const legendaries = pool.filter(c =>
    c.type?.toLowerCase().includes('legendary') &&
    c.type?.toLowerCase().includes('creature') &&
    isAllowedColor(c.colors ?? '')
  );

  if (legendaries.length === 0) return [];

  const commander = weightedSample(legendaries, weights);
  if (!commander) return [];

  const commanderColors = commander.colors ?? '';

  // Filtrar pool pela identidade de cor do comandante (subset de cores)
  const legalPool = pool.filter(c =>
    c.name !== commander.name &&
    isSubsetColors(c.colors ?? '', commanderColors)
  );

  // Selecionar 99 cartas restantes com bias de peso (singleton)
  const deck = [commander];
  const selected = new Set<string>([commander.name]);

  while (deck.length < 100 && legalPool.length > 0) {
    const available = legalPool.filter(c => !selected.has(c.name));
    if (available.length === 0) break;

    const card = weightedSample(available, weights);
    if (!card) break;
    deck.push(card);
    selected.add(card.name);
  }

  return deck;
}

function weightedSample<T extends { name: string }>(pool: T[], weights: Map<string, number>): T | null {
  if (pool.length === 0) return null;
  const totalWeight = pool.reduce((sum, c) => sum + (weights.get(c.name) ?? 1.0), 0);
  if (totalWeight <= 0) return pool[Math.floor(Math.random() * pool.length)];

  let rand = Math.random() * totalWeight;
  for (const card of pool) {
    rand -= weights.get(card.name) ?? 1.0;
    if (rand <= 0) return card;
  }
  return pool[pool.length - 1];
}

// ── Mutação com taxa configurável ────────────────────────────────
function mutateDeck(deck: CardRow[], pool: CardRow[], weights: Map<string, number>): CardRow[] {
  if (deck.length === 0) return deck;
  const commander = deck[0];
  const commanderColors = commander.colors ?? '';
  const legalPool = pool.filter(c =>
    c.name !== commander.name &&
    isSubsetColors(c.colors ?? '', commanderColors) &&
    !deck.some(d => d.name === c.name)
  );

  return deck.map((card, idx) => {
    if (idx === 0) return card; // comandante não muta
    if (Math.random() < MUTATION_RATE && legalPool.length > 0) {
      const replacement = weightedSample(legalPool, weights);
      return replacement ?? card;
    }
    return card;
  });
}

// ── Loop principal ───────────────────────────────────────────────
async function main() {
  const startTotal = Date.now();
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  COMMANDER INTELLIGENCE — FORGE ENGINE');
  console.log(`  Inicio: ${new Date().toLocaleTimeString()}`);
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Motor de regras : Forge (Commander EDH — regras completas)`);
  console.log(`  Formato         : Commander (100 cartas, singleton, identidade de cor)`);
  console.log(`  Fonte gravada   : ${SOURCE}`);
  console.log(`  Cor excluída    : ${FORBIDDEN_COLOR ?? 'nenhuma'}`);
  console.log(`  Pool de cartas  : ${describeTrainingPool()}`);
  console.log(`  Modo exploração : ${EXPLORATION_MODE}`);
  console.log(`  Taxa de mutação : ${MUTATION_RATE}`);
  console.log(`  Iterações       : ${ITERATIONS}`);
  console.log('────────────────────────────────────────────────────────');

  // ── Anomaly-2 fix (2026-04-23): Global weight decay ─────────────
  // Anteriormente apenas `continuousTraining.ts` aplicava decay global.
  // Sem decay aqui, as cartas escolhidas nas primeiras iterações (ordem
  // alfabética do `ORDER BY RANDOM()` não garante isso, mas o viés
  // de self-reinforcement sim) viravam "vencedoras permanentes" porque
  // `weightedSample` sempre as re-escolhia mesmo quando perdiam. Isso
  // foi o vetor direto do caso "top 10 comandantes começando com A"
  // (todos com weight > 40 e winrate < 10%).
  //
  // Decay 3% por run + applyDecay quadrático da CardLearningQueue juntos
  // garantem que cartas que param de aparecer (ou que aparecem e perdem)
  // regridem naturalmente para 1.0 em algumas dezenas de runs.
  {
    const db = await getDb();
    if (db) {
      const MIN_WEIGHT = 0.1;
      await db.update(cardLearning).set({
        weight: sql`GREATEST(${MIN_WEIGHT}, weight * 0.97)`,
        updatedAt: new Date(),
      });
      console.log('  [Decay] Pesos decaídos 3% (fator 0.97) — anti-saturação ativa');
    }
  }

  const pool    = await loadCommanderPool();
  const weights = await loadWeights(pool);
  const queue   = getCardLearningQueue();

  const archetypes = ['aggro', 'control', 'midrange', 'combo', 'ramp'];

  let totalWins    = 0;
  let totalMatches = 0;
  let totalRulesApplied = 0;

  let lastHeartbeat = Date.now();

  // Gerar população inicial (5 decks, um por arquétipo)
  let population = archetypes
    .map(() => generateCommanderDeck(pool, weights))
    .filter(d => d.length === 100);

  if (population.length === 0) {
    console.log('[Commander] AVISO: Nenhum deck Commander gerado. Verifique o pool de cartas.');
    await closeDb();
    return;
  }

  console.log(`  [Forge] Decks iniciais : ${population.length} decks Commander gerados`);
  console.log('────────────────────────────────────────────────────────');

  for (let it = 1; it <= ITERATIONS; it++) {
    if (Date.now() - lastHeartbeat >= 15_000) {
      const stats = queue.getStats();
      const processing = stats.isProcessing ? '*' : '';
      console.log(
        `\n[Heartbeat] Commander it:${it}/${ITERATIONS} | partidas:${totalMatches} | wins:${totalWins} | fila:${stats.queueLength}${processing} | ${new Date().toLocaleTimeString()}`
      );
      lastHeartbeat = Date.now();
    }

    // Avaliar população
    const scored = population.map(deck => ({
      deck,
      score: evaluateDeckQuick(deck, 'commander')
    })).sort((a, b) => b.score - a.score);

    // Selecionar elite (top 25%)
    const eliteSize = Math.max(1, Math.floor(scored.length * 0.25));
    const elite     = scored.slice(0, eliteSize).map(s => s.deck);

    // Simular partidas (Forge)
    for (const deck of elite) {
      for (let m = 0; m < MATCHES_PER_IT; m++) {
        // Oponente Commander (mesmo formato)
        const opponent = generateCommanderDeck(pool, weights);
        if (opponent.length < 100) continue;

        const result = ModelEvaluator.simulateMatch(deck, opponent);
        const won    = result.winner === 'A';
        if (won) totalWins++;
        totalMatches++;
        totalRulesApplied++;

        // Atualizar pesos via queue
        const delta = won ? 0.05 : -0.02;
        await queue.enqueueBatch(deck.map(c => ({
          cardName: c.name,
          delta,
          source: SOURCE,
          win: won,
        })));
      }
    }

    // Evoluir — crossover + mutação
    const offspring: CardRow[][] = [];
    while (offspring.length < population.length - elite.length) {
      const parent = elite[Math.floor(Math.random() * elite.length)];
      offspring.push(mutateDeck(parent, pool, weights));
    }
    population = [...elite, ...offspring].filter(d => d.length === 100);

    // Log a cada 50 iterações
    if (it % 50 === 0 || it === ITERATIONS) {
      printForgeSelfPlayStatus(it, totalMatches, totalWins, totalRulesApplied);
    }
  }

  // Flush da queue
  await queue.flush();

  printForgeTrainingComplete(
    totalMatches,
    totalWins,
    totalRulesApplied,
    Date.now() - startTotal
  );

  console.log(`  Cor excluída  : ${FORBIDDEN_COLOR ?? 'nenhuma'}`);
  console.log(`  Fonte gravada : ${SOURCE}`);
  console.log('════════════════════════════════════════════════════════');

  await closeDb();
}

main().catch(console.error);
