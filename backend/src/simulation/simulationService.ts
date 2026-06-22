/**
 * Simulation_Lab service (Req 14.1–14.5, 14.8, 14.9).
 *
 * The `SimulationService` runs the nine predefined risk scenarios
 * ({@link ./scenarios.ts}) against the Demo_Market. For each scenario step it
 * feeds the step's feature vector to the Risk_Engine and reports the resulting
 * risk score / band / recommendation (Req 14.2). When a step crosses an action
 * threshold AND a valid, non-revoked, non-expired GuardianCap authorizes the
 * action, it triggers the real Sui Testnet action + Walrus evidence flow via the
 * injected {@link ActionExecutorPort} (Req 14.3). When the GuardianCap is
 * revoked or expired, the action is blocked and the guardian is reported as not
 * authorized (Req 14.8). `reset()` restores the Demo_Market + scenario inputs to
 * their initial state (Req 14.5). If a real testnet action or Walrus evidence
 * storage fails, the service does NOT report a successful action and retains the
 * scenario state (Req 14.9).
 *
 * Collaborators — the Risk_Engine, the Action Executor, an optional Demo_Market
 * resetter, and the guardian-authorization checker — are injected as narrow
 * ports so unit tests drive the service with fakes (no live RPC / Walrus / DB).
 * The service implements the `SimulatorPort` contract (`start` / `reset`) used
 * by `/api/simulator/*` and additionally exposes `step()` for fine-grained
 * stepping and `getState()` for state inspection.
 */

import { randomUUID } from 'node:crypto';

import type { ExecuteRequest, ActionResult, ActionStage } from '../action/actionExecutor.js';
import { ACTION_TYPE, type ActionTypeCode } from '../action/types.js';
import type { ActionContext } from '../evidence/types.js';
import type { FailClosedGuardContext, GuardedRiskEvaluation } from '../risk/failClosedRiskEngine.js';
import type {
  ActionType,
  FeatureVector,
  RiskBand,
  RiskClass,
} from '../risk/types.js';
import {
  DEMO_MARKET_BASELINE,
  SIMULATION_SCENARIOS,
  SIMULATION_SCENARIO_IDS,
  getScenario,
  type SimulationScenario,
} from './scenarios.js';

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/**
 * Port over the (fail-closed) Risk_Engine. The concrete
 * {@link import('../risk/failClosedRiskEngine.js').FailClosedRiskEngine} is
 * directly assignable; unit tests inject a fake. (Req 14.2)
 */
export interface SimulationRiskEnginePort {
  evaluate(
    marketId: string,
    features: FeatureVector,
    guard: FailClosedGuardContext,
  ): GuardedRiskEvaluation | Promise<GuardedRiskEvaluation>;
}

/** Port over {@link import('../action/actionExecutor.js').ActionExecutor.execute}. (Req 14.3) */
export interface ActionExecutorPort {
  execute(input: ExecuteRequest): Promise<ActionResult>;
}

/**
 * Port that persists the off-chain `actions` mirror for an executed autonomous
 * action so evidence can be linked to a real action UUID (Req 9.5, 15.x) and
 * the action surfaces in the dashboard/incident timeline. Injected so unit
 * tests can omit it (and fall back to a generated id). The production wiring
 * backs it with the `ActionsRepository`.
 */
export interface SimulationActionRecorderPort {
  /**
   * Insert a pending action row BEFORE execution and return its UUID. The
   * executor's evidence-link step writes this UUID into `walrus_blobs.action_id`
   * (a real FK), so the row must exist first.
   */
  createPending(input: {
    policyId: string;
    marketId: string;
    actor: string;
    riskScore: number;
    actionType: ActionType;
    oldValue: string | null;
    newValue: string | null;
    timestampMs: number;
  }): Promise<string>;
  /** Finalize the row with the on-chain tx digest + evidence references. */
  finalize(
    id: string,
    result: { txDigest?: string; blobId?: string; evidenceHash?: string },
  ): Promise<void>;
}

/** Optional port that restores on-chain/demo-market state during a reset. (Req 14.5) */
export interface DemoMarketResetPort {
  reset(): Promise<void> | void;
}

