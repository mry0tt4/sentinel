/**
 * Risk Engine domain types (deterministic scoring core).
 *
 * These types model the inputs and outputs of the Sentinel Risk_Engine's
 * deterministic gating path. The score, band, classes, recommended action, and
 * confidence are computed by reproducible rules + anomaly detection — never by
 * a language model. The LLM only fills in the human-readable `explanation`
 * later (task 7.5); the fail-closed refusal / stale-data logic (task 7.7) and
 * the model/prompt version registry (task 7.10) layer on top of this core
 * without changing it.
 *
 * Mirrors the `RiskEngine` / `RiskEvaluation` interfaces in the design's
 * "Backend Services and Interfaces" section and the `risk_snapshots` columns in
 * `backend/src/db/types.ts`. (Requirements 6.1–6.4, 6.11, 6.12, 6.13)
 */

/**
 * Status bands partitioning the `[0, 100]` risk score into exactly one of five
 * disjoint ranges. (Req 6.3)
 *
 *  - `Normal`        → 0–39
 *  - `Warning`       → 40–59
 *  - `Guarded`       → 60–74  (guarded mode recommended)
 *  - `ParamAdjust`   → 75–89  (parameter adjustment recommended)
 *  - `EmergencyPause`→ 90–100 (emergency pause recommended)
 */
export type RiskBand = 'Normal' | 'Warning' | 'Guarded' | 'ParamAdjust' | 'EmergencyPause';

/**
 * The closed set of risk classes the engine may assign. A completed evaluation
 * always produces a non-empty subset of these. (Req 6.4)
 */
export type RiskClass =
  | 'flash crash'
  | 'oracle staleness'
  | 'oracle divergence'
  | 'stablecoin depeg'
  | 'liquidity collapse'
  | 'liquidation cascade'
  | 'high utilization'
  | 'governance override'
  | 'guardian revocation'
  | 'data integrity';

/** All risk classes, in canonical order (useful for tests/iteration). */
export const RISK_CLASSES: readonly RiskClass[] = [
  'flash crash',
  'oracle staleness',
  'oracle divergence',
  'stablecoin depeg',
  'liquidity collapse',
  'liquidation cascade',
  'high utilization',
  'governance override',
  'guardian revocation',
  'data integrity',
] as const;

/**
 * Bounded autonomous mitigation actions the engine may recommend. These mirror
 * the on-chain action types and the executor's priority ordering: pause is
 * priority zero, then LTV reduction, then guarded mode, then a margin increase.
 * (Req 7.1, 7.2, 7.10)
 */
export type ActionType =
  | 'pause_new_borrows'
  | 'reduce_max_ltv'
  | 'enter_guarded_mode'
  | 'increase_maintenance_margin';

/**
 * Action priority — lower number = higher priority. `pause_new_borrows` is
 * priority zero. Used when more than one action is warranted so the most severe
 * mitigation is selected first. (Req 7.10)
 */
export const ACTION_PRIORITY: Record<ActionType, number> = {
  pause_new_borrows: 0,
  reduce_max_ltv: 1,
  enter_guarded_mode: 2,
  increase_maintenance_margin: 3,
};

/**
 * The complete input to a single risk evaluation. Every field in Req 6.1 is
 * represented. Oracle reads and price metrics are numeric here; the fail-closed
 * layer (task 7.7) wraps this with absent/unparseable detection without
 * altering the scoring core.
 */
export interface FeatureVector {
  // --- Oracle (freshness/staleness, confidence interval, divergence) -------
  /** Current oracle price (quote units). */
  oraclePrice: number;
  /** Oracle confidence interval, absolute, same units as price. Wider = riskier. */
  oracleConfidence: number;
  /** Oracle publish time, ms since epoch. */
  oracleTimestampMs: number;
  /** Evaluation reference time, ms since epoch (used to derive staleness age). */
  nowMs: number;
  /** Configured oracle freshness threshold for this market, in ms. */
  freshnessThresholdMs: number;
  /** Optional independent reference price for divergence detection. */
  referencePrice?: number;
  /** Optional expected peg (e.g. 1.0 for a stablecoin) for depeg detection. */
  expectedPegPrice?: number;

