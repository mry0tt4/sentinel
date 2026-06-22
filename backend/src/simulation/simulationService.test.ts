/**
 * Unit tests for the Simulation_Lab service (task 18.1).
 *
 * These exercise the backend scenario registration and the SimulationService
 * with injected fakes (no live RPC / Walrus / DB):
 *
 *  - exactly nine scenarios are registered and their ids equal SIMULATOR_SCENARIOS
 *  - a threshold-crossing scenario with a valid guardian triggers the Action
 *    Executor and returns success with the evidence digest/blob (Req 14.3)
 *  - a revoked OR expired guardian blocks the action and reports the guardian as
 *    not authorized (Req 14.8)
 *  - reset restores the initial Demo_Market + scenario state (Req 14.5)
 *  - an action/evidence failure reports no success and retains scenario state
 *    (Req 14.9)
 *  - the scenarios actually drive the (real) Risk_Engine to the intended
 *    condition (Req 14.2)
 */

import { describe, it, expect, vi } from 'vitest';

import { SIMULATOR_SCENARIOS } from '../api/actionRoutes.js';
import type { ActionResult, ExecuteRequest } from '../action/actionExecutor.js';
import { FailClosedRiskEngine, type GuardedRiskEvaluation } from '../risk/failClosedRiskEngine.js';
import { DeterministicRiskEngine } from '../risk/scoringEngine.js';
import type { ActionType, FeatureVector } from '../risk/types.js';
import {
  SimulationService,
  UnknownScenarioError,
  type ActionExecutorPort,
  type GuardianAuthorizationChecker,
  type SimulationDemoMarketConfig,
  type SimulationRiskEnginePort,
} from './simulationService.js';

const DEMO_MARKET: SimulationDemoMarketConfig = {
  marketId: 'demo-market',
  policyId: 'policy-1',
  policyObjectId: '0xpolicy',
  guardianCapObjectId: '0xguardian',
  marketStateObjectId: '0xmarket',
  agentSigner: '0xagent',
  clockObjectId: '0x6',
  defaultPauseDurationMs: 3_600_000,
  defaultLtvDeltaBps: 1_000,
  defaultMarginDeltaBps: 500,
};

const SUCCESS_RESULT: ActionResult = {
  success: true,
  stage: 'completed',
  txDigest: 'TX_DIGEST_1',
  blobId: 'walrus-blob-1',
  evidenceHash: 'deadbeef',
  events: [{ type: 'RiskActionExecuted' }],
};

/**
 * A controllable fake Risk_Engine: returns a recommended action (crossing the
 * threshold) only when the feature vector shows a severe negative 1m move. This
 * mirrors stepping — only the flash-crash terminal step crosses.
 */
function makeFakeRiskEngine(recommended: ActionType = 'pause_new_borrows'): SimulationRiskEnginePort {
  return {
    evaluate(_marketId: string, features: FeatureVector): GuardedRiskEvaluation {
      const crosses = features.priceChange1mPct <= -10;
      return {
        marketId: _marketId,
        riskScore: crosses ? 95 : 10,
        band: crosses ? 'EmergencyPause' : 'Normal',
        classes: crosses ? ['flash crash'] : ['data integrity'],
        recommendedAction: crosses ? recommended : null,
        confidence: 90,
        explanation: '',
        ruleOutputs: [],
        modelVersion: 'test',
        promptConfigVersion: 'test',
        featureVector: features,
      };
    },
  };
}

/** A fake action executor recording the requests it receives. */
function makeFakeExecutor(result: ActionResult): {
  port: ActionExecutorPort;
  calls: ExecuteRequest[];
} {
  const calls: ExecuteRequest[] = [];
  const port: ActionExecutorPort = {
    async execute(input: ExecuteRequest): Promise<ActionResult> {
      calls.push(input);
      return result;
    },
  };
  return { port, calls };
}

describe('Simulation_Lab scenario registration (Req 14.1)', () => {
  it('registers exactly nine scenarios whose ids equal SIMULATOR_SCENARIOS', () => {
    const ids = SimulationService.scenarioIds();
    expect(ids).toHaveLength(9);
    expect(new Set(ids)).toEqual(new Set(SIMULATOR_SCENARIOS));
  });

  it('rejects an unknown scenario id', async () => {
    const service = new SimulationService({
      riskEngine: makeFakeRiskEngine(),
      actionExecutor: makeFakeExecutor(SUCCESS_RESULT).port,
      demoMarket: DEMO_MARKET,
    });
    await expect(service.start('not-a-scenario')).rejects.toBeInstanceOf(UnknownScenarioError);
  });
});

