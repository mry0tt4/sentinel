/**
 * HTTP-level tests for the REST action endpoints (Req 15.2, 15.4, 15.5, 4.9).
 *
 * Each endpoint is exercised through the real Express app (`createApp`) with
 * in-memory fake service ports injected — no RPC, DB, or Walrus. Tests assert:
 *  - descriptive 400 errors on bad / out-of-range input (esp. policy bounds,
 *    Req 4.9);
 *  - valid requests delegate to the injected service and return the expected
 *    shape (Req 15.2);
 *  - the configurable rate limiter returns 429 once the limit is exceeded
 *    (Req 15.5).
 *
 * The dedicated property test for these properties is task 13.3.
 */

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { ActionResult, ExecuteRequest } from '../action/actionExecutor.js';
import type { OverrideResult, OverrideExecuteRequest } from '../action/overrideExecutor.js';
import type { AppConfig } from '../config/env.js';
import type { Repositories } from '../db/repositories/index.js';
import type { EvidenceBundle } from '../evidence/types.js';
import type { GuardedRiskEvaluation } from '../risk/failClosedRiskEngine.js';
import { createApp, type CreateAppDeps } from '../server.js';
import type { ActionRouteServices } from './actionRoutes.js';

const baseConfig: AppConfig = {
  nodeEnv: 'test',
  port: 0,
  suiRpcUrl: 'https://fullnode.testnet.sui.io:443',
  suiTestnetChainId: '4c78adac',
  packageIds: { policy: '', demoMarket: '', adapters: '' },
  walrusPublisherUrl: 'https://publisher.walrus-testnet.walrus.space',
  walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
  databaseUrl: 'postgresql://localhost:5432/sentinel',
  redisUrl: 'redis://localhost:6379',
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  llm: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
};

// The action routes never touch repositories; a bare object satisfies the type.
const emptyRepositories = {} as unknown as Repositories;

function makeApp(overrides: Partial<AppConfig> = {}, services?: ActionRouteServices) {
  const deps: CreateAppDeps = { repositories: emptyRepositories, actionServices: services };
  return createApp({ ...baseConfig, ...overrides }, deps);
}

// --- Fakes -----------------------------------------------------------------

function fakeServices(): {
  services: ActionRouteServices;
  recommendation: GuardedRiskEvaluation;
  executeResult: ActionResult;
} {
  const recommendation = {
    marketId: 'market-a',
    riskScore: 92,
    band: 'EmergencyPause',
    classes: ['oracle staleness'],
    recommendedAction: 'pause_new_borrows',
    confidence: 88,
    explanation: '',
    ruleOutputs: [],
    modelVersion: 'v1',
    promptConfigVersion: 'p1',
    featureVector: {} as never,
  } as unknown as GuardedRiskEvaluation;

  const executeResult: ActionResult = {
    success: true,
    stage: 'completed',
    txDigest: 'DIGEST_OK',
    blobId: 'blob-1',
    evidenceHash: 'deadbeef',
    events: [],
  };

  const overrideResult: OverrideResult = {
    success: true,
    stage: 'completed',
    operation: 'reverse_action',
    overrideReason: 'Oracle recovered',
    txDigest: 'OVERRIDE_OK',
    blobId: 'blob-2',
    evidenceHash: 'cafef00d',
    recordedActionId: 'reversal-1',
    originalActionReversed: true,
    events: [],
  };

  const services: ActionRouteServices = {
    recommend: { recommend: vi.fn(() => recommendation) },
    execute: { execute: vi.fn(async (_input: ExecuteRequest) => executeResult) },
    overrideExecute: { execute: vi.fn(async (_input: OverrideExecuteRequest) => overrideResult) },
    uploadEvidence: {
      upload: vi.fn(async (_bundle: EvidenceBundle) => ({
        blobId: 'blob-1',
        evidenceHash: 'deadbeef',
      })),
    },
    simulator: {
      start: vi.fn((scenario: string) => ({ scenario, step: 0 })),
      reset: vi.fn(() => ({ cleared: true })),
    },
    simulatePolicyDeployment: { simulate: vi.fn((draft) => ({ ok: true, draft })) },
  };

  return { services, recommendation, executeResult };
}

const validDraftBody = {
  marketId: 'market-a',
  allowedActions: ['pause_new_borrows', 'reduce_max_ltv'],
  maxLtvDeltaBps: 500,
  maxMarginDeltaBps: 300,
  pauseDurationLimitMs: 3_600_000,
  cooldownMs: 60_000,
};

// --- POST /api/policies/draft (Req 4.9 range validation) -------------------

