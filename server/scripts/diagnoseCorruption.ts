/**
 * DEEP DIAGNOSTIC: surfaces the real error behind AggregateError.
 *
 * The existing checkDbHealth.ts / repairSynergies.ts catch errors and print
 * `error.message` — but postgres.js wraps some low-level failures in an
 * AggregateError whose own `.message` is literally the string "AggregateError"
 * and whose real payload lives in `.errors[]`. This script unwraps that.
 */
import "dotenv/config";
import { getRawClient, closeDb } from "../db";

function unwrap(e: any, depth = 0): string {
  if (!e) return "<null>";
  const lines: string[] = [];
  const pad = "  ".repeat(depth);
  lines.push(`${pad}name=${e.name} message=${e.message}`);
  if (e.code) lines.push(`${pad}code=${e.code}`);
  if (e.severity_local) lines.push(`${pad}severity=${e.severity_local}`);
  if (e.detail) lines.push(`${pad}detail=${e.detail}`);
  if (e.hint) lines.push(`${pad}hint=${e.hint}`);
  if (e.where) lines.push(`${pad}where=${e.where}`);
  if (e.errno) lines.push(`${pad}errno=${e.errno}`);
  if (e.syscall) lines.push(`${pad}syscall=${e.syscall}`);
  if (e.address) lines.push(`${pad}address=${e.address}`);
  if (e.port) lines.push(`${pad}port=${e.port}`);
  if (Array.isArray(e.errors)) {
    lines.push(`${pad}[AggregateError unwrap — ${e.errors.length} sub-errors]`);
    for (const sub of e.errors) {
      lines.push(unwrap(sub, depth + 1));
    }
  }
  if (e.cause) {
    lines.push(`${pad}[cause]`);
    lines.push(unwrap(e.cause, depth + 1));
  }
  if (e.stack && depth === 0) {
    lines.push(`${pad}stack=${String(e.stack).split("\n").slice(0, 3).join(" | ")}`);
  }
  return lines.join("\n");
}

async function main() {
  console.log("═".repeat(60));
  console.log("  DEEP DB DIAGNOSTIC");
  console.log("═".repeat(60));
  console.log("DATABASE_URL set:", Boolean(process.env.DATABASE_URL));
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    console.log(`  host=${u.hostname} port=${u.port || 5432} db=${u.pathname.slice(1)} user=${u.username}`);
  }

  const sql = await getRawClient();
  if (!sql) {
    console.error("No SQL client — DATABASE_URL missing or postgres() init failed.");
    process.exit(1);
  }

  const probes: Array<[string, () => Promise<any>]> = [
    ["SELECT 1", async () => sql`SELECT 1 AS ok`],
    ["SELECT version()", async () => sql`SELECT version() AS v`],
    ["list public tables", async () => sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`],
    ["card_synergies exists", async () => sql`SELECT to_regclass('public.card_synergies') AS t`],
    ["card_learning exists", async () => sql`SELECT to_regclass('public.card_learning') AS t`],
    ["cards exists", async () => sql`SELECT to_regclass('public.cards') AS t`],
    ["card_synergies count", async () => sql`SELECT COUNT(*)::int AS c FROM card_synergies`],
    ["card_learning count", async () => sql`SELECT COUNT(*)::int AS c FROM card_learning`],
    ["cards count", async () => sql`SELECT COUNT(*)::int AS c FROM cards`],
  ];

  for (const [label, fn] of probes) {
    process.stdout.write(`→ ${label} ... `);
    try {
      const r = await fn();
      console.log(`OK`);
      try {
        const preview = Array.isArray(r) ? r.slice(0, 5) : r;
        console.log("  ", JSON.stringify(preview).slice(0, 300));
      } catch {}
    } catch (e: any) {
      console.log("FAIL");
      console.log(unwrap(e).split("\n").map(l => "  " + l).join("\n"));
    }
  }

  await closeDb();
  console.log("═".repeat(60));
}

main().catch((e) => {
  console.error("[fatal]", unwrap(e));
  process.exit(1);
});
