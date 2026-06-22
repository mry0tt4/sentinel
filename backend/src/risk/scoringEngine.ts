/**
 * Deterministic risk scoring engine (the gating path).
 *
 * This module computes the Risk_Score, band, risk classes, recommended action,
 * and confidence using *reproducible* rules + a simple anomaly detector. No
 * language model participates in any of these computations — the LLM only
 * authors the human-readable explanation later (task 7.5). This is the single
 * source of truth that gates autonomous actions. (Req 6.11, 6.13)
 *
 * Scoring model (design "Risk Scoring Model"):
 *   Risk_Score = round( Σ weight_i × subscore_i ), clamped to [0, 100]
 * over five feature groups, each normalized to a 0–100 subscore:
 *   Oracle 25% · Volatility 25% · Liquidity 20% · Exposure 20% · Governance 10%
 * The weights sum to 1.0, so the weighted sum is already in [0, 100]; rounding
 * and the defensive clamp guarantee an integer in [0, 100] for *any* input —
 * including non-finite, missing-defaulted, and adversarial values. (Req 6.2)
 *
 * Structured so the later tasks slot in cleanly:
 *   - 7.5  AI explanation  → fills `RiskEvaluation.explanation` (left '').
 *   - 7.7  fail-closed     → post-processes `recommendedAction`/`refusalReason`.
 *   - 7.10 version registry→ supplies `modelVersion`/`promptConfigVersion`.
 */

import type {
  ActionType,
  DeterministicRuleOutput,
  FeatureVector,
  RiskBand,
  RiskClass,
  RiskEngine,
  RiskEvaluation,
} from './types.js';
import { ACTION_PRIORITY } from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Feature-group weights. MUST sum to 1.0 (asserted at module load). */
export interface FeatureGroupWeights {
  oracle: number;
  volatility: number;
  liquidity: number;
  exposure: number;
  governance: number;
}

/**
 * Normalization scales and rule thresholds. All scales are the magnitude at
 * which a signal is considered fully saturated (subscore 100). Defaults are
 * derived from the design; they are injectable so tests and future tuning can
 * override them without code changes.
 */
export interface ScoringConfig {
  weights: FeatureGroupWeights;

  // Oracle group
  /** Confidence-interval/price ratio that saturates oracle confidence risk. */
  oracleConfidenceFullRiskRatio: number; // e.g. 0.02 = 2%
  /** Price divergence fraction vs reference that saturates divergence risk. */
  oracleDivergenceFullRiskFraction: number; // e.g. 0.05 = 5%

  // Volatility group (percent magnitudes that saturate each window)
  volatility1mFullRiskPct: number;
  volatility5mFullRiskPct: number;
  volatility15mFullRiskPct: number;
  realizedVolatilityFullRiskPct: number;

  // Liquidity group
  /** Depth at/above which liquidity-depth risk is zero. */
  liquidityBaselineDepth: number;
  /** Spread (bps) that saturates spread risk. */
  spreadFullRiskBps: number;

  // Exposure group
  /** Exposure at/above which exposure risk saturates. */
  exposureBaseline: number;

  // Classification thresholds
  flashCrash1mPct: number; // e.g. -10 (drop)
  flashCrash5mPct: number; // e.g. -15
  depegFraction: number; // e.g. 0.005 = 0.5%
  liquidityCollapseDepthFraction: number; // e.g. 0.2 of baseline
  liquidityCollapseSpreadBps: number; // e.g. 100
  liquidationCascadeUtilization: number; // e.g. 0.9
  liquidationCascadeMovePct: number; // e.g. 10
  highUtilization: number; // e.g. 0.85

  // Anomaly detection: short-term move / realized vol ratio that flags anomaly.
  anomalyMoveToVolRatio: number; // e.g. 3

