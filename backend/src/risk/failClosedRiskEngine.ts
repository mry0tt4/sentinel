/**
 * Fail-closed refusal & stale-data emergency layer (task 7.7).
 *
 * This module *wraps* the deterministic scoring engine without touching the
 * gating core. The deterministic engine (`scoringEngine.ts`) produces a
 * candidate `RiskEvaluation`; this layer then enforces the reliability
 * principle that Sentinel **fails closed** — under any uncertainty it blocks
 * autonomous action rather than acting on bad data — and adds the single
 * *escalation* the requirements call for (stale-but-present oracle data with
 * policy permission becomes an emergency pause). (Req 6.6–6.10, 6.14, 17.1, 17.2)
 *
 * It never recomputes the score, band, classes, or confidence — it only
 * post-processes `recommendedAction` / `refusalReason` and, for the stale-data
 * escalation, records a justification. The deterministic outputs remain the
 * authoritative, reproducible record. (Req 6.11, 6.13)
 *
 * ---------------------------------------------------------------------------
 * PRECEDENCE (evaluated top to bottom; the first matching rule decides).
 *
 *   1. Evaluation incomplete (Req 17.2)        → REFUSE (null + reason)
 *   2. Oracle data absent/unparseable (Req 6.7) → REFUSE (null + reason)
 *   3. Network is not Sui Testnet (Req 6.8/17.1)→ REFUSE (null + reason)
 *   4. GuardianCap revoked (Req 6.9)            → REFUSE (null + reason)
 *   5. Oracle stale AND policy permits a stale  → ESCALATE to an emergency
 *      emergency pause (Req 6.14)                 `pause_new_borrows` + recorded
 *                                                 stale-data justification
 *   6. Recommended action exceeds policy bounds → REFUSE that action
 *      (Req 6.10)                                 (null + reason)
 *   7. Otherwise                                → PASS the deterministic
 *                                                 recommendation through unchanged
 *
 * Why this order:
 *   - The hard refusals (1–4) are absolute: without trustworthy oracle data,
 *     the correct network, or a live guardian capability, the agent must not
 *     act *at all* — not even to pause. A revoked guardian would be rejected
 *     on-chain regardless, so refusing here mirrors the chain. (Req 17.7, 17.8)
 *   - Missing/unparseable oracle data (2) is deliberately ordered *above* the
 *     stale-data escalation (5): if we cannot even parse the oracle reading we
 *     cannot trust its age either, so we refuse rather than escalate.
 *   - Stale-but-present data (5) is the one *escalation*: a fresh-enough score
 *     is unavailable, but the policy has pre-authorised an emergency pause for
 *     exactly this case, and pausing is the most conservative (fail-safe)
 *     action. Because the policy permits this pause, the generic bounds check
 *     (6) is moot for it, so the escalation is ordered above (6).
 *   - The bounds refusal (6) applies only to a normally-recommended action that
 *     would exceed the policy's caps or fall outside its allowed action set.
 */

import type {
  ActionType,
  DeterministicRuleOutput,
  FeatureVector,
  RiskClass,
  RiskEvaluation,
} from './types.js';

// ---------------------------------------------------------------------------
// Guard context types
// ---------------------------------------------------------------------------

/**
 * Presence / parseability of the oracle reading. The deterministic core coerces
 * numbers defensively; this layer needs to know whether the *raw* oracle price,
 * confidence, and timestamp were all present and parseable before coercion.
 * (Req 6.7)
 */
export interface OracleAvailability {
  /** True only when price, confidence, AND timestamp are all present & parseable. */
  present: boolean;
  /** Optional human-readable detail naming the absent/unparseable field(s). */
  detail?: string;
}

/**
 * The Risk_Policy bounds relevant to validating a recommended action. Caps are
 * optional: when a cap is undefined it is treated as "no cap configured" and is
 * not enforced here (the on-chain policy remains the ultimate authority). The
 * `allowedActions` set is the policy's permitted action scope. (Req 6.10)
 */
export interface PolicyActionBounds {
  /** Action types the policy permits the agent to take. */
  allowedActions: ActionType[];
  /** Cap on a max-LTV reduction magnitude, in bps. */
  maxLtvDeltaBps?: number;
  /** Cap on a maintenance-margin increase magnitude, in bps. */
  maxMarginDeltaBps?: number;
  /** Cap on a pause duration, in ms. */
  pauseDurationLimitMs?: number;
}

