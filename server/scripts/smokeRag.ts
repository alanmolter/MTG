/**
 * Smoke test for the RAG cascade (L0 → L1 → breaker → L3).
 *
 * Usage:
 *   npm run rag:smoke
 *
 * What it does:
 *   1. Checks circuit breaker status
 *   2. Issues the same prompt 3× → first = L3_API (or breaker-blocked),
 *                                    second = L0_EXACT (cached hash),
 *                                    third variant = L1_SEMANTIC if similarity ≥ 0.95
 *   3. Prints a cost/source summary
 *
 * If ml_engine is NOT running, the L1 path fails and the test uses only L0/L3.
 * If ANTHROPIC_API_KEY is unset, L3 will also fail and the test exercises only
 * L0 for cached prompts.
 */

import "dotenv/config";
import { queryWithRAG, getCacheStats } from "../services/ragCache";
import { CircuitBreaker } from "../services/circuitBreaker";

async function main() {
  console.log("=== RAG Smoke Test ===\n");

  console.log("--- breaker status ---");
  const status = await CircuitBreaker.getStatus();
  console.table([
    {
      state: status.state,
      callsThisHour: status.callsThisHour,
      costThisHourUsd: status.costThisHourUsd.toFixed(4),
      cooldownRemainingMs: status.cooldownRemainingMs,
    },
  ]);

  const prompts = [
    "Explique a sinergia entre Rhystic Study e Smothering Tithe num deck de controle Azul/Branco.",
    "Explique a sinergia entre Rhystic Study e Smothering Tithe num deck de controle Azul/Branco.", // exact repeat → L0
    "Quais são as melhores sinergias entre Rhystic Study e Smothering Tithe em controle UW?", // paraphrase → L1 if embed works
  ];

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    console.log(`\n--- prompt ${i + 1} ---`);
    console.log(p.slice(0, 80) + (p.length > 80 ? "…" : ""));
    const t0 = Date.now();
    try {
      const result = await queryWithRAG(p);
      const dt = Date.now() - t0;
      console.log(`source=${result.source} cost=$${result.costUsd.toFixed(5)} dt=${dt}ms`);
      if (result.similarity !== undefined) {
        console.log(`similarity=${result.similarity.toFixed(4)}`);
      }
      console.log(`text: ${result.text.slice(0, 200)}${result.text.length > 200 ? "…" : ""}`);
    } catch (err) {
      const dt = Date.now() - t0;
      console.log(`FAILED after ${dt}ms: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\n--- cache stats ---");
  const stats = await getCacheStats();
  console.table([stats]);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
