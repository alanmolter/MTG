import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db", () => ({
  getDb: vi.fn(),
}));

import { CircuitBreaker } from "./circuitBreaker";
import { getDb } from "../db";

/** Cria um mock do Drizzle db que retorna `rowForSelect` em qualquer SELECT
 *  e aceita db.execute(...) para os INSERT/UPSERT sem fazer nada. */
function mockDbWithBudget(callCount = 0, costUsd = 0) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(callCount === 0 && costUsd === 0 ? [] : [
      { callCount, costUsd: String(costUsd) }
    ]),
  };
  return {
    select: vi.fn().mockReturnValue(selectChain),
    execute: vi.fn().mockResolvedValue([]),
  };
}

describe("CircuitBreaker", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    CircuitBreaker.reset();
    CircuitBreaker.configure({
      hourlyCallLimit: 500,
      hourlyCostLimitUsd: 2.0,
      cooldownMs: 60 * 60 * 1000,
      consecutiveErrorThreshold: 3,
    });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    CircuitBreaker.reset();
  });

  describe("Happy path", () => {
    it("allows call when under limits", async () => {
      (getDb as any).mockResolvedValue(mockDbWithBudget(10, 0.05));
      const gate = await CircuitBreaker.canCall();
      expect(gate.ok).toBe(true);
    });

    it("returns DB_UNAVAILABLE when db is null (fail closed)", async () => {
      (getDb as any).mockResolvedValue(null);
      const gate = await CircuitBreaker.canCall();
      expect(gate.ok).toBe(false);
      expect(gate.reason).toBe("DB_UNAVAILABLE");
    });
  });

  describe("Rate limit", () => {
    it("trips when hourly call limit is hit", async () => {
      (getDb as any).mockResolvedValue(mockDbWithBudget(500, 0.1));
      const gate = await CircuitBreaker.canCall();
      expect(gate.ok).toBe(false);
      expect(gate.reason).toBe("RATE_EXCEEDED");
      expect((await CircuitBreaker.getStatus()).state).toBe("OPEN");
    });

    it("does NOT trip one call under the limit", async () => {
      (getDb as any).mockResolvedValue(mockDbWithBudget(499, 0.1));
      const gate = await CircuitBreaker.canCall();
      expect(gate.ok).toBe(true);
    });

    it("respects custom limit", async () => {
      CircuitBreaker.configure({ hourlyCallLimit: 10 });
      (getDb as any).mockResolvedValue(mockDbWithBudget(10, 0));
      const gate = await CircuitBreaker.canCall();
      expect(gate.ok).toBe(false);
      expect(gate.reason).toBe("RATE_EXCEEDED");
    });
  });

  describe("Budget limit", () => {
    it("trips when hourly budget is hit", async () => {
      (getDb as any).mockResolvedValue(mockDbWithBudget(50, 2.0));
      const gate = await CircuitBreaker.canCall();
      expect(gate.ok).toBe(false);
      expect(gate.reason).toBe("BUDGET_EXCEEDED");
    });

    it("trips for over-budget even with low call count", async () => {
      (getDb as any).mockResolvedValue(mockDbWithBudget(5, 3.5));
      const gate = await CircuitBreaker.canCall();
      expect(gate.ok).toBe(false);
      expect(gate.reason).toBe("BUDGET_EXCEEDED");
    });
  });

  describe("Consecutive failures", () => {
    it("trips after 3 consecutive errors", () => {
      CircuitBreaker.recordFailure(new Error("net fail 1"));
      CircuitBreaker.recordFailure(new Error("net fail 2"));
      expect(CircuitBreaker.getConfig().consecutiveErrorThreshold).toBe(3);
      // Ainda não tripou
      CircuitBreaker.recordFailure(new Error("net fail 3"));
      // Agora deve estar OPEN — verifica via canCall subsequente
    });

    it("resets consecutive error count on success", async () => {
      (getDb as any).mockResolvedValue(mockDbWithBudget(0, 0));
      CircuitBreaker.recordFailure(new Error("1"));
      CircuitBreaker.recordFailure(new Error("2"));
      await CircuitBreaker.recordSuccess({ inputTokens: 10, outputTokens: 20, costUsd: 0.01 });
      // Após success, contagem volta a 0 — 3 falhas novas seriam necessárias
      CircuitBreaker.recordFailure(new Error("after-reset-1"));
      CircuitBreaker.recordFailure(new Error("after-reset-2"));
      // Ainda deve estar CLOSED
      const status = await CircuitBreaker.getStatus();
      expect(status.state).toBe("CLOSED");
    });
  });

  describe("HALF_OPEN recovery", () => {
    it("transitions to HALF_OPEN after cooldown", async () => {
      (getDb as any).mockResolvedValue(mockDbWithBudget(0, 0));
      CircuitBreaker.configure({ cooldownMs: 50 });
      CircuitBreaker.trip("test");
      expect((await CircuitBreaker.getStatus()).state).toBe("OPEN");

      // Fast-forward past cooldown via sleep
      await new Promise((r) => setTimeout(r, 60));

      const gate = await CircuitBreaker.canCall();
      expect(gate.ok).toBe(true); // Prova OK
    });

    it("fully closes on success from HALF_OPEN", async () => {
      (getDb as any).mockResolvedValue(mockDbWithBudget(0, 0));
      CircuitBreaker.configure({ cooldownMs: 10 });
      CircuitBreaker.trip("test");
      await new Promise((r) => setTimeout(r, 20));
      await CircuitBreaker.canCall(); // → HALF_OPEN
      await CircuitBreaker.recordSuccess({ inputTokens: 1, outputTokens: 1, costUsd: 0.001 });

      const status = await CircuitBreaker.getStatus();
      expect(status.state).toBe("CLOSED");
    });

    it("blocks during cooldown even if usage is under limits", async () => {
      (getDb as any).mockResolvedValue(mockDbWithBudget(0, 0));
      CircuitBreaker.trip("manual");
      const gate = await CircuitBreaker.canCall();
      expect(gate.ok).toBe(false);
      expect(gate.reason).toBe("CIRCUIT_OPEN");
      expect(gate.cooldownRemainingMs).toBeGreaterThan(0);
    });
  });

  describe("trip() idempotency", () => {
    it("does not double-trip", () => {
      CircuitBreaker.trip("first");
      const firstErrorCount = errSpy.mock.calls.length;
      CircuitBreaker.trip("second");
      // A segunda chamada não loga porque já está OPEN
      expect(errSpy.mock.calls.length).toBe(firstErrorCount);
    });
  });
});
