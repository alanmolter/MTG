import { describe, expect, it } from "vitest";
import {
  evaluatePromotionGates,
  isValidSynergyObservation,
  validateTrainingDeck,
} from "./trainingQuality";

const validCards = [
  { cardName: "Plains", quantity: 24, section: "mainboard" },
  ...Array.from({ length: 9 }, (_, i) => ({
    cardName: `Spell ${i + 1}`,
    quantity: 4,
    section: "mainboard",
  })),
];

const agentDeckHash = "a".repeat(64);
const opponentDeckHash = "b".repeat(64);
const checkpoint = "C:\\models\\candidate";

function passingEvidence() {
  const metrics = {
    episodes: 30,
    completed_episodes: 30,
    terminal_episodes: 30,
    system_errors: 0,
    action_attempts: 300,
    action_legality_rate: 0.995,
    action_applied_rate: 0.99,
    win_rate: 0.7,
    win_rate_lower_bound_95: 0.52,
    mean_life_difference: 6,
  };
  const baselineMetrics = {
    ...metrics,
    win_rate: 0.4,
    mean_life_difference: 1,
  };
  const comparison = {
    win_rate_delta: 0.3,
    win_rate_delta_lower_bound_95: 0.04,
    mean_life_difference_delta: 5,
  };
  const policyReport = {
    schema_version: "1.0",
    status: "passed",
    pass: true,
    candidate: {
      checkpoint,
      checkpoint_sha256: "c".repeat(64),
      checkpoint_hash_algorithm: "sha256-path-null-filehash-v1",
      policy: "ray_checkpoint",
      metrics,
    },
    opponent: { kind: "forge_ai" },
    baselines: {
      always_pass: { status: "passed", metrics: baselineMetrics },
      legal_random: { status: "passed", metrics: baselineMetrics },
      forge_ai: { status: "passed", metrics: baselineMetrics },
    },
    comparisons: {
      candidate_vs_always_pass: comparison,
      candidate_vs_legal_random: comparison,
      candidate_vs_forge_ai: comparison,
    },
    heldout_matchups: [1, 2, 3].map(seed => ({
      id: `heldout-${seed}`,
      seed,
      declared_heldout: true,
      verified_disjoint_from_training: true,
      agent_deck_sha256: agentDeckHash,
      opponent_deck_sha256: opponentDeckHash,
    })),
    heldout_protocol: {
      training_deck_hashes_supplied: 12,
      verified_disjoint_matchups: 3,
    },
    gates: {
      candidate_has_no_system_errors: true,
      always_pass_baseline_available: true,
      legal_random_baseline_available: true,
      forge_ai_baseline_available: true,
      minimum_completed_episodes: true,
      minimum_terminal_episode_rate: true,
      minimum_action_legality_rate: true,
      minimum_action_applied_rate: true,
      minimum_candidate_win_rate: true,
      minimum_candidate_win_rate_lower_bound_95: true,
      beats_legal_random_win_rate: true,
      beats_legal_random_life_difference: true,
      declared_heldout_matchups: true,
      verified_disjoint_holdout: true,
    },
  };
  const deckReport = {
    schema_version: "1.0",
    gate: "deck_quality",
    pass: true,
    source: { card_database: "forge_cardsfolder" },
    decks: [agentDeckHash, opponentDeckHash].map(hash => ({
      deck_id: hash,
      decklist_sha256: hash,
      pass: true,
      metrics: {
        card_count: 60,
        land_count: 24,
        land_ratio: 0.4,
        mana_curve: {},
        source_counts: {},
        spell_color_checks: {},
        synergy_pairs: 2,
        incompatibility_pairs: 0,
      },
      findings: [],
    })),
    summary: { deck_count: 2, passed_decks: 2 },
  };
  return { policyReport, deckReport };
}

function promotionInput() {
  return {
    validDecks: 20,
    rejectedDecks: 0,
    realMatchCount: 30,
    policyControlledMatchCount: 30,
    invalidSynergyCount: 0,
    baselineMetric: 100,
    candidateMetric: -100,
    hasCheckpoint: true,
    candidateCheckpoint: checkpoint,
    promotionMode: "first_promotion" as const,
    incumbentCheckpoint: null,
    ...passingEvidence(),
  };
}

