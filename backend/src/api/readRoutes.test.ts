/**
 * HTTP-level tests for the REST read endpoints (Req 15.1, 3.2, 3.3, 3.5, 3.6).
 *
 * Each endpoint is exercised through the real Express app (`createApp`) with
 * in-memory fake repositories injected — no database. Tests assert the JSON
 * shape, 404 behaviour on missing resources, and wallet role resolution.
 */

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../config/env.js';
import type { Repositories } from '../db/repositories/index.js';
import type {
  ActionRow,
  IncidentRow,
  MarketRow,
  PolicyRow,
  RiskSnapshotRow,
} from '../db/types.js';
import { createApp } from '../server.js';

const testConfig: AppConfig = {
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

// --- Fixtures --------------------------------------------------------------

const OWNER = '0xowner';
const DAO = '0xdao';

const marketA: MarketRow = {
  id: 'market-a',
  on_chain_id: '0xmarketa',
  market_type: 'demo',
  name: 'Demo Lending A',
  status: 'Warning',
  freshness_threshold_ms: '60000',
  created_at: new Date('2024-01-01T00:00:00Z'),
};

const marketB: MarketRow = {
  id: 'market-b',
  on_chain_id: '0xmarketb',
  market_type: 'lending',
  name: 'Lending B',
  status: 'Normal',
  freshness_threshold_ms: '30000',
  created_at: new Date('2024-01-02T00:00:00Z'),
};

const policyA: PolicyRow = {
  id: 'policy-a',
  market_id: 'market-a',
  on_chain_policy_id: '0xpolicya',
  guardian_cap_id: '0xguardian',
  override_cap_id: '0xoverride',
  owner_address: OWNER,
  dao_address: DAO,
  allowed_actions: ['pause_market', 'adjust_ltv'],
  max_ltv_delta_bps: 500,
  max_margin_delta_bps: 300,
  pause_duration_limit_ms: '3600000',
  cooldown_ms: '60000',
  risk_thresholds: { warning: 50, guarded: 70, paused: 90 },
  is_revoked: false,
  is_paused: false,
  version: 1,
  walrus_config_blob_id: 'blob-config',
  created_at: new Date('2024-01-01T01:00:00Z'),
};

const actionA1: ActionRow = {
  id: 'action-a1',
  policy_id: 'policy-a',
  market_id: 'market-a',
  incident_id: 'incident-a',
  actor: '0xagent',
  actor_type: 'agent',
  risk_score: 72,
  action_type: 'adjust_ltv',
  old_value: '8000',
  new_value: '7500',
  walrus_evidence_blob_id: 'blob-evidence-1',
  evidence_hash: '0xhash',
  tx_digest: 'DIGEST_LATEST',
  is_reversed: false,
  reversed_by: null,
  reversal_tx_digest: null,
  override_reason: null,
  timestamp_ms: '1704070800000',
  created_at: new Date('2024-01-01T02:00:00Z'),
};

const actionA2: ActionRow = {
  ...actionA1,
  id: 'action-a2',
  action_type: 'pause_market',
  walrus_evidence_blob_id: 'blob-evidence-2',
  tx_digest: 'DIGEST_OLDER',
  timestamp_ms: '1704067200000',
  created_at: new Date('2024-01-01T01:30:00Z'),
};

const incidentA: IncidentRow = {
  id: 'incident-a',
  market_id: 'market-a',
  started_at: new Date('2024-01-01T01:30:00Z'),
  ended_at: null,
  scenario_id: 'oracle-stale',
  is_simulated: true,
  summary: null,
};

const snapshotA: RiskSnapshotRow = {
  id: 'snap-a',
  market_id: 'market-a',
  risk_score: 72,
  band: 'Guarded',
  classes: ['oracle_staleness'],
  confidence: 0.9,
  feature_vector: {
    oracleFreshnessMs: 12000,
    oracleConfidence: 0.95,
    volatility: 0.4,
    liquidity: 1_000_000,
    exposure: 250_000,
  },
  rule_outputs: { staleness_rule: 'tripped' },
  recommended_action: 'adjust_ltv',
  refusal_reason: null,
  model_version: 'v1',
  prompt_config_version: 'p1',
  explanation: 'Oracle is stale',
  is_simulated: true,
  data_source: 'simulated',
  created_at: new Date(), // fresh now
};

// --- Fake repositories -----------------------------------------------------

function buildRepositories(): Repositories {
  const markets = [marketA, marketB];
  const policies = [policyA];
  const actions = [actionA1, actionA2];
  const incidents = [incidentA];
  const snapshots = [snapshotA];

  const fakes = {
    markets: {
      list: async () => markets,
      getById: async (id: string) => markets.find((m) => m.id === id) ?? null,
    },
    riskSnapshots: {
      getLatestByMarket: async (marketId: string) =>
        snapshots
          .filter((s) => s.market_id === marketId)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null,
    },
    actions: {
      getById: async (id: string) => actions.find((a) => a.id === id) ?? null,
      listByMarket: async (marketId: string) =>
        actions
          .filter((a) => a.market_id === marketId)
          .sort((a, b) => Number(b.timestamp_ms) - Number(a.timestamp_ms)),
      listByIncident: async (incidentId: string) =>
        actions
          .filter((a) => a.incident_id === incidentId)
          .sort((a, b) => Number(a.timestamp_ms) - Number(b.timestamp_ms)),
    },
    incidents: {
      getById: async (id: string) => incidents.find((i) => i.id === id) ?? null,
    },
    policies: {
      listByMarketId: async (marketId: string) =>
        policies.filter((p) => p.market_id === marketId),
      listByOwnerAddress: async (owner: string) =>
        policies.filter((p) => p.owner_address === owner),
      listByDaoAddress: async (dao: string) =>
        policies.filter((p) => p.dao_address === dao),
    },
  };

  // The read routes only touch the methods above; cast through unknown so the
  // fake satisfies the full Repositories bundle type for createApp.
  return fakes as unknown as Repositories;
}

function makeApp() {
  return createApp(testConfig, { repositories: buildRepositories() });
}

// --- Tests -----------------------------------------------------------------

describe('GET /api/markets', () => {
  it('lists monitored markets with their statuses (Req 3.2)', async () => {
    const res = await request(makeApp()).get('/api/markets');
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('DeFi User');
    expect(res.body.markets).toHaveLength(2);
    const statuses = (res.body.markets as Array<{ id: string; status: string }>).map(
      (m) => [m.id, m.status],
    );
    expect(statuses).toContainEqual(['market-a', 'Warning']);
    expect(statuses).toContainEqual(['market-b', 'Normal']);
  });
});

describe('GET /api/markets/:id', () => {
  it('returns market detail with params, last action, digest, blob id, override status (Req 3.6)', async () => {
    const res = await request(makeApp()).get('/api/markets/market-a');
    expect(res.status).toBe(200);
    expect(res.body.market.id).toBe('market-a');
    expect(res.body.params.id).toBe('policy-a');
    expect(res.body.params.allowedActions).toEqual(['pause_market', 'adjust_ltv']);
    // Most recent action by timestamp wins.
    expect(res.body.lastAction.id).toBe('action-a1');
    expect(res.body.lastTxDigest).toBe('DIGEST_LATEST');
    expect(res.body.lastWalrusBlobId).toBe('blob-evidence-1');
    expect(res.body.daoOverrideStatus).toBe('none');
  });

  it('returns 404 for a missing market', async () => {
    const res = await request(makeApp()).get('/api/markets/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('market_not_found');
  });
});

describe('GET /api/markets/:id/risk', () => {
  it('returns current risk score, band, indicators, and freshness (Req 3.3, 3.5)', async () => {
    const res = await request(makeApp()).get('/api/markets/market-a/risk');
    expect(res.status).toBe(200);
    expect(res.body.riskScore).toBe(72);
    expect(res.body.band).toBe('Guarded');
    expect(res.body.indicators.oracleConfidence).toBe(0.95);
    expect(res.body.indicators.volatility).toBe(0.4);
    expect(res.body.freshness.thresholdMs).toBe(60000);
    expect(res.body.freshness.stale).toBe(false);
  });

  it('returns 404 for a missing market', async () => {
    const res = await request(makeApp()).get('/api/markets/nope/risk');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('market_not_found');
  });
});

describe('GET /api/incidents/:id', () => {
  it('returns an incident with its action timeline ordered oldest-first', async () => {
    const res = await request(makeApp()).get('/api/incidents/incident-a');
    expect(res.status).toBe(200);
    expect(res.body.incident.id).toBe('incident-a');
    const ids = (res.body.timeline as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toEqual(['action-a2', 'action-a1']);
  });

  it('returns 404 for a missing incident', async () => {
    const res = await request(makeApp()).get('/api/incidents/missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('incident_not_found');
  });
});

describe('GET /api/actions/:id', () => {
  it('returns a single action record', async () => {
    const res = await request(makeApp()).get('/api/actions/action-a1');
    expect(res.status).toBe(200);
    expect(res.body.action.id).toBe('action-a1');
    expect(res.body.action.txDigest).toBe('DIGEST_LATEST');
  });

  it('returns 404 for a missing action', async () => {
    const res = await request(makeApp()).get('/api/actions/missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('action_not_found');
  });
});

describe('role resolution (Req 15.1)', () => {
  it('defaults to DeFi User without a wallet header', async () => {
    const res = await request(makeApp()).get('/api/markets');
    expect(res.body.role).toBe('DeFi User');
  });

  it('resolves Protocol_Admin for a policy owner', async () => {
    const res = await request(makeApp())
      .get('/api/markets')
      .set('x-wallet-address', OWNER);
    expect(res.body.role).toBe('Protocol_Admin');
  });

  it('resolves DAO_Governor for an OverrideCap (DAO) holder', async () => {
    const res = await request(makeApp())
      .get('/api/markets')
      .set('x-wallet-address', DAO);
    expect(res.body.role).toBe('DAO_Governor');
  });

  it('resolves DeFi User for an unknown wallet', async () => {
    const res = await request(makeApp())
      .get('/api/markets')
      .set('x-wallet-address', '0xstranger');
    expect(res.body.role).toBe('DeFi User');
  });
});