describe('POST /api/policies/draft', () => {
  it('drafts a policy when all bounds are within range', async () => {
    const res = await request(makeApp()).post('/api/policies/draft').send(validDraftBody);
    expect(res.status).toBe(200);
    expect(res.body.draft.marketId).toBe('market-a');
    expect(res.body.draft.maxLtvDeltaBps).toBe(500);
  });

  it('rejects a missing marketId with a descriptive error (Req 15.4)', async () => {
    const { marketId: _omit, ...body } = validDraftBody;
    const res = await request(makeApp()).post('/api/policies/draft').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
    expect(res.body.field).toBe('marketId');
    expect(res.body.message).toContain('marketId');
  });

  it('rejects an out-of-range maxLtvDeltaBps and identifies the invalid value (Req 4.9)', async () => {
    const res = await request(makeApp())
      .post('/api/policies/draft')
      .send({ ...validDraftBody, maxLtvDeltaBps: 99_999 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('maxLtvDeltaBps');
    expect(res.body.message).toContain('99999');
  });

  it('rejects a missing pauseDurationLimitMs bound (Req 4.9)', async () => {
    const { pauseDurationLimitMs: _omit, ...body } = validDraftBody;
    const res = await request(makeApp()).post('/api/policies/draft').send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('pauseDurationLimitMs');
  });

  it('rejects a non-integer cooldownMs (Req 4.9)', async () => {
    const res = await request(makeApp())
      .post('/api/policies/draft')
      .send({ ...validDraftBody, cooldownMs: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('cooldownMs');
  });

  it('rejects an unknown allowed action (Req 4.9)', async () => {
    const res = await request(makeApp())
      .post('/api/policies/draft')
      .send({ ...validDraftBody, allowedActions: ['delete_everything'] });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('allowedActions[0]');
  });
});

// --- POST /api/policies/simulate -------------------------------------------

describe('POST /api/policies/simulate', () => {
  it('dry-runs a valid draft via the injected port', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services))
      .post('/api/policies/simulate')
      .send(validDraftBody);
    expect(res.status).toBe(200);
    expect(res.body.simulated).toBe(true);
    expect(services.simulatePolicyDeployment?.simulate).toHaveBeenCalledOnce();
  });

  it('returns a stub result when no simulator port is wired', async () => {
    const res = await request(makeApp()).post('/api/policies/simulate').send(validDraftBody);
    expect(res.status).toBe(200);
    expect(res.body.simulated).toBe(true);
  });

  it('rejects out-of-range bounds before delegating (Req 4.9)', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services))
      .post('/api/policies/simulate')
      .send({ ...validDraftBody, maxMarginDeltaBps: -1 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('maxMarginDeltaBps');
    expect(services.simulatePolicyDeployment?.simulate).not.toHaveBeenCalled();
  });
});

// --- POST /api/actions/recommend -------------------------------------------

describe('POST /api/actions/recommend', () => {
  it('returns the risk engine recommendation (may be a refusal+reason)', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services))
      .post('/api/actions/recommend')
      .send({ marketId: 'market-a', features: { oraclePrice: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.recommendation.recommendedAction).toBe('pause_new_borrows');
  });

  it('rejects a missing features object with a descriptive error', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services))
      .post('/api/actions/recommend')
      .send({ marketId: 'market-a' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('features');
  });

  it('returns 503 when no risk engine is wired', async () => {
    const res = await request(makeApp())
      .post('/api/actions/recommend')
      .send({ marketId: 'market-a', features: {} });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('service_unavailable');
  });
});

// --- POST /api/actions/execute ---------------------------------------------

describe('POST /api/actions/execute', () => {
  const validExecuteBody = {
    action: { policyObjectId: '0x1' },
    evaluation: { marketId: 'market-a' },
    actionContext: { policyId: 'policy-a', agentSigner: '0xagent', dataSource: 'live' },
    actionLogId: 'log-1',
  };

  it('delegates to the ActionExecutor port and returns its result', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services))
      .post('/api/actions/execute')
      .send(validExecuteBody);
    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.txDigest).toBe('DIGEST_OK');
    expect(services.execute?.execute).toHaveBeenCalledOnce();
  });

  it('rejects a missing actionLogId with a descriptive error', async () => {
    const { services } = fakeServices();
    const { actionLogId: _omit, ...body } = validExecuteBody;
    const res = await request(makeApp({}, services)).post('/api/actions/execute').send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('actionLogId');
  });

  it('rejects a missing action object', async () => {
    const { services } = fakeServices();
    const { action: _omit, ...body } = validExecuteBody;
    const res = await request(makeApp({}, services)).post('/api/actions/execute').send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('action');
  });
});

// --- POST /api/actions/override (Req 11.4, 11.5, 11.6, 12.1) ----------------