/**
 * The proposed magnitude of the deterministic recommended action, compared
 * against {@link PolicyActionBounds}. Only the field relevant to the action is
 * read; absent magnitudes are treated as "within bounds". (Req 6.10)
 */
export interface ProposedActionMagnitude {
  /** Proposed LTV reduction, in bps (for `reduce_max_ltv`). */
  ltvDeltaBps?: number;
  /** Proposed maintenance-margin increase, in bps (for `increase_maintenance_margin`). */
  marginDeltaBps?: number;
  /** Proposed pause duration, in ms (for `pause_new_borrows`). */
  pauseDurationMs?: number;
}

/**
 * Everything the fail-closed layer needs that is *not* already captured by the
 * deterministic `RiskEvaluation`. Supplied by the Action_Engine / workers that
 * know the live network, capability state, and policy.
 */
export interface FailClosedGuardContext {
  /**
   * Whether the deterministic evaluation completed successfully. Defaults to
   * `true`. Set to `false` to force a fail-closed refusal when the engine could
   * not produce a trustworthy assessment. (Req 17.2)
   */
  evaluationComplete?: boolean;
  /** Oracle price/confidence/timestamp presence & parseability. (Req 6.7) */
  oracle: OracleAvailability;
  /** Whether the active network is Sui Testnet. (Req 6.8, 17.1) */
  isSuiTestnet: boolean;
  /** Whether the GuardianCap for the market is revoked. (Req 6.9) */
  guardianRevoked: boolean;
  /** Policy bounds used to validate the recommended action. (Req 6.10) */
  policy: PolicyActionBounds;
  /** Proposed magnitude of the recommended action, for bound comparison. (Req 6.10) */
  proposedMagnitude?: ProposedActionMagnitude;
  /** Oracle reading age in ms (now − oracleTimestamp). (Req 6.14) */
  oracleAgeMs: number;
  /** The market's configured oracle freshness threshold, in ms. (Req 6.14) */
  freshnessThresholdMs: number;
  /** Whether policy permits an emergency stale-data pause. (Req 6.14) */
  policyPermitsStalePause: boolean;
}

// ---------------------------------------------------------------------------
// Decision result
// ---------------------------------------------------------------------------

/** The action priority-zero emergency pause used by the stale-data escalation. */
const EMERGENCY_PAUSE: Extract<ActionType, 'pause_new_borrows'> = 'pause_new_borrows';

/**
 * The pure outcome of the fail-closed decision, independent of the surrounding
 * `RiskEvaluation`. Exposed for direct, exhaustive testing (and reused by the
 * property tests in tasks 7.8 / 7.9).
 */
export type FailClosedDecision =
  | { kind: 'pass'; action: ActionType | null }
  | { kind: 'refuse'; action: null; refusalReason: string }
  | { kind: 'stale_pause'; action: typeof EMERGENCY_PAUSE; justification: string };

/**
 * A `RiskEvaluation` after the fail-closed layer has run. Identical to a
 * `RiskEvaluation` except for an optional `staleDataJustification` recorded when
 * the recommendation was escalated to an emergency stale-data pause. The base
 * `RiskEvaluation` type is intentionally left unchanged. (Req 6.14)
 */
export interface GuardedRiskEvaluation extends RiskEvaluation {
  /** Recorded justification when the action was escalated to a stale-data pause. */
  staleDataJustification?: string;
}

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

/** Whether an oracle age strictly exceeds a freshness threshold (finite-safe). */
export function isOracleStale(oracleAgeMs: number, freshnessThresholdMs: number): boolean {
  return (
    Number.isFinite(oracleAgeMs) &&
    Number.isFinite(freshnessThresholdMs) &&
    oracleAgeMs > freshnessThresholdMs
  );
}

/**
 * Determine whether `action` exceeds the policy bounds or falls outside the
 * policy's allowed action scope. Returns `{ exceeded: true, reason }` with a
 * descriptive reason on violation. (Req 6.10)
 */