  // Versioning (replaced by the registry in task 7.10)
  modelVersion: string;
  promptConfigVersion: string;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: {
    oracle: 0.25,
    volatility: 0.25,
    liquidity: 0.2,
    exposure: 0.2,
    governance: 0.1,
  },
  oracleConfidenceFullRiskRatio: 0.02,
  oracleDivergenceFullRiskFraction: 0.05,
  volatility1mFullRiskPct: 5,
  volatility5mFullRiskPct: 10,
  volatility15mFullRiskPct: 15,
  realizedVolatilityFullRiskPct: 50,
  liquidityBaselineDepth: 1_000_000,
  spreadFullRiskBps: 100,
  exposureBaseline: 10_000_000,
  flashCrash1mPct: -10,
  flashCrash5mPct: -15,
  depegFraction: 0.005,
  liquidityCollapseDepthFraction: 0.2,
  liquidityCollapseSpreadBps: 100,
  liquidationCascadeUtilization: 0.9,
  liquidationCascadeMovePct: 10,
  highUtilization: 0.85,
  anomalyMoveToVolRatio: 3,
  modelVersion: 'sentinel-risk-engine@0.1.0',
  promptConfigVersion: 'sentinel-prompt-config@0.1.0',
};

// Fail fast if the weights are ever edited to not sum to 1.0 — the [0,100]
// output guarantee depends on this invariant.
{
  const w = DEFAULT_SCORING_CONFIG.weights;
  const sum = w.oracle + w.volatility + w.liquidity + w.exposure + w.governance;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`Feature-group weights must sum to 1.0 (got ${sum})`);
  }
}

// ---------------------------------------------------------------------------
// Numeric helpers (robust to NaN / Infinity / division-by-zero)
// ---------------------------------------------------------------------------

/**
 * Normalized magnitude of `value` against `scale`, saturating in [0, 1].
 * Non-finite inputs are treated as maximal risk when non-zero so adversarial
 * values can never escape the bound.
 */
function saturatingFraction(value: number, scale: number): number {
  if (!Number.isFinite(value)) return value === 0 ? 0 : 1;
  if (!Number.isFinite(scale) || scale <= 0) return value !== 0 ? 1 : 0;
  const ratio = Math.abs(value) / scale;
  if (!Number.isFinite(ratio)) return 1;
  return Math.min(1, Math.max(0, ratio));
}

/** Clamp an arbitrary number into [0, 100]; non-finite becomes 0. */
function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Max of several subscore signals, each already in [0, 100]. */
function maxScore(...values: number[]): number {
  return values.reduce((acc, v) => Math.max(acc, clampScore(v)), 0);
}

// ---------------------------------------------------------------------------
// Per-group subscores (each returns a value in [0, 100])
// ---------------------------------------------------------------------------

/** Age of the oracle reading in ms (never negative). */
function oracleAgeMs(f: FeatureVector): number {
  const age = f.nowMs - f.oracleTimestampMs;
  return Number.isFinite(age) && age > 0 ? age : 0;
}

/** Oracle risk: worst of staleness, confidence-interval width, divergence. */
export function oracleSubscore(f: FeatureVector, cfg: ScoringConfig): number {
  const staleness = saturatingFraction(oracleAgeMs(f), f.freshnessThresholdMs) * 100;

  const price = Math.abs(f.oraclePrice);
  const confRatio = price > 0 ? f.oracleConfidence / price : f.oracleConfidence !== 0 ? Infinity : 0;
  const confidence = saturatingFraction(confRatio, cfg.oracleConfidenceFullRiskRatio) * 100;

  let divergence = 0;
  if (f.referencePrice !== undefined && Number.isFinite(f.referencePrice) && f.referencePrice !== 0) {
    const divFrac = Math.abs(f.oraclePrice - f.referencePrice) / Math.abs(f.referencePrice);
    divergence = saturatingFraction(divFrac, cfg.oracleDivergenceFullRiskFraction) * 100;
  }

  let depeg = 0;
  if (f.expectedPegPrice !== undefined && Number.isFinite(f.expectedPegPrice) && f.expectedPegPrice !== 0) {
    const depegFrac = Math.abs(f.oraclePrice - f.expectedPegPrice) / Math.abs(f.expectedPegPrice);
    depeg = saturatingFraction(depegFrac, cfg.oracleDivergenceFullRiskFraction) * 100;
  }

  return maxScore(staleness, confidence, divergence, depeg);
}

