import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db", () => ({
  getDb: vi.fn(),
}));
vi.mock("./circuitBreaker", () => ({
  CircuitBreaker: {
    canCall: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));
vi.mock("./anthropicClient", () => ({
  callHaiku: vi.fn(),
}));

import { queryWithRAG, hashPrompt, toVectorLiteral, getCacheStats } from "./ragCache";
import { getDb } from "../db";
import { CircuitBreaker } from "./circuitBreaker";
import { callHaiku } from "./anthropicClient";

const EMBEDDING_DIM = 384;
const makeEmbedding = (): number[] =>
  new Array(EMBEDDING_DIM).fill(0).map((_, i) => Math.sin(i) * 0.01);

/**
 * Constrói um mock do Drizzle db capaz de simular:
 *   - L0 exact via db.select().from().where().limit(1)
 *   - L1 semantic via db.execute(sql`SELECT ...`)
 *   - persist via db.execute(sql`INSERT ...`)
 *   - hit counter bump via db.update().set().where()
 */
function makeMockDb(options: {
  exactHit?: {
    id: number;
    responseJson: unknown;
    modelUsed: string;
    hitCount: number;
    expiresAt: Date | null;
  };
  semanticHit?: {
    id: number;
    response_json: unknown;
    model_used: string;
    similarity: number;
    expires_at: Date | null;
  };
  executeError?: Error;
} = {}) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(options.exactHit ? [options.exactHit] : []),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  const execute = vi.fn().mockImplementation(async () => {
    if (options.executeError) throw options.executeError;
    return options.semanticHit ? [options.semanticHit] : [];
  });
  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue(updateChain),
    execute,
  };
}