export function exceedsPolicyBounds(
  action: ActionType,
  policy: PolicyActionBounds,
  magnitude: ProposedActionMagnitude = {},
): { exceeded: boolean; reason?: string } {
  if (!policy.allowedActions.includes(action)) {
    const allowed = policy.allowedActions.length > 0 ? policy.allowedActions.join(', ') : 'none';
    return {
      exceeded: true,
      reason: `recommended action "${action}" is outside the policy's allowed actions (${allowed})`,
    };
  }

  switch (action) {
    case 'reduce_max_ltv':
      if (
        policy.maxLtvDeltaBps !== undefined &&
        magnitude.ltvDeltaBps !== undefined &&
        magnitude.ltvDeltaBps > policy.maxLtvDeltaBps
      ) {
        return {
          exceeded: true,
          reason: `max-LTV reduction of ${magnitude.ltvDeltaBps}bps exceeds policy cap of ${policy.maxLtvDeltaBps}bps`,
        };
      }
      break;
    case 'increase_maintenance_margin':
      if (
        policy.maxMarginDeltaBps !== undefined &&
        magnitude.marginDeltaBps !== undefined &&
        magnitude.marginDeltaBps > policy.maxMarginDeltaBps
      ) {
        return {
          exceeded: true,
          reason: `maintenance-margin increase of ${magnitude.marginDeltaBps}bps exceeds policy cap of ${policy.maxMarginDeltaBps}bps`,
        };
      }
      break;
    case 'pause_new_borrows':
      if (
        policy.pauseDurationLimitMs !== undefined &&
        magnitude.pauseDurationMs !== undefined &&
        magnitude.pauseDurationMs > policy.pauseDurationLimitMs
      ) {
        return {
          exceeded: true,
          reason: `pause duration of ${magnitude.pauseDurationMs}ms exceeds policy limit of ${policy.pauseDurationLimitMs}ms`,
        };
      }
      break;
    case 'enter_guarded_mode':
      // No magnitude bound for guarded mode; only the allowed-action scope above
      // applies.
      break;
  }

  return { exceeded: false };
}

/**
 * The core fail-closed decision. Applies the documented precedence to the
 * deterministic `candidate` action and the guard context, returning a pure
 * {@link FailClosedDecision}. No `RiskEvaluation` mutation happens here. (Req
 * 6.7–6.10, 6.14, 17.1, 17.2)
 */
export function decideFailClosed(
  candidate: ActionType | null,
  ctx: FailClosedGuardContext,
): FailClosedDecision {
  // 1. Evaluation incomplete — fail closed. (Req 17.2)
  if (ctx.evaluationComplete === false) {
    return {
      kind: 'refuse',
      action: null,
      refusalReason: 'risk evaluation did not complete; refusing to recommend an action (fail-closed)',
    };
  }

  // 2. Oracle price/confidence/timestamp absent or unparseable. (Req 6.7)
  if (!ctx.oracle.present) {
    const detail = ctx.oracle.detail ? `: ${ctx.oracle.detail}` : '';
    return {
      kind: 'refuse',
      action: null,
      refusalReason: `oracle price, confidence, or timestamp is absent or unparseable${detail}`,
    };
  }

  // 3. Active network is not Sui Testnet. (Req 6.8, 17.1)
  if (!ctx.isSuiTestnet) {
    return {
      kind: 'refuse',
      action: null,
      refusalReason: 'active network is not Sui Testnet; refusing to recommend an action (fail-closed)',
    };
  }

  // 4. GuardianCap is revoked. (Req 6.9)
  if (ctx.guardianRevoked) {
    return {
      kind: 'refuse',
      action: null,
      refusalReason: 'GuardianCap for the market is revoked; refusing to recommend an autonomous action',
    };
  }

  // 5. Stale-but-present oracle data with policy permission → emergency pause. (Req 6.14)
  const stale = isOracleStale(ctx.oracleAgeMs, ctx.freshnessThresholdMs);
  if (stale && ctx.policyPermitsStalePause) {
    return {
      kind: 'stale_pause',
      action: EMERGENCY_PAUSE,
      justification:
        `oracle reading age ${ctx.oracleAgeMs}ms exceeds the configured freshness threshold ` +
        `${ctx.freshnessThresholdMs}ms; policy permits an emergency stale-data pause, ` +
        `recommending ${EMERGENCY_PAUSE}`,
    };
  }

  // 6. Recommended action would exceed policy bounds. (Req 6.10)
  if (candidate !== null) {
    const bounds = exceedsPolicyBounds(candidate, ctx.policy, ctx.proposedMagnitude);
    if (bounds.exceeded) {
      return {
        kind: 'refuse',
        action: null,
        refusalReason: `recommended action exceeds Risk_Policy bounds — ${bounds.reason}`,
      };
    }
  }

  // 7. Pass the deterministic recommendation through unchanged.
  return { kind: 'pass', action: candidate };
}

