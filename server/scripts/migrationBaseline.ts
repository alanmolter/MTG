/**
 * Baseline, auditoria e execução das migrações do drizzle
 * (ledger: drizzle.__drizzle_migrations).
 *
 * O migrator do drizzle-orm 0.44 só olha o maior `created_at` do ledger:
 *   - não confere o hash (um .sql editado depois de aplicado passa batido);
 *   - entrada do journal com `when` menor que o último aplicado é pulada em silêncio.
 * Por isso `auditLedger` roda antes de migrar e em `npm run db:check`.
 *
 * Baseline: num banco onde 0003–0010 já foram aplicadas por outro caminho (psql
 * ou o runner antigo, que gravava em public.schema_migrations) o ledger do drizzle
 * está vazio e o migrator reexecutaria 0003 (CREATE TYPE ...). `planBaseline`
 * decide o que carimbar como aplicado:
 *
 *  1. Ledger do drizzle já tem linhas      -> nada a fazer.
 *  2. `--through <tag>` explícito          -> carimba até essa tag (inclusive).
 *  3. public.schema_migrations existe      -> carimba o prefixo contíguo do journal
 *                                             registrado ali.
 *  4. public.cards existe sem ledger algum -> erro: exige `--through`
 *                                             (sugere a maior tag verificada).
 *  5. Banco vazio                          -> nada; o migrator aplica tudo.
 *
 * Nos casos 2 e 3, cada tag é VERIFICADA no catálogo (`TAG_CHECKS`) antes de
 * carimbar. O runner de af0ece20 gravava registros em schema_migrations só porque
 * `cards` existia, então esse ledger não é confiável por si só. Se faltar algum
 * objeto, aborta sem gravar nada.
 */
import { createHash } from "crypto";

export type QueryResult = Array<Record<string, unknown>>;

export interface MigrationDb {
  query(sqlText: string, params?: unknown[]): Promise<QueryResult>;
  transaction<T>(fn: (tx: MigrationDb) => Promise<T>): Promise<T>;
}

export interface JournalMigration {
  tag: string;
  when: number;
  hash: string;
}

export const DRIZZLE_SCHEMA = "drizzle";
export const DRIZZLE_TABLE = "__drizzle_migrations";
export const LEGACY_LEDGER = "schema_migrations";
/** Chave fixa do pg_advisory_lock que serializa migrate/baseline (ASCII "MTGM"). */
export const MIGRATION_LOCK_KEY = 0x4d54474d;

/** Mesmo hash que drizzle-orm/migrator grava (sha256 do arquivo inteiro). */
export function migrationHash(sqlText: string): string {
  return createHash("sha256").update(sqlText).digest("hex");
}

// ── Verificação por tag ──────────────────────────────────────────────────────

export type ObjectCheck =
  | { kind: "table"; name: string }
  | { kind: "index"; name: string }
  | { kind: "column"; table: string; column: string }
  | { kind: "type"; name: string }
  | { kind: "extension"; name: string }
  | { kind: "default"; table: string; column: string; contains: string };

const t = (name: string): ObjectCheck => ({ kind: "table", name });
const i = (name: string): ObjectCheck => ({ kind: "index", name });
const c = (table: string, column: string): ObjectCheck => ({ kind: "column", table, column });

/**
 * Objetos que cada migração cria. Uma tag só pode ser carimbada se todos
 * existirem. Tags novas (prefixo timestamp) são aplicadas pelo migrator e não
 * precisam estar aqui; carimbar uma tag sem entrada aborta.
 */