describe('SimulationService.start — threshold crossing with a valid guardian (Req 14.2, 14.3)', () => {
  it('triggers the Action Executor and returns success with the evidence digest/blob', async () => {
    const executor = makeFakeExecutor(SUCCESS_RESULT);
    const service = new SimulationService({
      riskEngine: makeFakeRiskEngine('pause_new_borrows'),
      actionExecutor: executor.port,
      demoMarket: DEMO_MARKET,
    });

    const run = await service.start('sui-flash-crash');

    // The Action Executor was invoked exactly once at the climax step.
    expect(executor.calls).toHaveLength(1);
    expect(run.status).toBe('action_executed');
    expect(run.action?.attempted).toBe(true);
    expect(run.action?.blocked).toBe(false);
    expect(run.action?.success).toBe(true);
    expect(run.action?.txDigest).toBe('TX_DIGEST_1');
    expect(run.action?.blobId).toBe('walrus-blob-1');
    expect(run.action?.evidenceHash).toBe('deadbeef');

    // The earlier (calm/dip) steps reported a risk score but did not cross.
    expect(run.steps.length).toBeGreaterThanOrEqual(2);
    expect(run.steps[0].thresholdCrossed).toBe(false);
    const climax = run.steps[run.steps.length - 1];
    expect(climax.thresholdCrossed).toBe(true);
    expect(climax.risk.recommendedAction).toBe('pause_new_borrows');

    // The execute request carried simulated data-source + scenario id.
    const req = executor.calls[0];
    expect(req.actionContext.dataSource).toBe('simulated');
    expect(req.actionContext.scenarioId).toBe('sui-flash-crash');
    expect(req.action.policyObjectId).toBe('0xpolicy');
  });
});

describe('SimulationService.start — guardian not authorized blocks the action (Req 14.8)', () => {
  it('blocks the action when the GuardianCap is revoked', async () => {
    const executor = makeFakeExecutor(SUCCESS_RESULT);
    const revokedChecker: GuardianAuthorizationChecker = {
      check: () => ({ authorized: false, revoked: true, expired: false, reason: 'revoked' }),
    };
    const service = new SimulationService({
      riskEngine: makeFakeRiskEngine(),
      actionExecutor: executor.port,
      demoMarket: DEMO_MARKET,
      guardianChecker: revokedChecker,
    });

    const run = await service.start('sui-flash-crash');

    expect(executor.calls).toHaveLength(0); // action never executed
    expect(run.status).toBe('action_blocked');
    expect(run.action?.blocked).toBe(true);
    expect(run.action?.attempted).toBe(false);
    expect(run.action?.success).toBe(false);
    const climax = run.steps[run.steps.length - 1];
    expect(climax.guardian?.authorized).toBe(false);
    expect(climax.guardian?.revoked).toBe(true);
  });

  it('blocks the action when the GuardianCap is expired', async () => {
    const executor = makeFakeExecutor(SUCCESS_RESULT);
    const expiredChecker: GuardianAuthorizationChecker = {
      check: () => ({ authorized: false, revoked: false, expired: true, reason: 'expired' }),
    };
    const service = new SimulationService({
      riskEngine: makeFakeRiskEngine(),
      actionExecutor: executor.port,
      demoMarket: DEMO_MARKET,
      guardianChecker: expiredChecker,
    });

    const run = await service.start('sui-flash-crash');

    expect(executor.calls).toHaveLength(0);
    expect(run.status).toBe('action_blocked');
    expect(run.action?.blocked).toBe(true);
    const climax = run.steps[run.steps.length - 1];
    expect(climax.guardian?.expired).toBe(true);
  });
});

describe('SimulationService.start — action/evidence failure (Req 14.9)', () => {
  it('reports no success and retains scenario state when the action flow fails', async () => {
    const failure: ActionResult = {
      success: false,
      stage: 'evidence_upload',
      evidencePending: true,
      failureReason: 'EvidenceUploadError: 5 attempts exhausted',
    };
    const executor = makeFakeExecutor(failure);
    const service = new SimulationService({
      riskEngine: makeFakeRiskEngine(),
      actionExecutor: executor.port,
      demoMarket: DEMO_MARKET,
    });

    const run = await service.start('sui-flash-crash');

    expect(executor.calls).toHaveLength(1);
    expect(run.status).toBe('action_failed');
    expect(run.action?.success).toBe(false);
    expect(run.action?.failureReason).toContain('EvidenceUploadError');

    // Scenario state is retained (not cleared) after a failure. (Req 14.9)
    const state = service.getState();
    expect(state).not.toBeNull();
    expect(state?.scenarioId).toBe('sui-flash-crash');
    expect(state?.status).toBe('action_failed');
  });

  it('treats an executor throw as a failed action with no success', async () => {
    const throwingExecutor: ActionExecutorPort = {
      execute: () => Promise.reject(new Error('RPC unreachable')),
    };
    const service = new SimulationService({
      riskEngine: makeFakeRiskEngine(),
      actionExecutor: throwingExecutor,
      demoMarket: DEMO_MARKET,
    });

    const run = await service.start('sui-flash-crash');

    expect(run.status).toBe('action_failed');
    expect(run.action?.success).toBe(false);
    expect(run.action?.failureReason).toContain('RPC unreachable');
    expect(service.getState()?.scenarioId).toBe('sui-flash-crash');
  });
});

