import crypto from "node:crypto";
import { getDb } from "../db";
import { semanticCache } from "../../drizzle/schema";
import { eq, sql } from "drizzle-orm";
import { CircuitBreaker } from "./circuitBreaker";
import { callHaiku, type HaikuCallParams, type HaikuResponse } from "./anthropicClient";

/**
 * Pillar 4 — RAG + Semantic Cache
 *
 * Pipeline de consulta:
 *
 *   prompt ─► L0 exact (hash) ─hit─► retorna (zero $)
 *             │
 *             miss
 *             ▼
 *           L1 semantic (pgvector HNSW ≥ 0.95) ─hit─► retorna (zero $)
 *             │
 *             miss
 *             ▼
 *           L2 circuit breaker gate ─deny─► throws
 *             │
 *             allow
 *             ▼
 *           L3 Anthropic API ─► persiste em L0/L1 para próxima
 *
 * Quem fornece o embedding:
 *   - Opção A (preferida): ml_engine expõe FastAPI local em :8765 com /embed
 *   - Opção B (fallback): fornecer embedding pré-computado no parâmetro
 *
 * Este módulo tenta A automaticamente. Se o ml_engine não estiver up, falha
 * fechado (bloqueia a chamada) porque a busca semântica é essencial para
 * não gastar dinheiro à toa.
 */

const SIMILARITY_THRESHOLD = Number(process.env.RAG_SIMILARITY_THRESHOLD ?? 0.95);
const ML_ENGINE_URL = process.env.ML_ENGINE_URL ?? "http://127.0.0.1:8765";
const EMBEDDING_DIM = 384;

export type CacheSource = "L0_EXACT" | "L1_SEMANTIC" | "L3_API";

export interface RagResult {
  source: CacheSource;
  text: string;
  costUsd: number;
  similarity?: number;
  model: string;
  cachedFrom?: number; // id of L0/L1 hit row
}

export interface RagOptions {
  /** Pre-computed embedding — skips the ml_engine HTTP call if provided. */
  embedding?: number[];
  /** Override Anthropic call params (maxTokens, temperature, etc). */
  haikuParams?: Partial<HaikuCallParams>;
  /** Hard skip the API call, return null from L3. Used for offline mode. */
  skipApi?: boolean;
  /** TTL in hours for new cache entries. Default = no expiry. */
  ttlHours?: number;
}

/**
 * Entrypoint principal. Faz a cascata L0 → L1 → breaker → L3.
 * Se precisar do valor bruto do response.json(), veja `response` no L3.
 */
export async function queryWithRAG(prompt: string, options: RagOptions = {}): Promise<RagResult> {
  const db = await getDb();
  if (!db) {
    throw new Error("[RAG] Banco indisponível — impossível consultar cache");
  }

  // ── L0: exact hash ────────────────────────────────────────────────────────
  const queryHash = hashPrompt(prompt);
  const [exact] = await db
    .select()
    .from(semanticCache)
    .where(eq(semanticCache.queryHash, queryHash))
    .limit(1);

  if (exact && !isExpired(exact.expiresAt)) {
    // Bump hit counter async (fire-and-forget)
    void db
      .update(semanticCache)
      .set({ hitCount: (exact.hitCount ?? 0) + 1, lastHitAt: new Date() })
      .where(eq(semanticCache.id, exact.id));
    return {
      source: "L0_EXACT",
      text: extractText(exact.responseJson),
      costUsd: 0,
      model: exact.modelUsed,
      cachedFrom: exact.id,
    };
  }

  // ── L1: semantic similarity ───────────────────────────────────────────────
  const embedding = options.embedding ?? (await embedViaMlEngine(prompt));
  const vecLit = toVectorLiteral(embedding);

  const semanticHit = await db.execute<{
    id: number;
    response_json: unknown;
    model_used: string;
    similarity: number;
    expires_at: Date | null;
  }>(sql`
    SELECT id, response_json, model_used,
           1 - (query_embedding <=> ${vecLit}::vector) AS similarity,
           expires_at
    FROM semantic_cache
    WHERE (expires_at IS NULL OR expires_at > NOW())
    ORDER BY query_embedding <=> ${vecLit}::vector
    LIMIT 1
  `);

  const best = asArray<{
    id: number;
    response_json: unknown;
    model_used: string;
    similarity: number;
    expires_at: Date | null;
  }>(semanticHit)[0];
  if (best && Number(best.similarity) >= SIMILARITY_THRESHOLD) {
    const id = Number(best.id);
    void db
      .update(semanticCache)
      .set({
        hitCount: sql`${semanticCache.hitCount} + 1`,
        lastHitAt: new Date(),
      })
      .where(eq(semanticCache.id, id));
    return {
      source: "L1_SEMANTIC",
      text: extractText(best.response_json),
      costUsd: 0,
      similarity: Number(best.similarity),
      model: String(best.model_used),
      cachedFrom: id,
    };
  }

  // ── L2/L3: gate + API call ────────────────────────────────────────────────
  if (options.skipApi) {
    throw new Error("[RAG] cache miss e skipApi=true — sem resposta disponível offline");
  }

  const gate = await CircuitBreaker.canCall();
  if (!gate.ok) {
    throw new Error(`[RAG] Circuit Breaker bloqueou chamada: ${gate.reason} — ${gate.detail ?? ""}`);
  }

  let haikuResponse: HaikuResponse;
  try {
    haikuResponse = await callHaiku({ prompt, ...options.haikuParams });
  } catch (err) {
    CircuitBreaker.recordFailure(err);
    throw err;
  }

  // Sucesso: registra no ledger + persiste no cache
  await CircuitBreaker.recordSuccess({
    inputTokens: haikuResponse.inputTokens,
    outputTokens: haikuResponse.outputTokens,
    costUsd: haikuResponse.costUsd,
  });

  await persistCacheEntry(db, {
    queryHash,
    vecLit,
    prompt,
    response: haikuResponse,
    ttlHours: options.ttlHours,
  });

  return {
    source: "L3_API",
    text: haikuResponse.text,
    costUsd: haikuResponse.costUsd,
    model: haikuResponse.model,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────────────────

export function hashPrompt(prompt: string): string {
  return crypto.createHash("sha256").update(prompt).digest("hex");
}

export function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`[RAG] embedding dim ${embedding.length} !== ${EMBEDDING_DIM}`);
  }
  return `[${embedding.join(",")}]`;
}