  // --- Volatility (1m/5m/15m changes, realized volatility) -----------------
  /** Signed percentage price change over the last 1 minute. */
  priceChange1mPct: number;
  /** Signed percentage price change over the last 5 minutes. */
  priceChange5mPct: number;
  /** Signed percentage price change over the last 15 minutes. */
  priceChange15mPct: number;
  /** Realized volatility, expressed as a percentage magnitude. */
  realizedVolatilityPct: number;

  // --- Liquidity (depth, spread, imbalance) --------------------------------
  /** Available liquidity depth (quote units). Lower = riskier. */
  liquidityDepth: number;
  /** Bid/ask spread in basis points. Higher = riskier. */
  spreadBps: number;
  /** Order-book imbalance in [-1, 1]; magnitude is the risk signal. */
  imbalance: number;

  // --- Protocol exposure (utilization, exposure, current max LTV) ----------
  /** Utilization ratio in [0, 1]. */
  utilization: number;
  /** Total protocol exposure (quote units). */
  exposure: number;
  /** Current max LTV in basis points. */
  currentMaxLtvBps: number;

  // --- Governance / config (policy state, prior overrides, revocation) -----
  /** Whether new borrows are currently paused. */
  borrowPaused: boolean;
  /** Whether the market is currently in guarded mode. */
  guardedMode: boolean;
  /** Whether the governing Risk_Policy is active/healthy. */
  policyActive: boolean;
  /** Whether the GuardianCap for this market is revoked. */
  guardianRevoked: boolean;
  /** Count of prior autonomous actions taken on this market. */
  priorActionsCount: number;
  /** Count of prior DAO overrides applied to this market. */
  priorOverridesCount: number;
  /** Historical Walrus evidence references (blob ids) for context. */
  historicalEvidenceRefs: string[];
}

/**
 * A single deterministic rule's output. Matches the `deterministicRuleOutputs`
 * shape in the Evidence_Bundle ({ rule, fired, value }). `value` is stringified
 * so it serializes cleanly into evidence JSON. (Req 6.11, 10.1)
 */
export interface DeterministicRuleOutput {
  /** Stable rule identifier. */
  rule: string;
  /** Whether the rule's condition was met for this evaluation. */
  fired: boolean;
  /** Human/serialization-friendly description of the observed value. */
  value: string;
}

/**
 * The full result of a risk evaluation. Matches the design's `RiskEvaluation`.
 * `explanation` is a placeholder here ('') — the AI Explanation Service fills it
 * in task 7.5. `recommendedAction` is the deterministic candidate; the
 * fail-closed layer (task 7.7) may null it out and set `refusalReason`.
 */
export interface RiskEvaluation {
  marketId: string;
  /** Integer in [0, 100]. (Req 6.2) */
  riskScore: number;
  /** Exactly one band. (Req 6.3) */
  band: RiskBand;
  /** Non-empty subset of {@link RISK_CLASSES}. (Req 6.4) */
  classes: RiskClass[];
  /** Recommended action, or null when no action is warranted/permitted. */
  recommendedAction: ActionType | null;
  /** Set when `recommendedAction` is null due to a refusal (task 7.7). */
  refusalReason?: string;
  /** Integer in [0, 100]. (Req 6.5) */
  confidence: number;
  /** Plain-language explanation (<=1000 chars). Filled by the AI service (7.5). */
  explanation: string;
  /** All deterministic rule outputs evaluated for this assessment. */
  ruleOutputs: DeterministicRuleOutput[];
  /** Risk model version. (Req 6.12) */
  modelVersion: string;
  /** Prompt/config version. (Req 6.12) */
  promptConfigVersion: string;
  /** The exact feature vector evaluated. (Req 6.12) */
  featureVector: FeatureVector;
}

/**
 * The `RiskEngine` service contract (design "Backend Services and Interfaces").
 */
export interface RiskEngine {
  evaluate(marketId: string, features: FeatureVector): Promise<RiskEvaluation>;
}