/** Volatility risk: worst of the 1m/5m/15m moves and realized volatility. */
export function volatilitySubscore(f: FeatureVector, cfg: ScoringConfig): number {
  const s1 = saturatingFraction(f.priceChange1mPct, cfg.volatility1mFullRiskPct) * 100;
  const s5 = saturatingFraction(f.priceChange5mPct, cfg.volatility5mFullRiskPct) * 100;
  const s15 = saturatingFraction(f.priceChange15mPct, cfg.volatility15mFullRiskPct) * 100;
  const sRv = saturatingFraction(f.realizedVolatilityPct, cfg.realizedVolatilityFullRiskPct) * 100;
  return maxScore(s1, s5, s15, sRv);
}

/** Liquidity risk: worst of thin depth, wide spread, and book imbalance. */
export function liquiditySubscore(f: FeatureVector, cfg: ScoringConfig): number {
  // Depth: lower depth = higher risk. depthFrac is "how full" the book is.
  const depthFrac = saturatingFraction(f.liquidityDepth, cfg.liquidityBaselineDepth);
  const depthRisk = (1 - depthFrac) * 100;

  const spreadRisk = saturatingFraction(f.spreadBps, cfg.spreadFullRiskBps) * 100;
  const imbalanceRisk = saturatingFraction(f.imbalance, 1) * 100;

  return maxScore(depthRisk, spreadRisk, imbalanceRisk);
}

/** Protocol-exposure risk: weighted utilization, exposure, and current LTV. */
export function exposureSubscore(f: FeatureVector, cfg: ScoringConfig): number {
  const utilizationRisk = saturatingFraction(f.utilization, 1) * 100;
  const exposureRisk = saturatingFraction(f.exposure, cfg.exposureBaseline) * 100;
  const ltvRisk = saturatingFraction(f.currentMaxLtvBps, 10_000) * 100;

  // Utilization dominates; exposure and LTV contribute equally.
  const blended = 0.5 * utilizationRisk + 0.25 * exposureRisk + 0.25 * ltvRisk;
  return clampScore(blended);
}

/** Governance/config risk: revocation, inactive policy, paused/guarded, overrides. */
export function governanceSubscore(f: FeatureVector): number {
  if (f.guardianRevoked) return 100;
  const inactivePolicyRisk = f.policyActive ? 0 : 80;
  const pausedRisk = f.borrowPaused ? 60 : 0;
  const guardedRisk = f.guardedMode ? 40 : 0;
  const overrideRisk = saturatingFraction(f.priorOverridesCount, 5) * 100;
  return maxScore(inactivePolicyRisk, pausedRisk, guardedRisk, overrideRisk);
}

// ---------------------------------------------------------------------------
// Aggregation, band, classification, action, confidence
// ---------------------------------------------------------------------------

export interface Subscores {
  oracle: number;
  volatility: number;
  liquidity: number;
  exposure: number;
  governance: number;
}

/** Compute all five group subscores. */
export function computeSubscores(f: FeatureVector, cfg: ScoringConfig): Subscores {
  return {
    oracle: oracleSubscore(f, cfg),
    volatility: volatilitySubscore(f, cfg),
    liquidity: liquiditySubscore(f, cfg),
    exposure: exposureSubscore(f, cfg),
    governance: governanceSubscore(f),
  };
}

/**
 * Weighted aggregate, rounded and clamped to an integer in [0, 100]. (Req 6.2)
 */
export function aggregateScore(sub: Subscores, cfg: ScoringConfig): number {
  const w = cfg.weights;
  const weighted =
    w.oracle * sub.oracle +
    w.volatility * sub.volatility +
    w.liquidity * sub.liquidity +
    w.exposure * sub.exposure +
    w.governance * sub.governance;
  return Math.round(clampScore(weighted));
}

/**
 * Assign exactly one band. The ranges partition [0, 100] with no gaps or
 * overlaps, so every score maps to exactly one band. (Req 6.3)
 */
export function assignBand(score: number): RiskBand {
  const s = clampScore(score);
  if (s <= 39) return 'Normal';
  if (s <= 59) return 'Warning';
  if (s <= 74) return 'Guarded';
  if (s <= 89) return 'ParamAdjust';
  return 'EmergencyPause';
}

/** Whether a numeric feature is finite (used by the data-integrity rule). */
function allFinite(...values: number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}

/** Whether `value` lies within an inclusive range. */
function inRange(value: number, lo: number, hi: number): boolean {
  return Number.isFinite(value) && value >= lo && value <= hi;
}