function isExpired(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

function extractText(responseJson: unknown): string {
  if (typeof responseJson === "string") return responseJson;
  if (responseJson && typeof responseJson === "object") {
    const r = responseJson as { text?: string };
    if (typeof r.text === "string") return r.text;
  }
  return JSON.stringify(responseJson);
}

function asArray<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray((result as any).rows)) {
    return (result as any).rows as T[];
  }
  return [];
}

async function embedViaMlEngine(prompt: string): Promise<number[]> {
  const url = `${ML_ENGINE_URL}/embed`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    });
  } catch (err) {
    throw new Error(
      `[RAG] ml_engine não acessível em ${url} — inicie o serviço com 'python -m ml_engine.rag.server'. ` +
        `Detalhe: ${err instanceof Error ? err.message : err}`
    );
  }

  if (!response.ok) {
    throw new Error(`[RAG] ml_engine /embed retornou ${response.status}`);
  }
  const data = (await response.json()) as { embedding?: number[] };
  if (!Array.isArray(data.embedding) || data.embedding.length !== EMBEDDING_DIM) {
    throw new Error(`[RAG] ml_engine /embed resposta inválida`);
  }
  return data.embedding;
}

async function persistCacheEntry(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  params: {
    queryHash: string;
    vecLit: string;
    prompt: string;
    response: HaikuResponse;
    ttlHours?: number;
  }
): Promise<void> {
  const preview = params.prompt.length > 400 ? params.prompt.slice(0, 400) + "…" : params.prompt;
  const expiresAt = params.ttlHours
    ? new Date(Date.now() + params.ttlHours * 60 * 60 * 1000).toISOString()
    : null;
  try {
    await db.execute(sql`
      INSERT INTO semantic_cache (
        query_hash, query_embedding, prompt_preview, response_json,
        model_used, input_tokens, output_tokens, cost_usd,
        hit_count, last_hit_at, expires_at
      )
      VALUES (
        ${params.queryHash},
        ${params.vecLit}::vector,
        ${preview},
        ${JSON.stringify({ text: params.response.text })}::jsonb,
        ${params.response.model},
        ${params.response.inputTokens},
        ${params.response.outputTokens},
        ${params.response.costUsd},
        0,
        NOW(),
        ${expiresAt}
      )
      ON CONFLICT (query_hash) DO UPDATE SET
        last_hit_at = NOW()
    `);
  } catch (err) {
    // Cache write failing doesn't break the request — we already have the response
    console.warn("[RAG] Falha ao persistir cache (resposta entregue normalmente):", err);
  }
}

/** Admin endpoint helper — retorna métricas do cache. */
export async function getCacheStats(): Promise<{
  totalEntries: number;
  totalHits: number;
  totalCostUsd: number;
  avgCostPerEntry: number;
  topModels: Array<{ model: string; count: number }>;
}> {
  const db = await getDb();
  if (!db) {
    return { totalEntries: 0, totalHits: 0, totalCostUsd: 0, avgCostPerEntry: 0, topModels: [] };
  }

  const stats = asArray<{
    total_entries: string;
    total_hits: string;
    total_cost: string;
  }>(
    await db.execute(sql`
      SELECT COUNT(*)::text AS total_entries,
             COALESCE(SUM(hit_count), 0)::text AS total_hits,
             COALESCE(SUM(cost_usd), 0)::text AS total_cost
      FROM semantic_cache
    `)
  )[0];

  const byModel = asArray<{ model_used: string; count: string }>(
    await db.execute(sql`
      SELECT model_used, COUNT(*)::text AS count
      FROM semantic_cache
      GROUP BY model_used
      ORDER BY COUNT(*) DESC
      LIMIT 5
    `)
  );

  const totalEntries = Number(stats?.total_entries ?? 0);
  const totalHits = Number(stats?.total_hits ?? 0);
  const totalCostUsd = Number(stats?.total_cost ?? 0);

  return {
    totalEntries,
    totalHits,
    totalCostUsd,
    avgCostPerEntry: totalEntries > 0 ? totalCostUsd / totalEntries : 0,
    topModels: byModel.map((m) => ({ model: m.model_used, count: Number(m.count) })),
  };
}
