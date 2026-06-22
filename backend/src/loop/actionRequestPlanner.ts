/**
 * Default {@link ActionRequestPlanner} for the live {@link RiskControlLoop}
 * (task 21.1).
 *
 * Maps a threshold-crossing {@link GuardedRiskEvaluation} to the bounded,
 * server-defined on-chain {@link ExecuteRequest} the Action Executor runs. This
 * is the live-path counterpart of
 * {@link import('../simulation/simulationService.js').SimulationService.buildExecuteRequest}:
 * it uses the same {@link ACTION_TYPE} codes and the same evidence-bearing
 * {@link ActionContext}, but is driven by worker data rather than scenario
 * steps. The on-chain object ids + agent signer come from per-market server
 * configuration — never from a client — preserving the server-defined-template
 * guarantee. (Req 9.2, 7.10, 16.4)
 *
 * The planner returns `null` (skip execution) when no on-chain template is
 * configured for the market or an injected guardian-authorization check reports
 * the GuardianCap is revoked/expired, so the loop refuses to act. (Req 12.3, 6.9)
 */

import type { ExecuteRequest } from '../action/actionExecutor.js';
import { ACTION_TYPE, type ActionTypeCode } from '../action/types.js';
import type { ActionContext } from '../evidence/types.js';
import type { GuardedRiskEvaluation } from '../risk/failClosedRiskEngine.js';
import type { ActionType, FeatureVector } from '../risk/types.js';

import type { ActionRequestPlanner } from './riskControlLoop.js';

/** On-chain object ids + signer the action template needs for a market. */
export interface MarketActionConfig {
  marketId: string;
  policyId: string;
  policyObjectId: string;
  guardianCapObjectId: string;
  marketStateObjectId: string;
  /** Public address of the agent signer (NEVER a private key). (Req 10.8) */
  agentSigner: string;
  clockObjectId?: string;
  /** Pause duration (ms) used for a recommended `pause_new_borrows`. */
  defaultPauseDurationMs?: number;
  /** LTV reduction (bps) used for a recommended `reduce_max_ltv`. */
  defaultLtvDeltaBps?: number;
  /** Maintenance-margin increase (bps) used for `increase_maintenance_margin`. */
  defaultMarginDeltaBps?: number;
}

/** The live guardian-authorization decision for a market. (Req 12.3, 6.9) */
export interface GuardianAuthorization {
  authorized: boolean;
  reason?: string;
}

/**
 * Port that decides whether the GuardianCap authorizes an autonomous action for
 * a market right now. Injected so the production wiring reads the live on-chain
 * GuardianCap state; defaults to "authorized" when omitted.
 */
export interface LiveGuardianChecker {
  check(input: { marketId: string; nowMs: number }): GuardianAuthorization | Promise<GuardianAuthorization>;
}

export interface DefaultActionRequestPlannerOptions {
  markets: MarketActionConfig[];
  guardianChecker?: LiveGuardianChecker;
  now?: () => number;
}

/** Map a deterministic recommended action to its on-chain action-type code. */
const ACTION_TYPE_CODE: Record<ActionType, ActionTypeCode> = {
  pause_new_borrows: ACTION_TYPE.PAUSE_BORROWS,
  reduce_max_ltv: ACTION_TYPE.REDUCE_LTV,
  enter_guarded_mode: ACTION_TYPE.ENTER_GUARDED,
  increase_maintenance_margin: ACTION_TYPE.INCREASE_MARGIN,
};

/** The default planner used by the production wiring. */
export class DefaultActionRequestPlanner implements ActionRequestPlanner {
  private readonly configs = new Map<string, MarketActionConfig>();
  private readonly guardianChecker?: LiveGuardianChecker;
  private readonly now: () => number;

  constructor(options: DefaultActionRequestPlannerOptions) {
    this.guardianChecker = options.guardianChecker;
    this.now = options.now ?? Date.now;
    for (const config of options.markets) {
      this.configs.set(config.marketId, config);
    }
  }

  async plan(input: {
    marketId: string;
    evaluation: GuardedRiskEvaluation;
    features: FeatureVector;
  }): Promise<ExecuteRequest | null> {
    const action = input.evaluation.recommendedAction;
    if (action === null) {
      return null;
    }
    const config = this.configs.get(input.marketId);
    if (config === undefined) {
      // No on-chain action template configured for this market → skip.
      return null;
    }

    const nowMs = input.features.nowMs;
    if (this.guardianChecker) {
      const authorization = await this.guardianChecker.check({ marketId: input.marketId, nowMs });
      if (!authorization.authorized) {
        return null;
      }
    }

    const { newParamValue, pauseDurationMs } = actionParameters(action, input.features, config);

    const actionContext: ActionContext = {
      policyId: config.policyId,
      agentSigner: config.agentSigner,
      dataSource: 'live',
      priorActionIds: [],
      executedAction: action,
      timestampMs: nowMs,
      marketId: input.marketId,
    };

    return {
      action: {
        policyObjectId: config.policyObjectId,
        guardianCapObjectId: config.guardianCapObjectId,
        marketStateObjectId: config.marketStateObjectId,
        actionType: ACTION_TYPE_CODE[action],
        newParamValue,
        pauseDurationMs,
        riskScore: input.evaluation.riskScore,
        ...(config.clockObjectId ? { clockObjectId: config.clockObjectId } : {}),
      },
      evaluation: input.evaluation,
      actionContext,
      actionLogId: `${input.marketId}:${this.now()}`,
    };
  }
}

/** Derive bounded numeric parameters for the chosen action. */
function actionParameters(
  action: ActionType,
  features: FeatureVector,
  config: MarketActionConfig,
): { newParamValue: number; pauseDurationMs: number } {
  switch (action) {
    case 'pause_new_borrows':
      return { newParamValue: 0, pauseDurationMs: config.defaultPauseDurationMs ?? 3_600_000 };
    case 'reduce_max_ltv': {
      const delta = config.defaultLtvDeltaBps ?? 1_000;
      const newLtv = Math.max(0, Math.round(features.currentMaxLtvBps) - delta);
      return { newParamValue: newLtv, pauseDurationMs: 0 };
    }
    case 'increase_maintenance_margin':
      return { newParamValue: config.defaultMarginDeltaBps ?? 500, pauseDurationMs: 0 };
    case 'enter_guarded_mode':
    default:
      return { newParamValue: 0, pauseDurationMs: 0 };
  }
}