/** A fired classification rule, carrying the class it implies. */
interface ClassRule {
  rule: string;
  cls: RiskClass;
  fired: boolean;
  value: string;
}

/**
 * Evaluate every deterministic classification rule. Returns the rule outputs
 * (for evidence) and the implied risk classes.
 */
export function classify(
  f: FeatureVector,
  sub: Subscores,
  cfg: ScoringConfig,
): { classes: RiskClass[]; ruleOutputs: DeterministicRuleOutput[] } {
  const dataIntegrityIssue =
    !allFinite(
      f.oraclePrice,
      f.oracleConfidence,
      f.oracleTimestampMs,
      f.priceChange1mPct,
      f.priceChange5mPct,
      f.priceChange15mPct,
      f.realizedVolatilityPct,
      f.liquidityDepth,
      f.spreadBps,
      f.imbalance,
      f.utilization,
      f.exposure,
      f.currentMaxLtvBps,
    ) ||
    f.oraclePrice < 0 ||
    !inRange(f.utilization, 0, 1) ||
    !inRange(f.imbalance, -1, 1);

  const divergenceFrac =
    f.referencePrice !== undefined && Number.isFinite(f.referencePrice) && f.referencePrice !== 0
      ? Math.abs(f.oraclePrice - f.referencePrice) / Math.abs(f.referencePrice)
      : 0;

  const depegFrac =
    f.expectedPegPrice !== undefined && Number.isFinite(f.expectedPegPrice) && f.expectedPegPrice !== 0
      ? Math.abs(f.oraclePrice - f.expectedPegPrice) / Math.abs(f.expectedPegPrice)
      : 0;

  const rules: ClassRule[] = [
    {
      rule: 'flash_crash',
      cls: 'flash crash',
      fired: f.priceChange1mPct <= cfg.flashCrash1mPct || f.priceChange5mPct <= cfg.flashCrash5mPct,
      value: `1m=${f.priceChange1mPct}% 5m=${f.priceChange5mPct}%`,
    },
    {
      rule: 'oracle_staleness',
      cls: 'oracle staleness',
      fired: oracleAgeMs(f) > f.freshnessThresholdMs && Number.isFinite(f.freshnessThresholdMs),
      value: `ageMs=${oracleAgeMs(f)} thresholdMs=${f.freshnessThresholdMs}`,
    },
    {
      rule: 'oracle_divergence',
      cls: 'oracle divergence',
      fired: divergenceFrac >= cfg.oracleDivergenceFullRiskFraction,
      value: `divergence=${(divergenceFrac * 100).toFixed(4)}%`,
    },
    {
      rule: 'stablecoin_depeg',
      cls: 'stablecoin depeg',
      fired:
        f.expectedPegPrice !== undefined &&
        Number.isFinite(f.expectedPegPrice) &&
        depegFrac >= cfg.depegFraction,
      value: `depeg=${(depegFrac * 100).toFixed(4)}%`,
    },
    {
      rule: 'liquidity_collapse',
      cls: 'liquidity collapse',
      fired:
        f.liquidityDepth < cfg.liquidityCollapseDepthFraction * cfg.liquidityBaselineDepth ||
        f.spreadBps >= cfg.liquidityCollapseSpreadBps,
      value: `depth=${f.liquidityDepth} spreadBps=${f.spreadBps}`,
    },
    {
      rule: 'liquidation_cascade',
      cls: 'liquidation cascade',
      fired:
        f.utilization >= cfg.liquidationCascadeUtilization &&
        Math.abs(f.priceChange5mPct) >= cfg.liquidationCascadeMovePct,
      value: `utilization=${f.utilization} 5m=${f.priceChange5mPct}%`,
    },
    {
      rule: 'high_utilization',
      cls: 'high utilization',
      fired: f.utilization >= cfg.highUtilization,
      value: `utilization=${f.utilization}`,
    },
    {
      rule: 'governance_override',
      cls: 'governance override',
      fired: f.priorOverridesCount > 0 || !f.policyActive,
      value: `priorOverrides=${f.priorOverridesCount} policyActive=${f.policyActive}`,
    },
    {
      rule: 'guardian_revocation',
      cls: 'guardian revocation',
      fired: f.guardianRevoked,
      value: `guardianRevoked=${f.guardianRevoked}`,
    },
    {
      rule: 'data_integrity',
      cls: 'data integrity',
      fired: dataIntegrityIssue,
      value: dataIntegrityIssue ? 'non-finite or out-of-domain feature detected' : 'ok',
    },
  ];

  const ruleOutputs: DeterministicRuleOutput[] = rules.map((r) => ({
    rule: r.rule,
    fired: r.fired,
    value: r.value,
  }));

  // De-duplicate fired classes preserving canonical order.
  const classes: RiskClass[] = [];
  for (const r of rules) {
    if (r.fired && !classes.includes(r.cls)) classes.push(r.cls);
  }

  // Guarantee a non-empty subset: when no specific hazard fires, classify by
  // the dominant feature group so the evaluation always carries a class. (Req 6.4)
  if (classes.length === 0) {
    classes.push(dominantClass(sub));
  }

  return { classes, ruleOutputs };
}

