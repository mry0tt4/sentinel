/**
 * Risk Control Loop — the live composition that connects the workers' data
 * stream to the Risk Engine, the Action Executor, the Evidence Service, and the
 * WebSocket push surface (task 21.1).
 *
 * This is the *live* counterpart to {@link import('../simulation/simulationService.js').SimulationService}
 * (which drives the same Risk Engine → Action Executor flow from scripted
 * scenario steps). Where the Simulation_Lab steps a scenario, this loop is fed
 * by the Oracle Ingestion / Liquidity workers: each assembled market tick is
 * evaluated, pushed to subscribed dashboards as a `risk_update`, and — when a
 * threshold is crossed and the action flow succeeds — surfaced as an
 * `action_executed` push. The durable on-chain mirror (the `actions` row and
 * the `linked_on_chain` evidence flip) is produced independently by the
 * Protocol State Indexer observing the resulting `RiskActionExecuted` event, so
 * this loop never writes the action row itself — it composes the existing
 * services without rebuilding them. (Req 3.7, 9.4, 9.5)
 *
 * Every collaborator is injected as a narrow port so the loop runs against
 * in-memory fakes in unit/wiring tests (no live RPC / Walrus / DB) and against
 * the real {@link import('../risk/failClosedRiskEngine.js').FailClosedRiskEngine},
 * {@link import('../action/actionExecutor.js').ActionExecutor}, and WebSocket
 * {@link import('../ws/subscriptionRegistry.js').SubscriptionRegistry} in
 * production wiring.
 */

import type { ActionResult, ExecuteRequest } from '../action/actionExecutor.js';
import type { AiExplanationService } from '../risk/aiExplanationService.js';
import type {
  FailClosedGuardContext,
  GuardedRiskEvaluation,
} from '../risk/failClosedRiskEngine.js';
import type { FeatureVector } from '../risk/types.js';
import type { ActionRecord, RiskSnapshot } from '../ws/messages.js';
import type { MessagePublisher } from '../ws/subscriptionRegistry.js';

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/**
 * Port over the (fail-closed) Risk_Engine. The concrete
 * {@link import('../risk/failClosedRiskEngine.js').FailClosedRiskEngine} is
 * directly assignable; tests inject a fake. (Req 6, 3.3)
 */
export interface LoopRiskEnginePort {
  evaluate(
    marketId: string,
    features: FeatureVector,
    guard: FailClosedGuardContext,
  ): GuardedRiskEvaluation | Promise<GuardedRiskEvaluation>;
}

/** Port over {@link import('../action/actionExecutor.js').ActionExecutor.execute}. (Req 9) */
export interface LoopActionExecutorPort {
  execute(input: ExecuteRequest): Promise<ActionResult>;
}

/**
 * Plans the {@link ExecuteRequest} for a threshold-crossing evaluation. Returns
 * `null` to skip execution (e.g. the guardian is not authorized, or no on-chain
 * action template is configured for the market). This is where the recommended
 * {@link import('../risk/types.js').ActionType} is mapped to the bounded,
 * server-defined on-chain action parameters. (Req 9.2, 7.10)
 */
export interface ActionRequestPlanner {
  plan(input: {
    marketId: string;
    evaluation: GuardedRiskEvaluation;
    features: FeatureVector;
  }): ExecuteRequest | null | Promise<ExecuteRequest | null>;
}

/** Optional durable sink for the risk evaluation (e.g. `risk_snapshots`). */
export interface RiskSnapshotRecorder {
  record(evaluation: GuardedRiskEvaluation, dataSource: 'live' | 'simulated'): Promise<void> | void;
}

/** Optional structured logger; defaults to a no-op so tests stay quiet. */
export interface LoopLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: LoopLogger = {
  info: () => undefined,
  error: () => undefined,
};

