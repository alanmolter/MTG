/**
 * poolFilter.ts — Training pool scope helpers.
 *
 * The TRAINING_POOL_ARENA_ONLY env var (truthy: "1", "true", "yes", "on" —
 * case-insensitive) tells trainer scripts to restrict their card pool to
 * Magic Arena-legal cards only. Used to bootstrap the model on a smaller,
 * replicable space (~3k Standard / ~12k Pioneer + Historic) before scaling
 * to the full ~35k paper catalog.
 *
 * Why an env var (vs a CLI flag)?
 *   - `fullBrainTraining.ts` spawns `trainCommander.ts` and
 *     `continuousTraining.ts` as subprocesses; env vars are inherited
 *     automatically. CLI flags would need to be plumbed through every
 *     `spawn(...)` call.
 *   - Single source of truth shared by Commander + Self-Play loops.
 *   - Trivial to toggle from npm scripts without code changes.
 *
 * The flag is *additive* to the trainer's existing filters (forbidden
 * colors, cmc cap, pool offset). When unset, behavior is identical to
 * before — the full catalog is used.
 *
 * Source-of-truth for whether a card is Arena-legal lives on the `cards`
 * table as `is_arena INT (0|1)`, populated from Scryfall's `games[]`
 * containing "arena". See `server/sync-bulk.ts` and the backfill script
 * `server/scripts/repairArenaFlag.ts`.
 */

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Returns true if training scripts should restrict the pool to Arena-legal
 * cards. Reads `process.env.TRAINING_POOL_ARENA_ONLY` at call time so tests
 * can mutate it freely between cases.
 */
export function isArenaOnlyTraining(): boolean {
  const v = process.env.TRAINING_POOL_ARENA_ONLY;
  if (!v) return false;
  return TRUTHY_VALUES.has(v.toLowerCase().trim());
}

/**
 * Human-readable label for the current training pool scope. Used in
 * trainer banner output so the user sees at a glance which catalog is
 * being trained on.
 */
export function describeTrainingPool(): string {
  return isArenaOnlyTraining() ? "Arena-only" : "Full catalog";
}
