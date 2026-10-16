/**
 * Deterministic quality contract shared by import sanitisation, training gates
 * and tests.  This module deliberately has no database dependency so the same
 * rules can be exercised before a costly GPU job starts.
 */

export type SupportedTrainingFormat =
  | "standard"
  | "modern"
  | "legacy"
  | "pioneer"
  | "pauper"
  | "vintage"
  | "historic"
  | "commander";

export interface TrainingDeckCard {
  cardName: string;
  quantity: number;
  section?: string | null;
}

export interface TrainingDeckInput {
  format: string;
  isSynthetic?: boolean;
  cards: TrainingDeckCard[];
}

export interface TrainingDeckValidation {
  eligible: boolean;
  mainboardCards: number;
  reasons: string[];
}

export interface PromotionMetrics {
  validDecks: number;
  rejectedDecks: number;
  realMatchCount: number;
  invalidSynergyCount: number;
  baselineMetric?: number | null;
  candidateMetric?: number | null;
  hasCheckpoint?: boolean;
}

export interface PromotionGateResult {
  passed: boolean;
  failures: string[];
}

const BASIC_LANDS = new Set([
  "plains", "island", "swamp", "mountain", "forest", "wastes",
]);
const MAINBOARD_SECTIONS = new Set(["main", "mainboard", ""]);

function isMainboard(card: TrainingDeckCard): boolean {
  return MAINBOARD_SECTIONS.has((card.section ?? "mainboard").trim().toLowerCase());
}

function isBasicLand(name: string): boolean {
  return BASIC_LANDS.has(name.trim().toLowerCase());
}

/** Validate a decklist at the only granularity available in the import table. */
export function validateTrainingDeck(input: TrainingDeckInput): TrainingDeckValidation {
  const reasons: string[] = [];
  const format = input.format.trim().toLowerCase();
  const cards = input.cards.filter(isMainboard);
  const total = cards.reduce((sum, card) => sum + Number(card.quantity || 0), 0);

  if (input.isSynthetic) reasons.push("synthetic_source");
  if (!Object.prototype.hasOwnProperty.call({
    standard: true, modern: true, legacy: true, pioneer: true, pauper: true,
    vintage: true, historic: true, commander: true,
  }, format)) {
    reasons.push("unsupported_format");
  }

  const target = format === "commander" ? 100 : 60;
  if (total !== target) reasons.push(`mainboard_size_${total}_expected_${target}`);
  if (cards.length === 0) reasons.push("missing_mainboard_cards");

  const quantities = new Map<string, number>();
  for (const card of cards) {
    const name = card.cardName.trim();
    const quantity = Number(card.quantity);
    if (!name) reasons.push("blank_card_name");
    if (!Number.isInteger(quantity) || quantity <= 0) reasons.push(`invalid_quantity_${name || "unknown"}`);
    quantities.set(name, (quantities.get(name) ?? 0) + quantity);
  }

  for (const [name, quantity] of Array.from(quantities.entries())) {
    const limit = format === "commander" ? 1 : 4;
    if (quantity > limit && !isBasicLand(name)) {
      reasons.push(`copy_limit_${name}_${quantity}`);
    }
  }

  // A deck with only lands or a handful of unique cards is not a useful
  // composition target even when it happens to total 60.
  const nonBasics = Array.from(quantities.keys()).filter((name) => !isBasicLand(name));
  if (nonBasics.length < 8) reasons.push("insufficient_nonbasic_diversity");

  return { eligible: reasons.length === 0, mainboardCards: total, reasons };
}

/** Reject circular / non-evidential synergy writes before they hit Postgres. */
export function isValidSynergyObservation(
  card1Id: number,
  card2Id: number,
  coOccurrences: number,
): boolean {
  return Number.isInteger(card1Id)
    && Number.isInteger(card2Id)
    && card1Id > 0
    && card2Id > 0
    && card1Id !== card2Id
    && Number.isFinite(coOccurrences)
    && coOccurrences > 0;
}

/** Dataset-only gate used before a fresh training run (no checkpoint yet). */
export function evaluateDataReadiness(metrics: Pick<PromotionMetrics,
  "validDecks" | "invalidSynergyCount"
>): PromotionGateResult {
  const failures: string[] = [];
  if (metrics.validDecks < 20) failures.push("need_at_least_20_valid_decks");
  if (metrics.invalidSynergyCount > 0) failures.push("invalid_synergies_present");
  return { passed: failures.length === 0, failures };
}

/** Fail closed: a policy checkpoint is never marked champion on weak evidence. */
export function evaluatePromotionGates(metrics: PromotionMetrics): PromotionGateResult {
  const failures = evaluateDataReadiness(metrics).failures;
  if (metrics.realMatchCount < 10) failures.push("need_at_least_10_recorded_forge_matches");
  if (!metrics.hasCheckpoint) failures.push("candidate_checkpoint_missing");
  if (!Number.isFinite(metrics.candidateMetric)) failures.push("candidate_metric_missing");
  if ((metrics.candidateMetric ?? Number.NEGATIVE_INFINITY) < 0) {
    failures.push("candidate_metric_below_zero_baseline");
  }
  if (
    Number.isFinite(metrics.baselineMetric)
    && Number.isFinite(metrics.candidateMetric)
    && (metrics.candidateMetric as number) <= (metrics.baselineMetric as number)
  ) {
    failures.push("candidate_did_not_beat_baseline");
  }
  return { passed: failures.length === 0, failures };
}