export interface RiskControlLoopDeps {
  riskEngine: LoopRiskEnginePort;
  actionExecutor: LoopActionExecutorPort;
  /** WebSocket push surface — the `SubscriptionRegistry` satisfies this. (Req 3.7) */
  publisher: MessagePublisher;
  /** Plans the on-chain action for a threshold crossing; omit to disable execution. */
  planner?: ActionRequestPlanner;
  /** Optional durable risk-snapshot persistence. */
  snapshots?: RiskSnapshotRecorder;
  /**
   * Optional AI Explanation Service. When present, the loop fills the
   * evaluation's `explanation` (a ≤1000-char plain-language narrative) before
   * publishing the `risk_update`. The explanation has NO authority over the
   * score/band/classes/action — it is attached after the gating decision is
   * computed, and a failure falls back to the empty/template explanation
   * without affecting the loop. (Req 6.5, 6.13)
   */
  explainer?: AiExplanationService;
  /** Clock for message timestamps; defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
  logger?: LoopLogger;
}

// ---------------------------------------------------------------------------
// Tick + outcome
// ---------------------------------------------------------------------------

/**
 * A single market evaluation request, assembled by the workers' feature
 * assembler from the latest oracle + liquidity readings (or by the simulator).
 */
export interface MarketTick {
  marketId: string;
  features: FeatureVector;
  guard: FailClosedGuardContext;
  /** Whether the inputs are live oracle data or simulated scenario data. (Req 14.6) */
  dataSource: 'live' | 'simulated';
}

/** The result of processing a single {@link MarketTick}. */
export interface LoopOutcome {
  evaluation: GuardedRiskEvaluation;
  /** Whether the evaluation crossed an action threshold (recommended an action). */
  thresholdCrossed: boolean;
  /** Whether the oracle reading was stale (a `stale_data` push was emitted). */
  stale: boolean;
  /** Whether the action flow was invoked. */
  executed: boolean;
  /** The Action Executor result, when an action was attempted. */
  action?: ActionResult;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/**
 * The live risk-control loop. {@link onTick} is the single entry point the
 * workers' feature assembler (and the production wiring) call for every
 * assembled market snapshot.
 */
export class RiskControlLoop {
  private readonly riskEngine: LoopRiskEnginePort;
  private readonly actionExecutor: LoopActionExecutorPort;
  private readonly publisher: MessagePublisher;
  private readonly planner?: ActionRequestPlanner;
  private readonly snapshots?: RiskSnapshotRecorder;
  private readonly explainer?: AiExplanationService;
  private readonly now: () => number;
  private readonly logger: LoopLogger;