/** Map the highest-scoring feature group to a representative risk class. */
function dominantClass(sub: Subscores): RiskClass {
  const entries: Array<{ score: number; cls: RiskClass }> = [
    { score: sub.oracle, cls: 'oracle staleness' },
    { score: sub.volatility, cls: 'flash crash' },
    { score: sub.liquidity, cls: 'liquidity collapse' },
    { score: sub.exposure, cls: 'high utilization' },
    { score: sub.governance, cls: 'governance override' },
  ];
  // Stable: pick the first max in this fixed order.
  let best = { score: sub.oracle, cls: 'oracle staleness' as RiskClass };
  for (const e of entries) {
    if (e.score > best.score) best = e;
  }
  return best.cls;
}

/** Anomaly detection: a short-term move far exceeding recent realized vol. */
export function detectAnomaly(f: FeatureVector, cfg: ScoringConfig): { isAnomaly: boolean; ratio: number } {
  const move = Math.max(Math.abs(f.priceChange1mPct), Math.abs(f.priceChange5mPct));
  const vol = Math.abs(f.realizedVolatilityPct);
  if (!Number.isFinite(move)) return { isAnomaly: true, ratio: Infinity };
  if (vol <= 0 || !Number.isFinite(vol)) {
    // No baseline volatility: any non-trivial move is anomalous.
    return { isAnomaly: move > 0, ratio: move > 0 ? Infinity : 0 };
  }
  const ratio = move / vol;
  return { isAnomaly: ratio >= cfg.anomalyMoveToVolRatio, ratio };
}

/**
 * Select the recommended action from the band, classes, and anomaly signal —
 * deterministically. When several actions are warranted, the highest-priority
 * (lowest {@link ACTION_PRIORITY}) is returned. Returns null when no mitigation
 * is warranted (Normal/Warning without anomaly). The fail-closed layer (7.7)
 * may later null this out for refusals. (Req 6.11, 7.10)
 */
export function selectRecommendedAction(
  band: RiskBand,
  _classes: RiskClass[],
  anomaly: { isAnomaly: boolean },
): ActionType | null {
  const candidates: ActionType[] = [];

  switch (band) {
    case 'EmergencyPause':
      candidates.push('pause_new_borrows');
      break;
    case 'ParamAdjust':
      // A bounded parameter adjustment. The demo market de-risks a brewing
      // cascade or elevated risk by reducing the max LTV (tightening new-borrow
      // leverage) — an executable, reversible mitigation.
      candidates.push('reduce_max_ltv');
      break;
    case 'Guarded':
      candidates.push('enter_guarded_mode');
      break;
    case 'Warning':
      // Below the standard action threshold, but a detected anomaly warrants a
      // precautionary guarded mode.
      if (anomaly.isAnomaly) candidates.push('enter_guarded_mode');
      break;
    case 'Normal':
    default:
      break;
  }

  if (candidates.length === 0) return null;
  // Highest priority (lowest number) first.
  return candidates.reduce((best, a) => (ACTION_PRIORITY[a] < ACTION_PRIORITY[best] ? a : best));
}

