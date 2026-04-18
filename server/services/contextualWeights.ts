import { getDb } from "../db";
import { cardContextualWeight, cards } from "../../drizzle/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

/**
 * Pillar 8 — Contextual Weights Service
 *
 * Abandona o peso escalar global `card_learning.weight` em favor de um
 * vetor 32-dim sensível a (card, commander?, archetype).
 *
 * Use cases:
 *   - MCTS deckbuilder (Pillar 5): getTopCandidatesForContext(ctx, topK)
 *   - UI card-recommender: getContextualWeight(cardId, commanderId, arch)
 *   - Backfill from training: upsertContextualWeight(...)
 *
 * A dimensão 32 é arbitrária mas escolhida para equilibrar:
 *   - Expressividade suficiente para capturar interações archetype×commander
 *   - Footprint leve: 30k cards × 100 contexts × 128 bytes ≈ 384MB
 *   - Fits em RAM do Postgres com sobra
 */

export const CTX_WEIGHT_DIM = 32;

export type Archetype = "aggro" | "control" | "midrange" | "combo" | "ramp" | "unknown";

export interface WeightContext {
  commanderId?: number | null;
  archetype: Archetype;
}

export interface ContextualWeightRow {
  cardId: number;
  commanderId: number | null;
  archetype: Archetype;
  weightVec: number[];
  scalarSynergy: number;
  winCount: number;
  lossCount: number;
  matchCount: number;
}

export interface UpsertWeightParams {
  cardId: number;
  context: WeightContext;
  weightVec: number[];
  scalarSynergy: number;
  winDelta?: number;
  lossDelta?: number;
}

/** Retorna o peso contextual de uma carta, ou null se ainda não aprendeu. */
export async function getContextualWeight(
  cardId: number,
  context: WeightContext
): Promise<ContextualWeightRow | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(cardContextualWeight)
    .where(
      and(
        eq(cardContextualWeight.cardId, cardId),
        context.commanderId != null
          ? eq(cardContextualWeight.commanderId, context.commanderId)
          : isNull(cardContextualWeight.commanderId),
        eq(cardContextualWeight.archetype, context.archetype)
      )
    )
    .limit(1);

  if (!rows[0]) return null;
  return normalizeRow(rows[0]);
}

/**
 * Top-K cartas no contexto ordenadas por `scalar_synergy`.
 * Usado pelo MCTS como prior distribution antes de expandir.
 */
export async function getTopCandidatesForContext(
  context: WeightContext,
  topK = 40
): Promise<ContextualWeightRow[]> {
  const db = await getDb();
  if (!db) return [];

  const query = db
    .select()
    .from(cardContextualWeight)
    .where(
      and(
        context.commanderId != null
          ? eq(cardContextualWeight.commanderId, context.commanderId)
          : isNull(cardContextualWeight.commanderId),
        eq(cardContextualWeight.archetype, context.archetype)
      )
    )
    .orderBy(desc(cardContextualWeight.scalarSynergy))
    .limit(topK);

  const rows = await query;
  return rows.map(normalizeRow);
}

/**
 * Busca cartas cuja direção semântica (weight_vec) está próxima do centroid
 * de um deck parcial. Usado pelo MCTS para amostrar candidatos coerentes.
 *
 * `centroid` deve ser o weight_vec médio das cartas já no deck.
 */
export async function getNearestByCentroid(
  centroid: number[],
  context: WeightContext,
  topK = 20
): Promise<ContextualWeightRow[]> {
  if (centroid.length !== CTX_WEIGHT_DIM) {
    throw new Error(`[ContextualWeights] centroid dim ${centroid.length} !== ${CTX_WEIGHT_DIM}`);
  }
  const db = await getDb();
  if (!db) return [];

  const vecLit = `[${centroid.join(",")}]`;
  const commanderFilter =
    context.commanderId != null
      ? sql`commander_id = ${context.commanderId}`
      : sql`commander_id IS NULL`;

  const result = await db.execute(sql`
    SELECT
      card_id, commander_id, archetype,
      weight_vec, scalar_synergy, win_count, loss_count, match_count,
      1 - (weight_vec <=> ${vecLit}::vector) AS similarity
    FROM card_contextual_weight
    WHERE ${commanderFilter}
      AND archetype = ${context.archetype}
    ORDER BY weight_vec <=> ${vecLit}::vector
    LIMIT ${topK}
  `);

  const rows = asArray<any>(result);
  return rows.map((r) => ({
    cardId: r.card_id,
    commanderId: r.commander_id,
    archetype: r.archetype,
    weightVec: parseVector(r.weight_vec),
    scalarSynergy: Number(r.scalar_synergy),
    winCount: r.win_count,
    lossCount: r.loss_count,
    matchCount: r.match_count,
  }));
}

