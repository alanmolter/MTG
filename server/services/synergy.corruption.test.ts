import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCardSynergy,
  getSynergyNeighbors,
  updateSynergy,
  calculateDeckSynergy,
  getSynergyStatus,
  resetSynergyCircuit,
} from "./synergy";
import { getDb } from "../db";

vi.mock("../db", () => ({
  getDb: vi.fn(),
}));

/**
 * Simula o erro do PostgreSQL postgres-js quando há página corrompida.
 * Cobertura:
 *   - XX001 "invalid page in block N of relation ..."
 *   - XX002 "could not read block N in file ..."
 */
function makeCorruptionError(block = 45): Error {
  const err: any = new Error(
    `invalid page in block ${block} of relation "base/106921/107036"`
  );
  err.code = "XX001";
  err.severity = "ERROR";
  err.routine = "buffer_readv_report";
  return err;
}

function makeThrowingDb(error: Error) {
  // Cada método fluente retorna `this`; `limit()` é o terminator que rejeita.
  const db: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockRejectedValue(error),
    or: vi.fn(),
    and: vi.fn(),
    eq: vi.fn(),
    limit: vi.fn().mockRejectedValue(error),
  };
  return db;
}

describe("Synergy — corruption resilience", () => {
  // Silencia stderr para não poluir a saída do vitest.
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSynergyCircuit(); // zera circuit breaker entre testes
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    resetSynergyCircuit();
  });

  describe("Error throttling", () => {
    it("logs first 5 corruption errors verbosely, then suppresses", async () => {
      const err = makeCorruptionError(45);
      (getDb as any).mockResolvedValue(makeThrowingDb(err));

      // Dispara 10 erros
      for (let i = 0; i < 10; i++) {
        await getCardSynergy(1, i + 2);
      }

      // Conta chamadas de console.error com mensagem de erro real
      const verboseLogs = errSpy.mock.calls.filter((call) =>
        String(call[0] ?? "").includes("[synergy:getCardSynergy]")
      );

      // Esperamos no máximo 5 logs verbosos + 1 aviso de suppression
      expect(verboseLogs.length).toBeLessThanOrEqual(5);
    });

    it("includes a 'suppressing' notice exactly once at threshold", async () => {
      const err = makeCorruptionError();
      (getDb as any).mockResolvedValue(makeThrowingDb(err));

      for (let i = 0; i < 10; i++) {
        await getCardSynergy(1, i + 2);
      }

      const suppressionMsgs = errSpy.mock.calls.filter((call) =>
        String(call[0] ?? "").includes("Suprimindo logs futuros")
      );
      expect(suppressionMsgs.length).toBe(1);
    });
  });

  describe("Circuit breaker", () => {
    it("does not trip before 25 errors", async () => {
      const err = makeCorruptionError();
      (getDb as any).mockResolvedValue(makeThrowingDb(err));

      for (let i = 0; i < 24; i++) {
        await getCardSynergy(1, i + 2);
      }

      const status = getSynergyStatus();
      expect(status.circuitTripped).toBe(false);
      expect(status.errorCount).toBe(24);
    });

    it("trips after 25 consecutive errors", async () => {
      const err = makeCorruptionError();
      (getDb as any).mockResolvedValue(makeThrowingDb(err));

      for (let i = 0; i < 25; i++) {
        await getCardSynergy(1, i + 2);
      }

      const status = getSynergyStatus();
      expect(status.circuitTripped).toBe(true);
      expect(status.errorCount).toBe(25);
      expect(status.corruptionDetected).toBe(true);
    });

    it("returns no-op results once circuit is open (no DB hits)", async () => {
      const err = makeCorruptionError();
      const db = makeThrowingDb(err);
      (getDb as any).mockResolvedValue(db);

      // Trip circuit
      for (let i = 0; i < 25; i++) {
        await getCardSynergy(1, i + 2);
      }

      vi.clearAllMocks(); // zera contadores mas mantém estado do módulo
      (getDb as any).mockResolvedValue(db);

      // Chamadas subsequentes devem retornar no-op imediatamente
      const syn = await getCardSynergy(100, 200);
      const neigh = await getSynergyNeighbors(100);
      const upd = await updateSynergy(100, 200, 50, 60);
      const deck = await calculateDeckSynergy([1, 2, 3, 4]);

      expect(syn).toBe(0);
      expect(neigh).toEqual([]);
      expect(upd).toBeNull();
      expect(deck).toBe(0);

      // getDb NÃO deve ter sido chamado para as chamadas pós-trip
      expect(getDb).not.toHaveBeenCalled();
    });

    it("resetSynergyCircuit restores normal operation", async () => {
      const err = makeCorruptionError();
      (getDb as any).mockResolvedValue(makeThrowingDb(err));

      // Trip
      for (let i = 0; i < 25; i++) {
        await getCardSynergy(1, i + 2);
      }
      expect(getSynergyStatus().circuitTripped).toBe(true);

      // Reset
      resetSynergyCircuit();
      expect(getSynergyStatus()).toEqual({
        circuitTripped: false,
        errorCount: 0,
        corruptionDetected: false,
      });

      // Agora queries voltam a tentar o DB (e falhar, incrementando de novo)
      await getCardSynergy(1, 2);
      expect(getSynergyStatus().errorCount).toBe(1);
    });
  });

  describe("Corruption detection", () => {
    it("flags XX001 errors as corruption", async () => {
      const err = makeCorruptionError(45);
      (getDb as any).mockResolvedValue(makeThrowingDb(err));

      await getCardSynergy(1, 2);

      expect(getSynergyStatus().corruptionDetected).toBe(true);
    });

    it("flags errors with 'invalid page in block' text even without code", async () => {
      const err = new Error("invalid page in block 12 of relation foo");
      (getDb as any).mockResolvedValue(makeThrowingDb(err));

      await getCardSynergy(1, 2);

      expect(getSynergyStatus().corruptionDetected).toBe(true);
    });

    it("flags 'could not read block' errors as corruption", async () => {
      const err: any = new Error("could not read block 77 in file base/1/2");
      err.code = "XX002";
      (getDb as any).mockResolvedValue(makeThrowingDb(err));

      await getCardSynergy(1, 2);

      expect(getSynergyStatus().corruptionDetected).toBe(true);
    });

    it("does NOT flag generic errors as corruption", async () => {
      const err = new Error("connection reset by peer");
      (getDb as any).mockResolvedValue(makeThrowingDb(err));

      await getCardSynergy(1, 2);

      const status = getSynergyStatus();
      expect(status.errorCount).toBe(1);
      expect(status.corruptionDetected).toBe(false);
    });
  });

  describe("Training loop scenario", () => {
    it("does not cascade: training loop of 10k pair checks completes", async () => {
      const err = makeCorruptionError();
      (getDb as any).mockResolvedValue(makeThrowingDb(err));

      const start = Date.now();
      let completed = 0;

      // Simula 10k lookups de pair synergy durante o treino.
      // Sem circuit breaker, isto geraria 10k stack traces e timeout.
      for (let i = 0; i < 10_000; i++) {
        const result = await getCardSynergy(i % 100, (i + 1) % 100);
        expect(result).toBe(0); // degradação graciosa
        completed++;
      }

      const elapsed = Date.now() - start;
      expect(completed).toBe(10_000);

      // Após trip, chamadas viram no-op: o loop deve ser rápido (< 2s).
      expect(elapsed).toBeLessThan(2000);

      // Apenas 25 erros foram de fato processados; os outros 9975 viraram no-op.
      expect(getSynergyStatus().errorCount).toBe(25);
      expect(getSynergyStatus().circuitTripped).toBe(true);
    });
  });
});