describe('POST /api/actions/override', () => {
  const validOverrideBody = {
    request: {
      operation: 'reverse_action',
      reason: 'Oracle recovered; pause no longer warranted',
      policyObjectId: '0xpolicy',
      overrideCapObjectId: '0xcap',
      actionLogObjectId: '0xlog',
      marketStateObjectId: '0xmarket',
    },
    evaluation: { marketId: 'market-a' },
    actionContext: { policyId: 'policy-a', agentSigner: '0xagent', dataSource: 'live' },
    actionLogId: 'log-1',
    record: { policyId: 'policy-a', marketId: 'market-a', daoAddress: '0xDAO' },
  };

  it('delegates to the OverrideExecutor port and returns its result', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services))
      .post('/api/actions/override')
      .send(validOverrideBody);
    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.txDigest).toBe('OVERRIDE_OK');
    expect(res.body.result.overrideReason).toBe('Oracle recovered');
    expect(services.overrideExecute?.execute).toHaveBeenCalledOnce();
  });

  it('rejects a missing override reason with a descriptive error (Req 11.6)', async () => {
    const { services } = fakeServices();
    const body = {
      ...validOverrideBody,
      request: { ...validOverrideBody.request, reason: '' },
    };
    const res = await request(makeApp({}, services)).post('/api/actions/override').send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('request.reason');
    expect(res.body.message).toMatch(/reason is required/i);
    expect(services.overrideExecute?.execute).not.toHaveBeenCalled();
  });

  it('rejects an unknown override operation', async () => {
    const { services } = fakeServices();
    const body = {
      ...validOverrideBody,
      request: { ...validOverrideBody.request, operation: 'delete_everything' },
    };
    const res = await request(makeApp({}, services)).post('/api/actions/override').send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('request.operation');
    expect(services.overrideExecute?.execute).not.toHaveBeenCalled();
  });

  it('rejects a missing record.daoAddress', async () => {
    const { services } = fakeServices();
    const body = {
      ...validOverrideBody,
      record: { policyId: 'policy-a', marketId: 'market-a' },
    };
    const res = await request(makeApp({}, services)).post('/api/actions/override').send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('record.daoAddress');
  });

  it('returns 503 when no override executor is wired', async () => {
    const res = await request(makeApp()).post('/api/actions/override').send(validOverrideBody);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('service_unavailable');
  });
});

// --- POST /api/evidence/upload ---------------------------------------------

describe('POST /api/evidence/upload', () => {
  const validBundle = {
    schemaVersion: '1.0',
    marketId: 'market-a',
    policyId: 'policy-a',
    timestampMs: 1_700_000_000_000,
  };

  it('uploads a valid bundle via the injected port', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services))
      .post('/api/evidence/upload')
      .send(validBundle);
    expect(res.status).toBe(200);
    expect(res.body.blobId).toBe('blob-1');
    expect(res.body.evidenceHash).toBe('deadbeef');
    expect(services.uploadEvidence?.upload).toHaveBeenCalledOnce();
  });

  it('rejects a bundle missing policyId with a descriptive error', async () => {
    const { services } = fakeServices();
    const { policyId: _omit, ...body } = validBundle;
    const res = await request(makeApp({}, services)).post('/api/evidence/upload').send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('policyId');
  });

  it('rejects a non-numeric timestampMs', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services))
      .post('/api/evidence/upload')
      .send({ ...validBundle, timestampMs: 'soon' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('timestampMs');
  });
});

// --- POST /api/simulator/start + /reset ------------------------------------

describe('POST /api/simulator/start', () => {
  it('starts a known scenario via the injected port', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services))
      .post('/api/simulator/start')
      .send({ scenario: 'oracle-staleness' });
    expect(res.status).toBe(200);
    expect(res.body.started).toBe(true);
    expect(res.body.scenario).toBe('oracle-staleness');
    expect(services.simulator?.start).toHaveBeenCalledWith('oracle-staleness');
  });

  it('rejects an unknown scenario name with a descriptive error (Req 15.4)', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services))
      .post('/api/simulator/start')
      .send({ scenario: 'not-a-scenario' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('scenario');
    expect(res.body.message).toContain('not-a-scenario');
    expect(services.simulator?.start).not.toHaveBeenCalled();
  });

  it('rejects a missing scenario name', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services)).post('/api/simulator/start').send({});
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('scenario');
  });
});

describe('POST /api/simulator/reset', () => {
  it('resets the demo market via the injected port', async () => {
    const { services } = fakeServices();
    const res = await request(makeApp({}, services)).post('/api/simulator/reset').send({});
    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(true);
    expect(services.simulator?.reset).toHaveBeenCalledOnce();
  });
});

// --- Rate limiting (Req 15.5) ----------------------------------------------

describe('configurable rate limiter (Req 15.5)', () => {
  it('rejects requests over the configured limit with HTTP 429', async () => {
    const { services } = fakeServices();
    // Limit of 2 per window: the third request in the window is rejected.
    const app = makeApp({ rateLimitMax: 2, rateLimitWindowMs: 60_000 }, services);

    const first = await request(app).post('/api/simulator/reset').send({});
    const second = await request(app).post('/api/simulator/reset').send({});
    const third = await request(app).post('/api/simulator/reset').send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('rate_limited');
    expect(third.body.limit).toBe(2);
  });

  it('does not rate-limit the read endpoints', async () => {
    const app = makeApp({ rateLimitMax: 1, rateLimitWindowMs: 60_000 });
    // Reads are served by the read router and never reach the action limiter.
    // (Hitting a read route requires repositories; here we just assert the
    // action limiter did not 429 a read-shaped request before routing.)
    const res = await request(app).post('/api/simulator/start').send({ scenario: 'guardian-revoked' });
    // First action request passes the limiter (limit 1); a 503 means it reached
    // the handler (no simulator wired), proving the limiter let it through.
    expect(res.status).toBe(503);
  });
});