describe("ragCache", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: makeEmbedding() }),
      })
    );
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  describe("hashPrompt", () => {
    it("produz SHA256 hex determinístico", () => {
      const h1 = hashPrompt("hello world");
      const h2 = hashPrompt("hello world");
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
    });

    it("difere para entradas diferentes", () => {
      expect(hashPrompt("a")).not.toBe(hashPrompt("b"));
    });
  });

  describe("toVectorLiteral", () => {
    it("formata array de 384 dims como literal pgvector", () => {
      const vec = new Array(EMBEDDING_DIM).fill(0.5);
      const lit = toVectorLiteral(vec);
      expect(lit.startsWith("[0.5,")).toBe(true);
      expect(lit.endsWith("]")).toBe(true);
    });

    it("lança erro em dimensão errada", () => {
      expect(() => toVectorLiteral([0.1, 0.2])).toThrow(/dim 2 !== 384/);
    });
  });

  describe("queryWithRAG — L0 exact cache", () => {
    it("retorna L0_EXACT com custo zero em hit", async () => {
      (getDb as any).mockResolvedValue(
        makeMockDb({
          exactHit: {
            id: 1,
            responseJson: { text: "cached answer" },
            modelUsed: "claude-haiku-4-5",
            hitCount: 3,
            expiresAt: null,
          },
        })
      );
      const result = await queryWithRAG("test prompt");
      expect(result.source).toBe("L0_EXACT");
      expect(result.text).toBe("cached answer");
      expect(result.costUsd).toBe(0);
      expect(result.cachedFrom).toBe(1);
      expect(callHaiku).not.toHaveBeenCalled();
    });

    it("ignora L0 se a entrada está expirada e cai para L3", async () => {
      (getDb as any).mockResolvedValue(
        makeMockDb({
          exactHit: {
            id: 1,
            responseJson: { text: "stale" },
            modelUsed: "m",
            hitCount: 0,
            expiresAt: new Date(Date.now() - 1000),
          },
        })
      );
      (CircuitBreaker.canCall as any).mockResolvedValue({ ok: true });
      (callHaiku as any).mockResolvedValue({
        text: "fresh",
        inputTokens: 10,
        outputTokens: 20,
        model: "claude-haiku-4-5",
        costUsd: 0.001,
      });
      const result = await queryWithRAG("p");
      expect(result.source).toBe("L3_API");
      expect(result.text).toBe("fresh");
    });
  });

  describe("queryWithRAG — L1 semantic cache", () => {
    it("retorna L1_SEMANTIC quando similarity ≥ 0.95", async () => {
      (getDb as any).mockResolvedValue(
        makeMockDb({
          semanticHit: {
            id: 7,
            response_json: { text: "semantic match" },
            model_used: "claude-haiku-4-5",
            similarity: 0.97,
            expires_at: null,
          },
        })
      );
      const result = await queryWithRAG("similar prompt");
      expect(result.source).toBe("L1_SEMANTIC");
      expect(result.text).toBe("semantic match");
      expect(result.costUsd).toBe(0);
      expect(result.similarity).toBeGreaterThanOrEqual(0.95);
      expect(callHaiku).not.toHaveBeenCalled();
    });

    it("cai para L3 quando similarity < threshold", async () => {
      (getDb as any).mockResolvedValue(
        makeMockDb({
          semanticHit: {
            id: 7,
            response_json: { text: "far match" },
            model_used: "x",
            similarity: 0.5,
            expires_at: null,
          },
        })
      );
      (CircuitBreaker.canCall as any).mockResolvedValue({ ok: true });
      (callHaiku as any).mockResolvedValue({
        text: "new",
        inputTokens: 1,
        outputTokens: 1,
        model: "m",
        costUsd: 0.0001,
      });
      const result = await queryWithRAG("p");
      expect(result.source).toBe("L3_API");
    });
  });

  describe("queryWithRAG — L3 API fallthrough", () => {
    it("lança erro quando DB está indisponível", async () => {
      (getDb as any).mockResolvedValue(null);
      await expect(queryWithRAG("p")).rejects.toThrow(/Banco indisponível/);
    });

    it("lança erro quando skipApi=true em cache miss", async () => {
      (getDb as any).mockResolvedValue(makeMockDb());
      await expect(queryWithRAG("p", { skipApi: true })).rejects.toThrow(/skipApi=true/);
      expect(callHaiku).not.toHaveBeenCalled();
    });

    it("lança erro quando Circuit Breaker bloqueia", async () => {
      (getDb as any).mockResolvedValue(makeMockDb());
      (CircuitBreaker.canCall as any).mockResolvedValue({
        ok: false,
        reason: "BUDGET_EXCEEDED",
        detail: "$2.01/$2",
      });
      await expect(queryWithRAG("p")).rejects.toThrow(/BUDGET_EXCEEDED/);
      expect(callHaiku).not.toHaveBeenCalled();
    });

    it("chama API quando breaker permite e registra sucesso", async () => {
      (getDb as any).mockResolvedValue(makeMockDb());
      (CircuitBreaker.canCall as any).mockResolvedValue({ ok: true });
      (callHaiku as any).mockResolvedValue({
        text: "live answer",
        inputTokens: 100,
        outputTokens: 50,
        model: "claude-haiku-4-5",
        costUsd: 0.00028,
      });
      const result = await queryWithRAG("p");
      expect(result.source).toBe("L3_API");
      expect(result.text).toBe("live answer");
      expect(CircuitBreaker.recordSuccess).toHaveBeenCalledWith({
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.00028,
      });
    });

    it("registra falha e re-lança quando API erra", async () => {
      (getDb as any).mockResolvedValue(makeMockDb());
      (CircuitBreaker.canCall as any).mockResolvedValue({ ok: true });
      (callHaiku as any).mockRejectedValue(new Error("503 overloaded"));
      await expect(queryWithRAG("p")).rejects.toThrow(/503 overloaded/);
      expect(CircuitBreaker.recordFailure).toHaveBeenCalled();
      expect(CircuitBreaker.recordSuccess).not.toHaveBeenCalled();
    });

    it("usa embedding pré-computado, pulando chamada ao ml_engine", async () => {
      (getDb as any).mockResolvedValue(makeMockDb());
      (CircuitBreaker.canCall as any).mockResolvedValue({ ok: true });
      (callHaiku as any).mockResolvedValue({
        text: "a",
        inputTokens: 1,
        outputTokens: 1,
        model: "m",
        costUsd: 0.0001,
      });
      await queryWithRAG("p", { embedding: makeEmbedding() });
      expect(global.fetch as any).not.toHaveBeenCalled();
    });

    it("persiste resposta mesmo se o INSERT falha (não interrompe o request)", async () => {
      // Primeiro execute = L1 semantic miss (array vazio).
      // Segundo execute = persist, que vai falhar.
      let executeCallCount = 0;
      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue(undefined),
        }),
        execute: vi.fn().mockImplementation(async () => {
          executeCallCount++;
          if (executeCallCount === 1) return []; // L1 miss
          throw new Error("insert conflict"); // persist falha
        }),
      };
      (getDb as any).mockResolvedValue(mockDb);
      (CircuitBreaker.canCall as any).mockResolvedValue({ ok: true });
      (callHaiku as any).mockResolvedValue({
        text: "survived",
        inputTokens: 1,
        outputTokens: 1,
        model: "m",
        costUsd: 0.0001,
      });
      const result = await queryWithRAG("p");
      expect(result.text).toBe("survived");
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("getCacheStats", () => {
    it("retorna zeros quando DB está indisponível", async () => {
      (getDb as any).mockResolvedValue(null);
      const stats = await getCacheStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.topModels).toEqual([]);
    });

    it("agrega totais e top modelos", async () => {
      const mockDb = {
        execute: vi
          .fn()
          .mockResolvedValueOnce([
            { total_entries: "10", total_hits: "25", total_cost: "0.05" },
          ])
          .mockResolvedValueOnce([
            { model_used: "claude-haiku-4-5", count: "7" },
            { model_used: "claude-sonnet-4-6", count: "3" },
          ]),
      };
      (getDb as any).mockResolvedValue(mockDb);
      const stats = await getCacheStats();
      expect(stats.totalEntries).toBe(10);
      expect(stats.totalHits).toBe(25);
      expect(stats.totalCostUsd).toBeCloseTo(0.05);
      expect(stats.avgCostPerEntry).toBeCloseTo(0.005);
      expect(stats.topModels).toHaveLength(2);
      expect(stats.topModels[0]).toEqual({ model: "claude-haiku-4-5", count: 7 });
    });
  });
});