describe('SimulationService.reset — restores initial state (Req 14.5)', () => {
  it('clears the scenario state and invokes the demo-market reset port', async () => {
    const resetPort = { reset: vi.fn().mockResolvedValue(undefined) };
    const service = new SimulationService({
      riskEngine: makeFakeRiskEngine(),
      actionExecutor: makeFakeExecutor(SUCCESS_RESULT).port,
      demoMarket: DEMO_MARKET,
      demoMarketReset: resetPort,
    });

    await service.start('sui-flash-crash');
    expect(service.getState()).not.toBeNull();

    const result = await service.reset();

    expect(resetPort.reset).toHaveBeenCalledTimes(1);
    expect(result.reset).toBe(true);
    expect(service.getState()).toBeNull();
    // The restored baseline matches the calm Demo_Market initial inputs.
    expect(result.baseline.borrowPaused).toBe(false);
    expect(result.baseline.guardianRevoked).toBe(false);
    expect(result.baseline.priceChange1mPct).toBe(0);
  });

  it('re-evaluates from the calm baseline after a reset', async () => {
    const service = new SimulationService({
      riskEngine: makeFakeRiskEngine(),
      actionExecutor: makeFakeExecutor(SUCCESS_RESULT).port,
      demoMarket: DEMO_MARKET,
    });

    await service.start('sui-flash-crash');
    await service.reset();
    const run = await service.start('sui-flash-crash');

    // Step 0 is always the calm baseline (no threshold crossing).
    expect(run.steps[0].stepIndex).toBe(0);
    expect(run.steps[0].thresholdCrossed).toBe(false);
  });
});

describe('Scenarios drive the real Risk_Engine to the intended condition (Req 14.2)', () => {
  function realService(executor = makeFakeExecutor(SUCCESS_RESULT)): {
    service: SimulationService;
    executor: ReturnType<typeof makeFakeExecutor>;
  } {
    const engine = new FailClosedRiskEngine(new DeterministicRiskEngine());
    const service = new SimulationService({
      riskEngine: engine,
      actionExecutor: executor.port,
      demoMarket: DEMO_MARKET,
    });
    return { service, executor };
  }

  const hazardScenarios = SIMULATOR_SCENARIOS.filter((id) => id !== 'false-positive-recovery');

  for (const scenarioId of hazardScenarios) {
    it(`"${scenarioId}" crosses an action threshold`, async () => {
      const { service } = realService();
      const run = await service.start(scenarioId);
      const crossed = run.steps.some((s) => s.thresholdCrossed);
      expect(crossed).toBe(true);
    });
  }

  it('the authorized "sui-flash-crash" scenario triggers a real action', async () => {
    const { service, executor } = realService();
    const run = await service.start('sui-flash-crash');
    expect(executor.calls.length).toBe(1);
    expect(run.status).toBe('action_executed');
  });

  it('the "guardian-revoked" scenario crosses the threshold but is blocked', async () => {
    const { service, executor } = realService();
    const run = await service.start('guardian-revoked');
    expect(run.steps.some((s) => s.thresholdCrossed)).toBe(true);
    expect(run.status).toBe('action_blocked');
    expect(executor.calls.length).toBe(0);
  });

  it('the "false-positive-recovery" scenario never crosses the threshold and takes no action', async () => {
    const { service, executor } = realService();
    const run = await service.start('false-positive-recovery');
    expect(run.steps.every((s) => !s.thresholdCrossed)).toBe(true);
    expect(run.status).toBe('completed');
    expect(run.action).toBeUndefined();
    expect(executor.calls.length).toBe(0);
  });

  it('reports the integer risk score for each step within [0, 100]', async () => {
    const { service } = realService();
    const run = await service.start('liquidation-cascade');
    for (const step of run.steps) {
      expect(Number.isInteger(step.risk.riskScore)).toBe(true);
      expect(step.risk.riskScore).toBeGreaterThanOrEqual(0);
      expect(step.risk.riskScore).toBeLessThanOrEqual(100);
    }
  });
});