// ---------------------------------------------------------------------------
// Evaluation wrapper
// ---------------------------------------------------------------------------

/** Synthetic rule id recorded when the action is escalated to a stale-data pause. */
export const STALE_DATA_PAUSE_RULE = 'stale_data_emergency_pause';

/**
 * Apply the fail-closed decision to a deterministic `RiskEvaluation`, returning
 * a {@link GuardedRiskEvaluation}. The score, band, classes, confidence, and
 * recorded versions are never altered — only `recommendedAction`,
 * `refusalReason`, `staleDataJustification`, and (for the stale escalation) an
 * appended deterministic rule output for the evidence trail. (Req 6.6, 6.7–6.10,
 * 6.14, 17.1, 17.2)
 */
export function applyFailClosed(
  evaluation: RiskEvaluation,
  ctx: FailClosedGuardContext,
): GuardedRiskEvaluation {
  const decision = decideFailClosed(evaluation.recommendedAction, ctx);

  switch (decision.kind) {
    case 'refuse':
      return {
        ...evaluation,
        recommendedAction: null,
        refusalReason: decision.refusalReason,
      };
    case 'stale_pause': {
      const staleRule: DeterministicRuleOutput = {
        rule: STALE_DATA_PAUSE_RULE,
        fired: true,
        value: decision.justification,
      };
      return {
        ...evaluation,
        recommendedAction: decision.action,
        // Positive recommendation — clear any inherited refusal reason.
        refusalReason: undefined,
        staleDataJustification: decision.justification,
        ruleOutputs: [...evaluation.ruleOutputs, staleRule],
      };
    }
    case 'pass':
    default:
      // Unchanged pass-through: preserve the deterministic recommendation and
      // leave refusalReason untouched.
      return { ...evaluation };
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the fail-closed refusal returned when the deterministic engine throws
 * (fails to complete an evaluation). The numeric fields are non-authoritative
 * placeholders — consumers MUST check `refusalReason` before trusting any field
 * — and the action is `null` so no autonomous action can proceed. (Req 17.2)
 */
function engineFailureRefusal(
  marketId: string,
  features: FeatureVector,
  detail: string,
): GuardedRiskEvaluation {
  const dataIntegrity: RiskClass = 'data integrity';
  return {
    marketId,
    riskScore: 0,
    band: 'Normal',
    classes: [dataIntegrity],
    recommendedAction: null,
    refusalReason: `risk evaluation did not complete; refusing to recommend an action (fail-closed): ${detail}`,
    confidence: 0,
    explanation: '',
    ruleOutputs: [{ rule: 'evaluation_incomplete', fired: true, value: detail }],
    modelVersion: 'unknown',
    promptConfigVersion: 'unknown',
    featureVector: features,
  };
}

/** Minimal surface of the deterministic engine the fail-closed layer composes over. */
export interface InnerRiskEngine {
  evaluateSync(marketId: string, features: FeatureVector): RiskEvaluation;
}

/**
 * Fail-closed Risk_Engine. Composes over the deterministic engine: it runs the
 * deterministic assessment, then applies the fail-closed refusal / stale-data
 * escalation layer. If the inner engine throws (fails to complete), it returns a
 * fail-closed refusal rather than propagating the error. (Req 17.2)
 *
 * The deterministic gating core is never modified — this engine only wraps it.
 */
export class FailClosedRiskEngine {
  constructor(private readonly inner: InnerRiskEngine) {}

  /**
   * Evaluate a market and apply the fail-closed layer. `ctx` supplies the live
   * network, capability, freshness, and policy signals the deterministic core
   * does not own.
   */
  evaluate(
    marketId: string,
    features: FeatureVector,
    ctx: FailClosedGuardContext,
  ): GuardedRiskEvaluation {
    let base: RiskEvaluation;
    try {
      base = this.inner.evaluateSync(marketId, features);
    } catch (err) {
      return engineFailureRefusal(marketId, features, errorMessage(err));
    }
    return applyFailClosed(base, ctx);
  }
}