export const TAG_CHECKS: Record<string, ObjectCheck[]> = {
  "0003_postgres_init": [
    { kind: "type", name: "role" },
    { kind: "type", name: "job_status" },
    ...["users", "cards", "decks", "deck_cards", "card_synergies", "meta_stats",
      "embeddings_cache", "competitive_decks", "competitive_deck_cards", "training_jobs"].map(t),
  ],
  "0004_mtg_ai_updates": [
    c("competitive_decks", "is_synthetic"),
    t("card_learning"), t("rl_decisions"), t("deck_shares"),
    c("cards", "oracle_id"), c("cards", "is_arena"), c("cards", "price_usd"),
    { kind: "type", name: "status" },
    i("competitive_decks_source_id_unique"),
    i("competitive_deck_cards_deck_card_section_unique"),
  ],
  "0005_endgame_pgvector": [
    { kind: "extension", name: "vector" },
    t("card_oracle_embeddings"), t("semantic_cache"), t("api_budget_ledger"),
    t("card_contextual_weight"), t("toxic_actions"), t("mcts_nodes"), t("league_state"),
    i("idx_card_oracle_embed_hnsw"), i("idx_semcache_embedding_hnsw"), i("idx_card_ctx_weight_hnsw"),
  ],
  "0006_archetype_weights": [
    ...["weight_aggro", "weight_control", "weight_midrange", "weight_combo", "weight_ramp"]
      .map((col) => c("card_learning", col)),
    i("learning_weight_aggro_idx"), i("learning_weight_ramp_idx"),
  ],
  "0007_competitive_deck_cards_repair": [
    t("competitive_deck_cards"),
    i("competitive_deck_cards_deck_card_section_unique"),
    i("competitive_deck_cards_deck_id_idx"),
  ],
  "0008_training_quality_gates": [
    c("competitive_decks", "is_training_eligible"),
    c("competitive_decks", "training_rejection_reason"),
    c("competitive_decks", "training_quality_checked_at"),
    i("competitive_decks_training_eligible_idx"),
    t("training_runs"), i("training_runs_recent_idx"), t("forge_matches"),
  ],
  // 0009 só reafirma objetos de 0003/0007 (tudo idempotente): a checagem é
  // necessariamente a mesma do estado pós-0007.
  "0009_competitive_deck_import": [
    { kind: "default", table: "competitive_decks", column: "source", contains: "moxfield" },
    i("competitive_deck_cards_deck_card_section_unique"),
    i("competitive_deck_cards_deck_id_idx"),
  ],
  "0010_forge_match_provenance": [
    ...["agent_deck_id", "opponent_deck_id", "seed", "policy_version", "pool_version", "bridge_version"]
      .map((col) => c("forge_matches", col)),
    i("forge_matches_seed_idx"), i("forge_matches_policy_version_idx"),
  ],
};

export function describeCheck(check: ObjectCheck): string {
  switch (check.kind) {
    case "table": return `tabela ${check.name}`;
    case "index": return `índice ${check.name}`;
    case "column": return `coluna ${check.table}.${check.column}`;
    case "type": return `tipo ${check.name}`;
    case "extension": return `extensão ${check.name}`;
    case "default": return `default de ${check.table}.${check.column} contendo '${check.contains}'`;
  }
}

export async function objectExists(db: MigrationDb, check: ObjectCheck): Promise<boolean> {
  switch (check.kind) {
    case "table":
    case "index":
      return exists(db, `public.${check.name}`);
    case "column": {
      const rows = await db.query(
        `SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [check.table, check.column],
      );
      return rows.length > 0;
    }
    case "type": {
      const rows = await db.query(
        `SELECT 1 AS ok FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = $1`,
        [check.name],
      );
      return rows.length > 0;
    }
    case "extension": {
      const rows = await db.query(`SELECT 1 AS ok FROM pg_extension WHERE extname = $1`, [check.name]);
      return rows.length > 0;
    }
    case "default": {
      const rows = await db.query(
        `SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [check.table, check.column],
      );
      return String(rows[0]?.column_default ?? "").includes(check.contains);
    }
  }
}

/** Objetos ausentes para a tag. Tag sem checagem definida conta como falha. */
export async function missingObjects(db: MigrationDb, tag: string): Promise<string[]> {
  const checks = TAG_CHECKS[tag];
  if (!checks) return [`(sem checagem definida para ${tag} em TAG_CHECKS)`];
  const missing: string[] = [];
  for (const check of checks) {
    if (!(await objectExists(db, check))) missing.push(describeCheck(check));
  }
  return missing;
}