  constructor(deps: RiskControlLoopDeps) {
    this.riskEngine = deps.riskEngine;
    this.actionExecutor = deps.actionExecutor;
    this.publisher = deps.publisher;
    this.planner = deps.planner;
    this.snapshots = deps.snapshots;
    this.explainer = deps.explainer;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /**
   * Process a single assembled market tick:
   *  1. evaluate the Risk_Engine (fail-closed),
   *  2. push a `risk_update` to subscribed dashboards (Req 3.7),
   *  3. push a `stale_data` message when the oracle reading is stale (Req 3.9, 17.5),
   *  4. persist the risk snapshot when a recorder is configured,
   *  5. on a threshold crossing, plan + run the network-gated action flow and —
   *     on success — push an `action_executed` message (Req 9.4, 9.5).
   *
   * The full on-chain mirror (the `actions` row + the `linked_on_chain`
   * evidence flip) is produced by the Protocol State Indexer observing the
   * emitted `RiskActionExecuted` event, not here. (Req 17.6)
   */
  async onTick(tick: MarketTick): Promise<LoopOutcome> {
    let evaluation = await this.riskEngine.evaluate(tick.marketId, tick.features, tick.guard);

    // Attach a plain-language AI explanation AFTER the deterministic gating
    // decision is computed. This never alters the score/band/classes/action; a
    // failure leaves the (empty) explanation untouched. (Req 6.5, 6.13)
    if (this.explainer) {
      try {
        const explanation = await this.explainer.explain({
          score: evaluation.riskScore,
          band: evaluation.band,
          classes: evaluation.classes,
          ruleOutputs: evaluation.ruleOutputs,
        });
        evaluation = { ...evaluation, explanation };
      } catch (err) {
        this.logger.error('AI explanation failed; continuing without it', {
          marketId: tick.marketId,
          error: errorMessage(err),
        });
      }
    }

    // 2. Live risk push. (Req 3.7)
    this.publisher.publish({
      type: 'risk_update',
      marketId: tick.marketId,
      snapshot: toRiskSnapshot(evaluation, tick.dataSource, this.isoNow()),
    });

    // 3. Stale-data push when the oracle reading exceeds its freshness threshold.
    const stale = isStale(tick.guard);
    if (stale) {
      this.publisher.publish({ type: 'stale_data', marketId: tick.marketId });
    }

    // 4. Durable risk snapshot (best-effort; a persistence failure must not
    //    abort the loop or block the on-chain action).
    if (this.snapshots) {
      try {
        await this.snapshots.record(evaluation, tick.dataSource);
      } catch (err) {
        this.logger.error('Failed to persist risk snapshot', {
          marketId: tick.marketId,
          error: errorMessage(err),
        });
      }
    }

    const thresholdCrossed = evaluation.recommendedAction !== null;
    if (!thresholdCrossed || this.planner === undefined) {
      return { evaluation, thresholdCrossed, stale, executed: false };
    }

    // 5. Threshold crossed → plan + run the action flow. (Req 9.4, 9.5)
    let request: ExecuteRequest | null;
    try {
      request = await this.planner.plan({
        marketId: tick.marketId,
        evaluation,
        features: tick.features,
      });
    } catch (err) {
      this.logger.error('Failed to plan action request', {
        marketId: tick.marketId,
        error: errorMessage(err),
      });
      return { evaluation, thresholdCrossed, stale, executed: false };
    }

    if (request === null) {
      // No on-chain action template / not authorized → no execution.
      return { evaluation, thresholdCrossed, stale, executed: false };
    }

    let result: ActionResult;
    try {
      result = await this.actionExecutor.execute(request);
    } catch (err) {
      // A thrown executor error is a failed action: no success push, loop
      // continues. (Req 14.9-style fail-safe handling)
      this.logger.error('Action execution threw', {
        marketId: tick.marketId,
        error: errorMessage(err),
      });
      return { evaluation, thresholdCrossed, stale, executed: true };
    }

    // On success, push the live action update. The durable `actions` row +
    // evidence-link flip are produced by the indexer from the on-chain event.
    if (result.success) {
      this.publisher.publish({
        type: 'action_executed',
        marketId: tick.marketId,
        action: toActionRecord(tick.marketId, evaluation, result, request, this.isoNow()),
      });
    } else {
      this.logger.error('Action flow did not complete', {
        marketId: tick.marketId,
        stage: result.stage,
        reason: result.failureReason,
      });
    }

    return { evaluation, thresholdCrossed, stale, executed: true, action: result };
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

/** Whether the guard context reports a stale oracle reading. */
function isStale(guard: FailClosedGuardContext): boolean {
  return (
    Number.isFinite(guard.oracleAgeMs) &&
    Number.isFinite(guard.freshnessThresholdMs) &&
    guard.oracleAgeMs > guard.freshnessThresholdMs
  );
}

/**
 * Map a {@link GuardedRiskEvaluation} to the camelCase {@link RiskSnapshot}
 * payload the dashboard already consumes over both REST and the socket.
 */
export function toRiskSnapshot(
  evaluation: GuardedRiskEvaluation,
  dataSource: 'live' | 'simulated',
  createdAt: string,
): RiskSnapshot {
  return {
    marketId: evaluation.marketId,
    riskScore: evaluation.riskScore,
    band: evaluation.band,
    classes: [...evaluation.classes],
    confidence: evaluation.confidence,
    recommendedAction: evaluation.recommendedAction,
    refusalReason: evaluation.refusalReason ?? null,
    featureVector: evaluation.featureVector,
    ruleOutputs: evaluation.ruleOutputs,
    modelVersion: evaluation.modelVersion,
    promptConfigVersion: evaluation.promptConfigVersion,
    explanation: evaluation.explanation,
    dataSource,
    isSimulated: dataSource === 'simulated',
    createdAt,
  };
}

/**
 * Synthesize the live {@link ActionRecord} pushed on a successful action. This
 * mirrors the on-chain ActionLog the indexer will persist; the indexer's
 * `actions` row remains the durable record of truth. The action's `id` is the
 * tx digest (or the planned `actionLogId`) so the dashboard can correlate it
 * with the indexed row once it lands.
 */
export function toActionRecord(
  marketId: string,
  evaluation: GuardedRiskEvaluation,
  result: ActionResult,
  request: ExecuteRequest,
  createdAt: string,
): ActionRecord {
  const executedAction =
    (typeof request.actionContext.executedAction === 'string'
      ? request.actionContext.executedAction
      : undefined) ??
    evaluation.recommendedAction ??
    'unknown';

  return {
    id: result.txDigest ?? request.actionLogId,
    policyId: request.actionContext.policyId,
    marketId,
    actor: request.actionContext.agentSigner,
    actorType: 'agent',
    riskScore: evaluation.riskScore,
    actionType: executedAction,
    oldValue: null,
    newValue: null,
    walrusEvidenceBlobId: result.blobId ?? null,
    evidenceHash: result.evidenceHash ?? null,
    txDigest: result.txDigest ?? null,
    isReversed: false,
    timestampMs: String(request.actionContext.timestampMs ?? evaluation.featureVector.nowMs),
    createdAt,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