/**
 * UPSERT: cria ou atualiza uma linha de peso contextual.
 * Usado pelo pipeline de treinamento (Python → Node via bridge, ou direto
 * em TypeScript vindo do regressionTest).
 */
export async function upsertContextualWeight(params: UpsertWeightParams): Promise<void> {
  if (params.weightVec.length !== CTX_WEIGHT_DIM) {
    throw new Error(`[ContextualWeights] weightVec dim ${params.weightVec.length} !== ${CTX_WEIGHT_DIM}`);
  }
  const db = await getDb();
  if (!db) return;

  const vecLit = `[${params.weightVec.join(",")}]`;
  const winDelta = params.winDelta ?? 0;
  const lossDelta = params.lossDelta ?? 0;

  // Idioma do Postgres: UNIQUE com NULL permite múltiplas linhas NULL, então
  // usamos dois paths — com e sem commanderId — para satisfazer o uniq constraint.
  if (params.context.commanderId != null) {
    await db.execute(sql`
      INSERT INTO card_contextual_weight (
        card_id, commander_id, archetype,
        weight_vec, scalar_synergy,
        win_count, loss_count, match_count
      )
      VALUES (
        ${params.cardId},
        ${params.context.commanderId},
        ${params.context.archetype},
        ${vecLit}::vector,
        ${params.scalarSynergy},
        ${winDelta}, ${lossDelta}, ${winDelta + lossDelta}
      )
      ON CONFLICT (card_id, commander_id, archetype) DO UPDATE SET
        weight_vec    = ${vecLit}::vector,
        scalar_synergy= ${params.scalarSynergy},
        win_count     = card_contextual_weight.win_count + ${winDelta},
        loss_count    = card_contextual_weight.loss_count + ${lossDelta},
        match_count   = card_contextual_weight.match_count + ${winDelta + lossDelta},
        updated_at    = NOW()
    `);
  } else {
    await db.execute(sql`
      INSERT INTO card_contextual_weight (
        card_id, commander_id, archetype,
        weight_vec, scalar_synergy,
        win_count, loss_count, match_count
      )
      VALUES (
        ${params.cardId},
        NULL,
        ${params.context.archetype},
        ${vecLit}::vector,
        ${params.scalarSynergy},
        ${winDelta}, ${lossDelta}, ${winDelta + lossDelta}
      )
      ON CONFLICT (card_id, archetype)
        WHERE commander_id IS NULL
      DO UPDATE SET
        weight_vec    = ${vecLit}::vector,
        scalar_synergy= ${params.scalarSynergy},
        win_count     = card_contextual_weight.win_count + ${winDelta},
        loss_count    = card_contextual_weight.loss_count + ${lossDelta},
        match_count   = card_contextual_weight.match_count + ${winDelta + lossDelta},
        updated_at    = NOW()
    `);
  }
}

/**
 * Calcula centroid de um deck parcial a partir de seus weight_vecs.
 * Retorna vetor zero se o deck estiver vazio ou sem pesos aprendidos.
 */
export function computeCentroid(rows: ContextualWeightRow[]): number[] {
  if (rows.length === 0) return new Array(CTX_WEIGHT_DIM).fill(0);
  const sum = new Array(CTX_WEIGHT_DIM).fill(0);
  for (const row of rows) {
    for (let i = 0; i < CTX_WEIGHT_DIM; i++) sum[i] += row.weightVec[i] ?? 0;
  }
  return sum.map((v) => v / rows.length);
}

// ────────────────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────────────────

function asArray<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray((result as any).rows)) {
    return (result as any).rows as T[];
  }
  return [];
}

function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeRow(row: typeof cardContextualWeight.$inferSelect): ContextualWeightRow {
  return {
    cardId: row.cardId,
    commanderId: row.commanderId,
    archetype: (row.archetype as Archetype),
    weightVec: parseVector(row.weightVec),
    scalarSynergy: row.scalarSynergy,
    winCount: row.winCount,
    lossCount: row.lossCount,
    matchCount: row.matchCount,
  };
}