describe("training quality contract", () => {
  it("accepts an exact, non-synthetic 60-card mainboard", () => {
    expect(
      validateTrainingDeck({ format: "modern", cards: validCards })
    ).toMatchObject({
      eligible: true,
      mainboardCards: 60,
      reasons: [],
    });
  });

  it("rejects incomplete, synthetic and copy-limit-breaking data", () => {
    const result = validateTrainingDeck({
      format: "modern",
      isSynthetic: true,
      cards: [
        { cardName: "Lightning Bolt", quantity: 5, section: "mainboard" },
      ],
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "synthetic_source",
        "mainboard_size_5_expected_60",
        "copy_limit_Lightning Bolt_5",
      ])
    );
  });

  it("never permits a self-synergy observation", () => {
    expect(isValidSynergyObservation(7, 7, 1)).toBe(false);
    expect(isValidSynergyObservation(7, 8, 0)).toBe(false);
    expect(isValidSynergyObservation(7, 8, 2)).toBe(true);
  });

  it("approves strong policy and deck evidence even if training reward is negative", () => {
    expect(evaluatePromotionGates(promotionInput())).toEqual({
      passed: true,
      failures: [],
    });
  });

  it("does not count forge matches that were not policy controlled", () => {
    const input = promotionInput();
    input.policyControlledMatchCount = 0;
    input.realMatchCount = 30;
    expect(evaluatePromotionGates(input).failures).toContain("need_at_least_10_recorded_forge_matches");
  });

  it("fails closed without independent evaluation reports", () => {
    const input = promotionInput();
    expect(
      evaluatePromotionGates({
        ...input,
        policyReport: undefined,
        deckReport: undefined,
      }).failures
    ).toEqual(
      expect.arrayContaining([
        "policy_evaluation_missing",
        "deck_evaluation_missing",
      ])
    );
  });

  it("rejects a blocked Forge AI baseline even if report.pass is spoofed true", () => {
    const input = promotionInput();
    input.policyReport.baselines.forge_ai.status = "blocked";
    expect(evaluatePromotionGates(input).failures).toContain(
      "forge_ai_baseline_not_passed"
    );
  });

  it("rejects unverified holdouts, deck hash mismatch, and wrong checkpoint", () => {
    const input = promotionInput();
    input.policyReport.heldout_matchups[0].verified_disjoint_from_training = false;
    input.deckReport.decks.pop();
    input.policyReport.candidate.checkpoint = "C:\\models\\stale";
    expect(evaluatePromotionGates(input).failures).toEqual(
      expect.arrayContaining([
        "policy_checkpoint_mismatch",
        "heldout_not_verified_disjoint",
        "deck_cohort_coverage_missing",
      ])
    );
  });

  it("rejects weak execution and comparison evidence regardless of reward", () => {
    const input = promotionInput();
    input.policyReport.candidate.metrics.action_applied_rate = 0.5;
    input.policyReport.comparisons.candidate_vs_forge_ai.win_rate_delta_lower_bound_95 =
      -0.1;
    expect(evaluatePromotionGates(input).failures).toEqual(
      expect.arrayContaining([
        "candidate_action_applied_rate_below_0_98",
        "forge_ai_stable_improvement_not_proven",
      ])
    );
  });

  it("requires same-holdout incumbent comparison after the first promotion", () => {
    const input = promotionInput();
    expect(
      evaluatePromotionGates({
        ...input,
        promotionMode: "challenge_incumbent",
        incumbentCheckpoint: "C:\\models\\champion",
      }).failures
    ).toContain("incumbent_comparison_missing");
  });
});

describe("snow basics", () => {
  it("does not apply the 4-copy limit to snow-covered basics", async () => {
    const { validateTrainingDeck } = await import("./trainingQuality");
    const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
    const cards = [
      { cardName: "Snow-Covered Forest", quantity: 14, section: "mainboard" },
      ...names.map((n) => ({ cardName: `Card ${n}`, quantity: 4, section: "mainboard" })),
      { cardName: "Forest", quantity: 2, section: "mainboard" },
    ];
    const result = validateTrainingDeck({ format: "modern", cards, isSynthetic: false } as never);
    expect(result.reasons.filter((r) => r.startsWith("copy_limit"))).toEqual([]);
    expect(result.eligible).toBe(true);
  });
});