/**
 * Deterministic confidence in [0, 100]. Starts high and is reduced by data
 * integrity problems, oracle staleness, a wide confidence interval, and
 * disagreement among the feature groups. (Req 6.5)
 */
export function computeConfidence(
  f: FeatureVector,
  sub: Subscores,
  cfg: ScoringConfig,
  dataIntegrityFired: boolean,
): number {
  let confidence = 100;

  if (dataIntegrityFired) confidence -= 40;

  const staleFrac = saturatingFraction(oracleAgeMs(f), f.freshnessThresholdMs);
  confidence -= Math.round(staleFrac * 30);

  const price = Math.abs(f.oraclePrice);
  const confRatio = price > 0 ? f.oracleConfidence / price : f.oracleConfidence !== 0 ? Infinity : 0;
  const confFrac = saturatingFraction(confRatio, cfg.oracleConfidenceFullRiskRatio);
  confidence -= Math.round(confFrac * 20);

  // Disagreement among subscores lowers confidence in the aggregate.
  const values = [sub.oracle, sub.volatility, sub.liquidity, sub.exposure, sub.governance];
  const spread = Math.max(...values) - Math.min(...values);
  confidence -= Math.round((spread / 100) * 20);

  return Math.round(clampScore(confidence));
}

// ---------------------------------------------------------------------------
// Engine assembly
// ---------------------------------------------------------------------------

/**
 * The deterministic core of a single evaluation, independent of marketId and of
 * the AI explanation. Exposed for direct testing and reuse by the fail-closed
 * layer (task 7.7).
 */
export interface RiskAssessment {
  riskScore: number;
  band: RiskBand;
  classes: RiskClass[];
  recommendedAction: ActionType | null;
  confidence: number;
  ruleOutputs: DeterministicRuleOutput[];
  subscores: Subscores;
  anomaly: { isAnomaly: boolean; ratio: number };
}

/** Run the full deterministic assessment for a feature vector. */
export function assessRisk(f: FeatureVector, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): RiskAssessment {
  const subscores = computeSubscores(f, cfg);
  const riskScore = aggregateScore(subscores, cfg);
  const band = assignBand(riskScore);
  const { classes, ruleOutputs } = classify(f, subscores, cfg);
  const anomaly = detectAnomaly(f, cfg);
  const recommendedAction = selectRecommendedAction(band, classes, anomaly);
  const dataIntegrityFired = ruleOutputs.find((r) => r.rule === 'data_integrity')?.fired ?? false;
  const confidence = computeConfidence(f, subscores, cfg, dataIntegrityFired);

  return { riskScore, band, classes, recommendedAction, confidence, ruleOutputs, subscores, anomaly };
}

/**
 * Deterministic Risk_Engine. Computes the gating outputs with no LLM in the
 * path and records the model version, prompt/config version, and feature vector
 * per evaluation. (Req 6.11, 6.12, 6.13)
 *
 * The `explanation` is intentionally left as an empty placeholder — the AI
 * Explanation Service (task 7.5) fills it from the deterministic outputs and can
 * never alter the score, band, classes, or recommended action. The fail-closed
 * refusal / stale-data logic (task 7.7) wraps `evaluate` to override
 * `recommendedAction`/`refusalReason` where required.
 */
export class DeterministicRiskEngine implements RiskEngine {
  private readonly cfg: ScoringConfig;

  constructor(config: Partial<ScoringConfig> = {}) {
    this.cfg = { ...DEFAULT_SCORING_CONFIG, ...config };
  }

  /** Synchronous core; useful for tests and composition. */
  evaluateSync(marketId: string, features: FeatureVector): RiskEvaluation {
    const a = assessRisk(features, this.cfg);
    return {
      marketId,
      riskScore: a.riskScore,
      band: a.band,
      classes: a.classes,
      recommendedAction: a.recommendedAction,
      confidence: a.confidence,
      explanation: '', // filled by the AI Explanation Service (task 7.5)
      ruleOutputs: a.ruleOutputs,
      modelVersion: this.cfg.modelVersion,
      promptConfigVersion: this.cfg.promptConfigVersion,
      featureVector: features,
    };
  }

  async evaluate(marketId: string, features: FeatureVector): Promise<RiskEvaluation> {
    return this.evaluateSync(marketId, features);
  }
}