async function verifyEntries(db: MigrationDb, entries: JournalMigration[], source: string) {
  const problems: string[] = [];
  for (const entry of entries) {
    const missing = await missingObjects(db, entry.tag);
    if (missing.length > 0) problems.push(`  ${entry.tag}: falta ${missing.join(", ")}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `Baseline abortado (${source}): o banco não contém os objetos das migrações que seriam carimbadas.\n` +
        `${problems.join("\n")}\n` +
        `Nada foi gravado. Rode com --through <última tag realmente aplicada> (ver docs/migrations.md).`,
    );
  }
}

/** Maior prefixo do journal cujos objetos existem (usado só como sugestão). */
export async function highestVerifiedTag(db: MigrationDb, journal: JournalMigration[]): Promise<string | null> {
  let last: string | null = null;
  for (const entry of journal) {
    if (!TAG_CHECKS[entry.tag]) break;
    if ((await missingObjects(db, entry.tag)).length > 0) break;
    last = entry.tag;
  }
  return last;
}

// ── Plano de baseline ────────────────────────────────────────────────────────

export type BaselinePlan =
  | { kind: "tracked" }
  | { kind: "fresh" }
  | { kind: "stamp"; source: "explicit" | "schema_migrations"; entries: JournalMigration[] };

async function exists(db: MigrationDb, regclass: string): Promise<boolean> {
  const rows = await db.query(`SELECT to_regclass($1) AS rel`, [regclass]);
  return rows[0]?.rel != null;
}

export async function readLedger(db: MigrationDb): Promise<Array<{ hash: string; created_at: number }>> {
  if (!(await exists(db, `${DRIZZLE_SCHEMA}.${DRIZZLE_TABLE}`))) return [];
  const rows = await db.query(
    `SELECT hash, created_at FROM "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}" ORDER BY created_at, id`,
  );
  return rows.map((row) => ({ hash: String(row.hash), created_at: Number(row.created_at) }));
}

export async function planBaseline(
  db: MigrationDb,
  journal: JournalMigration[],
  opts: { through?: string } = {},
): Promise<BaselinePlan> {
  const ledger = await readLedger(db);
  if (ledger.length > 0) {
    if (opts.through) {
      throw new Error(
        `${DRIZZLE_SCHEMA}.${DRIZZLE_TABLE} já tem registros; --through não é aplicado sobre um ledger existente.`,
      );
    }
    return { kind: "tracked" };
  }

  if (opts.through) {
    const idx = journal.findIndex((entry) => entry.tag === opts.through);
    if (idx < 0) {
      throw new Error(
        `--through ${opts.through}: tag não encontrada no journal. Tags válidas: ${journal.map((e) => e.tag).join(", ")}`,
      );
    }
    const entries = journal.slice(0, idx + 1);
    await verifyEntries(db, entries, "--through");
    return { kind: "stamp", source: "explicit", entries };
  }

  if (await exists(db, `public.${LEGACY_LEDGER}`)) {
    const rows = await db.query(`SELECT filename FROM public.${LEGACY_LEDGER}`);
    const recorded = new Set(rows.map((row) => String(row.filename).replace(/\.sql$/, "")));
    const prefix: JournalMigration[] = [];
    let gapAt: string | null = null;
    for (const entry of journal) {
      if (recorded.has(entry.tag)) {
        if (gapAt) {
          throw new Error(
            `${LEGACY_LEDGER} registra ${entry.tag} mas não ${gapAt}. ` +
              `Confira o banco e rode o baseline com --through <última tag realmente aplicada>.`,
          );
        }
        prefix.push(entry);
      } else if (!gapAt) {
        gapAt = entry.tag;
      }
    }
    if (prefix.length === 0) return { kind: "fresh" };
    await verifyEntries(db, prefix, LEGACY_LEDGER);
    return { kind: "stamp", source: "schema_migrations", entries: prefix };
  }

  if (await exists(db, "public.cards")) {
    const hint = await highestVerifiedTag(db, journal);
    throw new Error(
      "Banco já tem tabelas (public.cards) mas nenhum ledger de migrações. " +
        "Descubra até qual migração ele está e rode: npm run db:baseline -- --through <tag>" +
        (hint ? ` (os objetos verificados batem até ${hint}).` : ".") +
        " Ver docs/migrations.md.",
    );
  }

  return { kind: "fresh" };
}

export async function applyBaseline(db: MigrationDb, plan: BaselinePlan): Promise<string[]> {
  if (plan.kind !== "stamp") return [];
  await db.transaction(async (tx) => {
    // Mesmo DDL que drizzle-orm cria em pg-core/dialect.migrate().
    await tx.query(`CREATE SCHEMA IF NOT EXISTS "${DRIZZLE_SCHEMA}"`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    for (const entry of plan.entries) {
      await tx.query(
        `INSERT INTO "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}" (hash, created_at) VALUES ($1, $2)`,
        [entry.hash, entry.when],
      );
    }
  });
  return plan.entries.map((entry) => entry.tag);
}

// ── Auditoria (db:check) ─────────────────────────────────────────────────────

/** Problemas do journal em si (sem banco): `when` fora de ordem ou repetido. */
export function auditJournal(journal: Array<{ tag: string; when: number }>): string[] {
  const problems: string[] = [];
  for (let k = 1; k < journal.length; k++) {
    if (!(journal[k].when > journal[k - 1].when)) {
      problems.push(
        `journal fora de ordem: ${journal[k].tag} (when=${journal[k].when}) <= ${journal[k - 1].tag} (when=${journal[k - 1].when})`,
      );
    }
  }
  return problems;
}

/**
 * Compara o ledger com o journal:
 *  - todo registro precisa casar com uma entrada (`created_at` == `when`);
 *  - o hash gravado precisa ser o sha256 atual do arquivo (arquivo editado);
 *  - entrada com `when` <= último aplicado que não está no ledger seria pulada
 *    em silêncio pelo migrator.
 */
export function auditLedger(
  journal: JournalMigration[],
  ledger: Array<{ hash: string; created_at: number }>,
): string[] {
  const problems = auditJournal(journal);
  const byWhen = new Map(journal.map((entry) => [entry.when, entry]));
  const applied = new Set<number>();
  for (const row of ledger) {
    const entry = byWhen.get(row.created_at);
    if (!entry) {
      problems.push(`ledger tem created_at=${row.created_at} sem entrada correspondente no journal`);
      continue;
    }
    applied.add(entry.when);
    if (row.hash !== entry.hash) {
      problems.push(`${entry.tag}: hash do arquivo mudou depois de aplicado (ledger ${row.hash.slice(0, 12)}…, arquivo ${entry.hash.slice(0, 12)}…)`);
    }
  }
  const last = ledger.reduce((max, row) => Math.max(max, row.created_at), -Infinity);
  for (const entry of journal) {
    if (entry.when <= last && !applied.has(entry.when)) {
      problems.push(`${entry.tag}: when=${entry.when} <= último aplicado (${last}) e não está no ledger; o migrator a pularia`);
    }
  }
  return problems;
}

// ── Orquestração com lock ────────────────────────────────────────────────────

export interface RunResult {
  plan: BaselinePlan;
  stamped: string[];
  migrated: boolean;
}

/**
 * pg_advisory_lock (nível de sessão) -> audita -> planeja -> carimba -> migra -> unlock.
 * `db` precisa ser a MESMA conexão usada por `migrate` (o lock é por sessão).
 * Duas execuções concorrentes (training:prepare + import:competitive) ficam em
 * fila: a segunda só planeja depois que a primeira terminou, e vê o ledger pronto.
 */
export async function runMigrations(
  db: MigrationDb,
  journal: JournalMigration[],
  migrate: () => Promise<void>,
  opts: { through?: string; baselineOnly?: boolean } = {},
): Promise<RunResult> {
  const journalProblems = auditJournal(journal);
  if (journalProblems.length > 0) throw new Error(journalProblems.join("\n"));

  await db.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
  try {
    const before = auditLedger(journal, await readLedger(db));
    if (before.length > 0) {
      throw new Error(`Ledger inconsistente com drizzle/:\n  ${before.join("\n  ")}`);
    }
    const plan = await planBaseline(db, journal, { through: opts.through });
    const stamped = await applyBaseline(db, plan);
    if (opts.baselineOnly) return { plan, stamped, migrated: false };
    await migrate();
    return { plan, stamped, migrated: true };
  } finally {
    await db.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]);
  }
}
