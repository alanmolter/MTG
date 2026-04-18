import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db module BEFORE importing autoHealDb (que faz `import { getRawClient } from "../db"`)
vi.mock("../db", () => ({
  getRawClient: vi.fn(),
  closeDb: vi.fn().mockResolvedValue(undefined),
}));

import { healTable } from "./autoHealDb";

/**
 * Mock do cliente postgres-js. Cada chamada a `unsafe(sql)` retorna:
 *  - resolved (se a query passa)
 *  - rejected com erro de corrupção (se "SELECT" em tabela marcada como corrompida)
 *
 * Controlamos o estado via `state` (conjunto de tabelas corrompidas) +
 * `repairSequence` (quais comandos "consertam" quais tabelas).
 */
function makeMockSql(opts: {
  corruptedTables: Set<string>;
  repairOnReindex?: Set<string>;   // após REINDEX X, X fica saudável
  repairOnVacuum?: Set<string>;
  repairOnRebuild?: Set<string>;   // sempre card_synergies se habilitado
  fatalCommands?: Set<string>;     // comandos que lançam erro (ex: "VACUUM FULL foo")
}) {
  const {
    corruptedTables,
    repairOnReindex = new Set(),
    repairOnVacuum = new Set(),
    repairOnRebuild = new Set(),
    fatalCommands = new Set(),
  } = opts;

  const log: string[] = [];

  function makeCorruptionError(table: string) {
    const err: any = new Error(
      `invalid page in block 45 of relation "base/1/${table}"`
    );
    err.code = "XX001";
    return err;
  }

  const unsafe = vi.fn(async (query: string) => {
    log.push(query);

    // Matchers simples para os comandos emitidos pelo autoHealDb
    const selectMatch = query.match(/^SELECT 1 FROM (\w+)/);
    const reindexMatch = query.match(/^REINDEX TABLE (\w+)/);
    const vacuumMatch = query.match(/^VACUUM FULL (\w+)/);
    const dropMatch = query.match(/^DROP TABLE IF EXISTS (\w+)/);
    const createMatch = query.match(/^\s*CREATE TABLE (\w+)/);

    // Fatal override (ex: VACUUM falha em disco físico)
    for (const fatal of fatalCommands) {
      if (query.includes(fatal)) {
        throw new Error(`simulated fatal failure: ${fatal}`);
      }
    }

    if (selectMatch) {
      const t = selectMatch[1];
      if (corruptedTables.has(t)) throw makeCorruptionError(t);
      return [];
    }

    if (reindexMatch) {
      const t = reindexMatch[1];
      if (repairOnReindex.has(t)) corruptedTables.delete(t);
      return [];
    }

    if (vacuumMatch) {
      const t = vacuumMatch[1];
      if (repairOnVacuum.has(t)) corruptedTables.delete(t);
      return [];
    }

    if (dropMatch) {
      // DROP sempre funciona e remove a tabela dos corrompidos
      corruptedTables.delete(dropMatch[1]);
      return [];
    }

    if (createMatch) {
      // CREATE também "recria" limpa
      corruptedTables.delete(createMatch[1]);
      return [];
    }

    // Demais comandos (CREATE INDEX, etc.) passam
    return [];
  });

  return { sql: { unsafe }, log };
}

describe("autoHealDb — healTable escalation ladder", () => {
  // Silencia console.log/console.error do SUT
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("retorna 'reindex' quando REINDEX resolve", async () => {
    const { sql, log } = makeMockSql({
      corruptedTables: new Set(["card_synergies"]),
      repairOnReindex: new Set(["card_synergies"]),
    });

    const result = await healTable(sql, "card_synergies");

    expect(result).toBe("reindex");
    // Nunca chegou a tentar VACUUM
    expect(log.some((q) => q.startsWith("VACUUM FULL"))).toBe(false);
  });

  it("escala para VACUUM FULL quando REINDEX não resolve", async () => {
    const { sql, log } = makeMockSql({
      corruptedTables: new Set(["card_synergies"]),
      repairOnReindex: new Set(),  // REINDEX "roda" mas não conserta
      repairOnVacuum: new Set(["card_synergies"]),
    });

    const result = await healTable(sql, "card_synergies");

    expect(result).toBe("vacuum");
    expect(log.some((q) => q.startsWith("REINDEX TABLE card_synergies"))).toBe(true);
    expect(log.some((q) => q.startsWith("VACUUM FULL card_synergies"))).toBe(true);
    // Não chegou no REBUILD
    expect(log.some((q) => q.startsWith("DROP TABLE"))).toBe(false);
  });

  it("escala para REBUILD quando REINDEX e VACUUM falham (card_synergies)", async () => {
    const { sql, log } = makeMockSql({
      corruptedTables: new Set(["card_synergies"]),
      fatalCommands: new Set(["VACUUM FULL card_synergies"]),
    });

    const result = await healTable(sql, "card_synergies");

    expect(result).toBe("rebuild");
    expect(log.some((q) => q.includes("DROP TABLE IF EXISTS card_synergies"))).toBe(true);
    expect(log.some((q) => q.match(/CREATE TABLE card_synergies/))).toBe(true);
    expect(log.some((q) => q.includes("CREATE INDEX idx_card_synergies"))).toBe(true);
  });

  it("NÃO tenta REBUILD em tabelas com dados insubstituíveis (card_learning)", async () => {
    const { sql, log } = makeMockSql({
      corruptedTables: new Set(["card_learning"]),
      fatalCommands: new Set(["VACUUM FULL card_learning"]),
    });

    const result = await healTable(sql, "card_learning");

    expect(result).toBeNull();
    expect(log.some((q) => q.startsWith("DROP TABLE"))).toBe(false);
  });

  it("respeita --no-rebuild (allowRebuild=false)", async () => {
    const { sql, log } = makeMockSql({
      corruptedTables: new Set(["card_synergies"]),
      fatalCommands: new Set(["VACUUM FULL card_synergies"]),
    });

    const result = await healTable(sql, "card_synergies", { allowRebuild: false });

    expect(result).toBeNull();
    expect(log.some((q) => q.startsWith("DROP TABLE"))).toBe(false);
  });

  it("retorna null quando REBUILD também falha", async () => {
    const { sql } = makeMockSql({
      corruptedTables: new Set(["card_synergies"]),
      fatalCommands: new Set([
        "VACUUM FULL card_synergies",
        "DROP TABLE IF EXISTS card_synergies",
      ]),
    });

    const result = await healTable(sql, "card_synergies");

    expect(result).toBeNull();
  });

  it("confirma cura via re-scan pós-REINDEX (não confia em erro ausente do REINDEX)", async () => {
    // Cenário: REINDEX "passa" (sem erro) mas o block continua corrompido.
    // A ladder deve detectar isso via scan e escalar para VACUUM.
    const { sql, log } = makeMockSql({
      corruptedTables: new Set(["card_synergies"]),
      repairOnReindex: new Set(),           // REINDEX OK mas não conserta
      repairOnVacuum: new Set(["card_synergies"]),
    });

    const result = await healTable(sql, "card_synergies");

    expect(result).toBe("vacuum");

    // Deve ter feito scan APÓS reindex (SELECT 1) para validar
    const reindexIdx = log.findIndex((q) => q.startsWith("REINDEX TABLE"));
    const postReindexSelectIdx = log.findIndex(
      (q, i) => i > reindexIdx && q.startsWith("SELECT 1 FROM card_synergies")
    );
    expect(postReindexSelectIdx).toBeGreaterThan(reindexIdx);
  });
});
