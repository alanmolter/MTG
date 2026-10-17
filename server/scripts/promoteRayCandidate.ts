/**
 * Final, fail-closed handoff from Ray to the auditable training ledger.
 * A Ray checkpoint is a gameplay-policy artifact, not a decklist generator;
 * this script approves it only for policy evaluation after both Ray and data
 * gates pass. It never mutates card_learning.
 */
import "dotenv/config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { count, eq, sql } from "drizzle-orm";
import {
  cardSynergies,
  competitiveDecks,
  forgeMatches,
  trainingRuns,
} from "../../drizzle/schema";
import { closeDb, getDb } from "../db";
import { evaluatePromotionGates } from "../services/trainingQuality";

type RayPromotion = {
  reward?: number;
  baseline_reward?: number;
  checkpoint?: string | null;
  promoted?: boolean;
};

function normalizeCheckpoint(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /path=([^)]+)/.exec(value);
  const raw = (match?.[1] ?? value).trim();
  return raw ? path.normalize(path.resolve(raw)) : null;
}

function isCandidateEvaluation(
  rawJson: string | null,
  candidate: string | null
): boolean {
  if (!rawJson || !candidate) return false;
  try {
    const parsed = JSON.parse(rawJson) as {
      evaluationMode?: string;
      candidateCheckpoint?: string | null;
      policyControlled?: boolean;
    };
    return (
      parsed.evaluationMode === "pre_promotion_evaluation" &&
      parsed.policyControlled === true &&
      normalizeCheckpoint(parsed.candidateCheckpoint) === candidate
    );
  } catch {
    return false;
  }
}

function checkpointReward(
  checkpoint: string | null | undefined
): number | undefined {
  if (!checkpoint) return undefined;
  const match = /path=([^)]+)/.exec(checkpoint);
  if (!match) return undefined;
  const resultPath = path.join(path.dirname(match[1]), "result.json");
  if (!fs.existsSync(resultPath)) return undefined;
  try {
    const lines = fs.readFileSync(resultPath, "utf8").trim().split(/\r?\n/);
    const last = JSON.parse(lines[lines.length - 1]);
    const nested = last?.env_runners?.episode_return_mean;
    const flat =
      last?.["env_runners/episode_return_mean"] ??
      last?.["env_runners/episode_reward_mean"];
    const value = Number(nested ?? flat);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function latestPromotionReport(): string | null {
  const root = process.env.RAY_RESULTS_DIR
    ? path.resolve(process.env.RAY_RESULTS_DIR)
    : path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "mtg-deck-mvp",
        "ray_results"
      );
  if (!fs.existsSync(root)) return null;
  const candidates = fs
    .readdirSync(root)
    .filter(name => name.startsWith("pbt_mtg_"))
    .map(name => path.join(root, name, "promotion_report.json"))
    .filter(file => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

async function main(): Promise<void> {
  const reportPath = latestPromotionReport();
  if (!reportPath)
    throw new Error("Nenhum promotion_report.json do Ray foi encontrado.");
  const report = JSON.parse(
    fs.readFileSync(reportPath, "utf8")
  ) as RayPromotion;
  const observedReward = checkpointReward(report.checkpoint) ?? report.reward;
  const db = await getDb();
  if (!db) throw new Error("Banco indisponível");

  const [{ value: validDecks }] = await db
    .select({ value: count() })
    .from(competitiveDecks)
    .where(eq(competitiveDecks.isTrainingEligible, true));
  // The column is added by the bridge migration (PR #10). It is selected
  // by name so this script compiles before that column is on the Drizzle table.
  const matchEvidence = await db
    .select({
      rawJson: forgeMatches.rawJson,
      policyControlled: sql<boolean | null>`policy_controlled`.as("policy_controlled"),
    })
    .from(forgeMatches);
  const candidatePath = normalizeCheckpoint(report.checkpoint);
  const candidateMatches = matchEvidence.filter(match =>
    isCandidateEvaluation(match.rawJson, candidatePath)
  );
  const realMatchCount = candidateMatches.length;
  const policyControlledMatchCount = candidateMatches.filter(
    match => match.policyControlled === true
  ).length;
  const [{ value: invalidSynergyCount }] = await db
    .select({ value: count() })
    .from(cardSynergies)
    .where(sql`${cardSynergies.card1Id} = ${cardSynergies.card2Id}`);

  const gates = evaluatePromotionGates({
    validDecks: Number(validDecks),
    rejectedDecks: 0,
    realMatchCount,
    policyControlledMatchCount,
    invalidSynergyCount: Number(invalidSynergyCount),
    baselineMetric: report.baseline_reward,
    candidateMetric: observedReward,
    hasCheckpoint: Boolean(report.checkpoint),
  });
  const status = gates.passed ? "approved_for_policy_evaluation" : "blocked";
  await db.insert(trainingRuns).values({
    runKind: "ray_promotion",
    status,
    validDecks: Number(validDecks),
    realMatchCount,
    invalidSynergyCount: Number(invalidSynergyCount),
    baselineMetric: report.baseline_reward ?? null,
    candidateMetric: observedReward ?? null,
    artifactPath: report.checkpoint ?? null,
    gateReport: {
      rayPromoted: Boolean(report.promoted),
      failures: gates.failures,
      reportPath,
    },
    completedAt: new Date(),
  });

  console.log("\n════════════════ PROMOÇÃO DE CHECKPOINT ════════════════");
  console.log(`  Checkpoint Ray : ${report.checkpoint ?? "ausente"}`);
  console.log(
    `  Reward         : ${observedReward ?? "ausente"} (baseline ${report.baseline_reward ?? 0})`
  );
  console.log(
    `  Decks válidos  : ${validDecks} | avaliações Forge do candidato: ${realMatchCount} | auto-sinergias: ${invalidSynergyCount}`
  );
  console.log(`  Resultado      : ${status}`);
  if (!gates.passed)
    console.log(`  Gates falhos   : ${gates.failures.join(", ")}`);
  console.log("════════════════════════════════════════════════════════\n");
  if (!gates.passed) process.exitCode = 2;
}

main()
  .catch(error => {
    console.error("[promoteRayCandidate] erro:", error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