/** The guardian authorization decision for a scenario step. (Req 14.3, 14.8) */
export interface GuardianAuthorization {
  /** True only when the GuardianCap is valid, non-revoked, AND non-expired. */
  authorized: boolean;
  /** Whether the GuardianCap is revoked. */
  revoked: boolean;
  /** Whether the GuardianCap is expired. */
  expired: boolean;
  /** Human-readable detail when not authorized. */
  reason?: string;
}

/**
 * Port that decides whether the GuardianCap authorizes an autonomous action for
 * a given scenario. Injected so tests can model revoked/expired capabilities.
 * (Req 14.3, 14.8)
 */
export interface GuardianAuthorizationChecker {
  check(input: {
    scenarioId: string;
    marketId: string;
    nowMs: number;
  }): GuardianAuthorization | Promise<GuardianAuthorization>;
}

/**
 * Default guardian checker derived from the scenario: the `guardian-revoked`
 * scenario reports a revoked capability; every other scenario authorizes the
 * action. Production wiring replaces this with a checker that reads the live
 * on-chain GuardianCap state. (Req 14.8)
 */
export function createScenarioGuardianChecker(): GuardianAuthorizationChecker {
  return {
    check({ scenarioId }) {
      if (scenarioId === 'guardian-revoked') {
        return {
          authorized: false,
          revoked: true,
          expired: false,
          reason: 'GuardianCap for the Demo_Market is revoked; the guardian is not authorized',
        };
      }
      return { authorized: true, revoked: false, expired: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** On-chain object ids + signer the action template needs for the Demo_Market. */
export interface SimulationDemoMarketConfig {
  marketId: string;
  policyId: string;
  policyObjectId: string;
  guardianCapObjectId: string;
  marketStateObjectId: string;
  /** Public address of the agent signer (NEVER a private key). */
  agentSigner: string;
  clockObjectId?: string;
  /** Pause duration (ms) used for a recommended `pause_new_borrows`. */
  defaultPauseDurationMs?: number;
  /** LTV reduction (bps) used for a recommended `reduce_max_ltv`. */
  defaultLtvDeltaBps?: number;
  /** Maintenance-margin increase (bps) used for `increase_maintenance_margin`. */
  defaultMarginDeltaBps?: number;
}

/** Risk_Policy bounds + flags the fail-closed guard context is built from. */
export interface SimulationPolicyConfig {
  allowedActions: ActionType[];
  maxLtvDeltaBps?: number;
  maxMarginDeltaBps?: number;
  pauseDurationLimitMs?: number;
  /** Whether policy permits an emergency stale-data pause. (Req 6.14) */
  permitStalePause: boolean;
}

/** Default policy config: all bounded actions permitted, generous caps. */
export const DEFAULT_SIMULATION_POLICY: SimulationPolicyConfig = Object.freeze({
  allowedActions: [
    'pause_new_borrows',
    'reduce_max_ltv',
    'enter_guarded_mode',
    'increase_maintenance_margin',
  ] as ActionType[],
  maxLtvDeltaBps: 5_000,
  maxMarginDeltaBps: 5_000,
  pauseDurationLimitMs: 7 * 24 * 60 * 60 * 1000,
  permitStalePause: true,
});

export interface SimulationServiceOptions {
  riskEngine: SimulationRiskEnginePort;
  actionExecutor: ActionExecutorPort;
  demoMarket: SimulationDemoMarketConfig;
  guardianChecker?: GuardianAuthorizationChecker;
  demoMarketReset?: DemoMarketResetPort;
  policy?: SimulationPolicyConfig;
  /** Optional persistence for the off-chain action mirror (Req 9.5, 15.x). */
  actionRecorder?: SimulationActionRecorderPort;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** The risk summary surfaced for a step. (Req 14.2) */
export interface StepRiskSummary {
  riskScore: number;
  band: RiskBand;
  recommendedAction: ActionType | null;
  refusalReason?: string;
  classes: RiskClass[];
  confidence: number;
}

/** Outcome of attempting (or blocking) the action at a threshold-crossing step. */
export interface ActionOutcome {
  /** Whether the action flow was actually invoked (false when blocked). */
  attempted: boolean;
  /** True when blocked because the guardian is not authorized. (Req 14.8) */
  blocked: boolean;
  /** Reason the action was blocked (guardian not authorized). */
  blockedReason?: string;
  /** True only when a real testnet action + Walrus evidence succeeded. (Req 14.3) */
  success: boolean;
  txDigest?: string;
  blobId?: string;
  evidenceHash?: string;
  /** Stage the action flow reached (from the Action Executor). */
  stage?: ActionStage;
  /** Failure detail when the action/evidence flow failed. (Req 14.9) */
  failureReason?: string;
}

/** The result of evaluating a single scenario step. */
export interface ScenarioStepOutcome {
  scenarioId: string;
  stepIndex: number;
  stepLabel: string;
  totalSteps: number;
  /** The cumulative feature vector evaluated for this step (simulated data). */
  features: FeatureVector;
  /** The Risk_Engine result for this step. (Req 14.2) */
  risk: StepRiskSummary;
  /** Whether this step crossed an action threshold (recommended an action). */
  thresholdCrossed: boolean;
  /** The guardian authorization decision (present once a threshold is crossed). */
  guardian?: GuardianAuthorization;
  /** The action outcome (present once a threshold is crossed). */
  action?: ActionOutcome;
}

/** Lifecycle status of a scenario run, retained until reset. */
export type SimulationRunStatus =
  | 'running'
  | 'completed'
  | 'action_executed'
  | 'action_blocked'
  | 'action_failed';

/** The full result of starting (running) a scenario. */
export interface ScenarioRunResult {
  scenarioId: string;
  title: string;
  status: SimulationRunStatus;
  steps: ScenarioStepOutcome[];
  /** The action outcome at the climax step, when a threshold was crossed. */
  action?: ActionOutcome;
}

/** Inspectable scenario state (retained across failures; cleared on reset). */
export interface SimulationState {
  scenarioId: string;
  title: string;
  status: SimulationRunStatus;
  /** Index of the last evaluated step. */
  stepIndex: number;
  /** The feature vector at the last evaluated step. */
  features: FeatureVector;
  outcomes: ScenarioStepOutcome[];
  lastAction?: ActionOutcome;
}

/** Result of a reset. (Req 14.5) */
export interface SimulationResetResult {
  reset: true;
  /** The restored baseline Demo_Market inputs. */
  baseline: FeatureVector;
}

/** Raised when a scenario id is not one of the nine registered scenarios. */
export class UnknownScenarioError extends Error {
  constructor(scenarioId: string) {
    super(
      `Unknown scenario "${scenarioId}"; expected one of [${SIMULATION_SCENARIO_IDS.join(', ')}]`,
    );
    this.name = 'UnknownScenarioError';
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Map a deterministic recommended action to its on-chain action-type code. */
const ACTION_TYPE_CODE: Record<ActionType, ActionTypeCode> = {
  pause_new_borrows: ACTION_TYPE.PAUSE_BORROWS,
  reduce_max_ltv: ACTION_TYPE.REDUCE_LTV,
  enter_guarded_mode: ACTION_TYPE.ENTER_GUARDED,
  increase_maintenance_margin: ACTION_TYPE.INCREASE_MARGIN,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Simulation_Lab service. Implements the `SimulatorPort` contract
 * (`start` / `reset`) and adds `step()` / `getState()`.
 */
export class SimulationService {
  private readonly riskEngine: SimulationRiskEnginePort;
  private readonly actionExecutor: ActionExecutorPort;
  private readonly demoMarket: SimulationDemoMarketConfig;
  private readonly guardianChecker: GuardianAuthorizationChecker;
  private readonly demoMarketReset?: DemoMarketResetPort;
  private readonly policy: SimulationPolicyConfig;
  private readonly actionRecorder?: SimulationActionRecorderPort;

  /** Active scenario state, or null when idle. Retained until `reset()`. */
  private state: SimulationState | null = null;

  constructor(options: SimulationServiceOptions) {
    this.riskEngine = options.riskEngine;
    this.actionExecutor = options.actionExecutor;
    this.demoMarket = options.demoMarket;
    this.guardianChecker = options.guardianChecker ?? createScenarioGuardianChecker();
    this.demoMarketReset = options.demoMarketReset;
    this.policy = options.policy ?? DEFAULT_SIMULATION_POLICY;
    this.actionRecorder = options.actionRecorder;
  }

  /** The ids of all registered scenarios (exactly nine). (Req 14.1) */
  static scenarioIds(): readonly string[] {
    return SIMULATION_SCENARIO_IDS;
  }

  /** All registered scenarios. (Req 14.1) */
  static scenarios(): readonly SimulationScenario[] {
    return SIMULATION_SCENARIOS;
  }

  /** Snapshot of the current scenario state (null when idle). */
  getState(): SimulationState | null {
    return this.state;
  }

  /**
   * Start (run) a scenario. Feeds each step's inputs to the Risk_Engine and
   * stops at the first step that crosses an action threshold, where it either
   * triggers the action flow (valid guardian) or blocks it (revoked/expired
   * guardian). A scenario that never crosses a threshold (e.g.
   * `false-positive-recovery`) runs all steps and completes with no action.
   * (Req 14.2, 14.3, 14.8, 14.9)
   *
   * Implements the `SimulatorPort.start(scenarioId)` contract.
   */
  async start(scenarioId: string): Promise<ScenarioRunResult> {
    const scenario = getScenario(scenarioId);
    if (!scenario) {
      throw new UnknownScenarioError(scenarioId);
    }

    // Begin from the calm baseline (step 0). (Req 14.5 initial state)
    this.state = {
      scenarioId: scenario.id,
      title: scenario.title,
      status: 'running',
      stepIndex: 0,
      features: { ...DEMO_MARKET_BASELINE, ...(scenario.steps[0]?.inputs ?? {}) },
      outcomes: [],
    };

    const outcomes: ScenarioStepOutcome[] = [];
    let runningFeatures: FeatureVector = { ...DEMO_MARKET_BASELINE };
    let climaxAction: ActionOutcome | undefined;

    for (let i = 0; i < scenario.steps.length; i += 1) {
      const step = scenario.steps[i];
      if (!step) {
        continue;
      }
      runningFeatures = { ...runningFeatures, ...step.inputs };
      const outcome = await this.evaluateStep(scenario, i, runningFeatures);
      outcomes.push(outcome);

      // Update retained state to the latest evaluated step.
      this.state = {
        scenarioId: scenario.id,
        title: scenario.title,
        status: 'running',
        stepIndex: i,
        features: runningFeatures,
        outcomes: [...outcomes],
        lastAction: outcome.action,
      };

      if (outcome.thresholdCrossed) {
        // The first threshold crossing is the scenario's climax: attempt or
        // block the action, then stop (retaining state). (Req 14.3, 14.8, 14.9)
        climaxAction = outcome.action;
        this.state.status = this.statusForAction(outcome.action);
        break;
      }
    }

    // No threshold crossed across all steps → completed with no action.
    if (this.state.status === 'running') {
      this.state.status = 'completed';
    }

    return {
      scenarioId: scenario.id,
      title: scenario.title,
      status: this.state.status,
      steps: outcomes,
      action: climaxAction,
    };
  }

  /**
   * Reset the Demo_Market and scenario inputs to their initial state. Clears the
   * retained scenario state and (when configured) restores on-chain/demo-market
   * state via the injected reset port. (Req 14.5)
   *
   * Implements the `SimulatorPort.reset()` contract.
   */
  async reset(): Promise<SimulationResetResult> {
    if (this.demoMarketReset) {
      await this.demoMarketReset.reset();
    }
    this.state = null;
    return { reset: true, baseline: { ...DEMO_MARKET_BASELINE } };
  }

  /**
   * Evaluate a single scenario step: feed the features to the Risk_Engine, and
   * — when an action threshold is crossed — consult the guardian checker and
   * either trigger or block the action.
   */
  private async evaluateStep(
    scenario: SimulationScenario,
    stepIndex: number,
    features: FeatureVector,
  ): Promise<ScenarioStepOutcome> {
    const guard = this.buildGuardContext(features);
    const evaluation = await this.riskEngine.evaluate(this.demoMarket.marketId, features, guard);

    const risk: StepRiskSummary = {
      riskScore: evaluation.riskScore,
      band: evaluation.band,
      recommendedAction: evaluation.recommendedAction,
      refusalReason: evaluation.refusalReason,
      classes: evaluation.classes,
      confidence: evaluation.confidence,
    };

    const thresholdCrossed = evaluation.recommendedAction !== null;
    const outcome: ScenarioStepOutcome = {
      scenarioId: scenario.id,
      stepIndex,
      stepLabel: scenario.steps[stepIndex]?.label ?? `step-${stepIndex}`,
      totalSteps: scenario.steps.length,
      features,
      risk,
      thresholdCrossed,
    };

    if (!thresholdCrossed) {
      return outcome;
    }

    // Threshold crossed → check guardian authorization. (Req 14.3, 14.8)
    const guardian = await this.guardianChecker.check({
      scenarioId: scenario.id,
      marketId: this.demoMarket.marketId,
      nowMs: features.nowMs,
    });
    outcome.guardian = guardian;

    if (!guardian.authorized) {
      // Block the action and indicate the guardian is not authorized. (Req 14.8)
      outcome.action = {
        attempted: false,
        blocked: true,
        blockedReason:
          guardian.reason ??
          `guardian is not authorized (${guardian.revoked ? 'revoked' : ''}${
            guardian.expired ? ' expired' : ''
          })`.trim(),
        success: false,
      };
      return outcome;
    }

    // Authorized → trigger the real testnet action + Walrus evidence. (Req 14.3)
    outcome.action = await this.runAction(
      scenario,
      features,
      evaluation,
      evaluation.recommendedAction as ActionType,
    );
    return outcome;
  }

  /**
   * Invoke the Action Executor's full network-gated flow for a recommended
   * action. On any failure (network, evidence upload, simulation, submission,
   * link) the outcome reports `success: false` so the caller does not report a
   * successful action and the scenario state is retained. (Req 14.3, 14.9)
   */
  private async runAction(
    scenario: SimulationScenario,
    features: FeatureVector,
    evaluation: GuardedRiskEvaluation,
    action: ActionType,
  ): Promise<ActionOutcome> {
    const { newParamValue, pauseDurationMs } = this.actionParameters(action, features);

    // Persist a pending off-chain action row FIRST so the executor's evidence
    // link step can write a real `walrus_blobs.action_id` FK. Falls back to a
    // generated id when no recorder is wired (unit tests). (Req 9.5)
    const oldValue =
      action === 'reduce_max_ltv' ? String(Math.round(features.currentMaxLtvBps)) : null;
    const newValue = action === 'pause_new_borrows' ? 'paused' : String(newParamValue);
    let actionId: string;
    if (this.actionRecorder) {
      try {
        actionId = await this.actionRecorder.createPending({
          policyId: this.demoMarket.policyId,
          marketId: this.demoMarket.marketId,
          actor: this.demoMarket.agentSigner,
          riskScore: evaluation.riskScore,
          actionType: action,
          oldValue,
          newValue,
          // The on-chain action executes NOW (real wall-clock), independent of
          // the scenario's synthetic feature timestamp used for risk context.
          timestampMs: Date.now(),
        });
      } catch (err) {
        return {
          attempted: true,
          blocked: false,
          success: false,
          failureReason: `failed to persist pending action: ${errorMessage(err)}`,
        };
      }
    } else {
      actionId = randomUUID();
    }

    const request = this.buildExecuteRequest(scenario, features, evaluation, action, actionId, {
      newParamValue,
      pauseDurationMs,
    });

    let result: ActionResult;
    try {
      result = await this.actionExecutor.execute(request);
    } catch (err) {
      // An unexpected throw is treated as a failed action — no success reported,
      // scenario state retained. (Req 14.9)
      return {
        attempted: true,
        blocked: false,
        success: false,
        failureReason: errorMessage(err),
      };
    }

    // Finalize the off-chain mirror with the on-chain tx digest + evidence refs.
    if (this.actionRecorder) {
      try {
        await this.actionRecorder.finalize(actionId, {
          txDigest: result.txDigest,
          blobId: result.blobId,
          evidenceHash: result.evidenceHash,
        });
      } catch {
        /* best-effort: the on-chain action + evidence already succeeded */
      }
    }

    return {
      attempted: true,
      blocked: false,
      success: result.success,
      txDigest: result.txDigest,
      blobId: result.blobId,
      evidenceHash: result.evidenceHash,
      stage: result.stage,
      failureReason: result.success ? undefined : result.failureReason,
    };
  }

  /** Assemble the {@link ExecuteRequest} for a recommended action. */
  private buildExecuteRequest(
    scenario: SimulationScenario,
    features: FeatureVector,
    evaluation: GuardedRiskEvaluation,
    action: ActionType,
    actionLogId: string,
    params: { newParamValue: number; pauseDurationMs: number },
  ): ExecuteRequest {
    const { newParamValue, pauseDurationMs } = params;

    const actionContext: ActionContext = {
      policyId: this.demoMarket.policyId,
      agentSigner: this.demoMarket.agentSigner,
      dataSource: 'simulated',
      scenarioId: scenario.id,
      priorActionIds: [],
      executedAction: action,
      timestampMs: features.nowMs,
      marketId: this.demoMarket.marketId,
    };

    return {
      action: {
        policyObjectId: this.demoMarket.policyObjectId,
        guardianCapObjectId: this.demoMarket.guardianCapObjectId,
        marketStateObjectId: this.demoMarket.marketStateObjectId,
        actionType: ACTION_TYPE_CODE[action],
        newParamValue,
        pauseDurationMs,
        riskScore: evaluation.riskScore,
        ...(this.demoMarket.clockObjectId ? { clockObjectId: this.demoMarket.clockObjectId } : {}),
      },
      evaluation,
      actionContext,
      actionLogId,
    };
  }

  /** Derive bounded numeric parameters for the chosen action. */
  private actionParameters(
    action: ActionType,
    features: FeatureVector,
  ): { newParamValue: number; pauseDurationMs: number } {
    switch (action) {
      case 'pause_new_borrows':
        return { newParamValue: 0, pauseDurationMs: this.demoMarket.defaultPauseDurationMs ?? 3_600_000 };
      case 'reduce_max_ltv': {
        const delta = this.demoMarket.defaultLtvDeltaBps ?? 1_000;
        const newLtv = Math.max(0, Math.round(features.currentMaxLtvBps) - delta);
        return { newParamValue: newLtv, pauseDurationMs: 0 };
      }
      case 'increase_maintenance_margin':
        return { newParamValue: this.demoMarket.defaultMarginDeltaBps ?? 500, pauseDurationMs: 0 };
      case 'enter_guarded_mode':
      default:
        return { newParamValue: 0, pauseDurationMs: 0 };
    }
  }

  /**
   * Build the fail-closed guard context for an evaluation. Simulated inputs are
   * always present/parseable and the simulation runs against Sui Testnet, so
   * those gates pass; the staleness age and policy bounds are derived from the
   * features and policy config. Guardian revocation/expiry is handled separately
   * by the {@link GuardianAuthorizationChecker} (so a threshold crossing is
   * detected independently of authorization, per Req 14.3/14.8), hence
   * `guardianRevoked` is false here.
   */
  private buildGuardContext(features: FeatureVector): FailClosedGuardContext {
    const oracleAgeMs = Math.max(0, features.nowMs - features.oracleTimestampMs);
    return {
      evaluationComplete: true,
      oracle: { present: true },
      isSuiTestnet: true,
      guardianRevoked: false,
      policy: {
        allowedActions: this.policy.allowedActions,
        maxLtvDeltaBps: this.policy.maxLtvDeltaBps,
        maxMarginDeltaBps: this.policy.maxMarginDeltaBps,
        pauseDurationLimitMs: this.policy.pauseDurationLimitMs,
      },
      proposedMagnitude: {},
      oracleAgeMs,
      freshnessThresholdMs: features.freshnessThresholdMs,
      policyPermitsStalePause: this.policy.permitStalePause,
    };
  }

  /** Map an action outcome to the retained run status. */
  private statusForAction(action: ActionOutcome | undefined): SimulationRunStatus {
    if (!action) {
      return 'completed';
    }
    if (action.blocked) {
      return 'action_blocked';
    }
    return action.success ? 'action_executed' : 'action_failed';
  }
}
