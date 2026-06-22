/**
 * End-to-end wiring test for the composition root (task 21.1).
 *
 * Proves the full risk-control loop is connected with NO orphaned components,
 * using only in-memory fakes (no live RPC / DB / Walrus / Redis):
 *
 *   worker reading → MarketFeatureAssembler → RiskControlLoop
 *      → Risk Engine (fail-closed) crosses a threshold
 *      → Action Executor runs the network-gated flow (evidence uploaded BEFORE
 *        the PTB is built/simulated → simulate → submit → link)
 *      → a `risk_update` AND an `action_executed` WebSocket message reach a
 *        subscribed listener
 *   on-chain RiskActionExecuted event → ProtocolStateIndexer
 *      → an `actions` row is persisted AND the linked Walrus evidence is flipped
 *      → restart from the persisted checkpoint reprocesses nothing
 *
 * The real {@link RiskControlLoop}, {@link ActionExecutor},
 * {@link FailClosedRiskEngine}, {@link MarketFeatureAssembler},
 * {@link DefaultActionRequestPlanner}, and {@link ProtocolStateIndexer} are
 * wired by {@link buildComposition}; only their leaf infra collaborators are
 * faked. (Req 3.7, 9.4, 9.5, 17.7, 17.8)
 */

import { describe, expect, it } from 'vitest';

import { ActionExecutor } from './action/actionExecutor.js';
import type {
  DryRunResponseLike,
  EvidenceCoordinator,
  NetworkVerifier,
  SubmitResponseLike,
  TransactionSimulator,
  TransactionSubmitter,
} from './action/actionExecutor.js';
import { buildComposition } from './composition.js';
import type { AppConfig } from './config/env.js';
import type { Repositories } from './db/repositories/index.js';
import type {
  ActionInsert,
  ActionRow,
  MarketRow,
  MarketStatus,
  PolicyRow,
  WalrusBlobRow,
} from './db/types.js';
import { InMemoryCheckpointStore, ProtocolStateIndexer } from './indexer/index.js';
import type { EventPage, EventQuery, SuiEventSource } from './indexer/index.js';
import { DefaultActionRequestPlanner } from './loop/actionRequestPlanner.js';
import { DeterministicRiskEngine, FailClosedRiskEngine } from './risk/index.js';
import type { ServerMessage } from './ws/messages.js';
import type { WsConnection } from './ws/subscriptionRegistry.js';

const OBJECT_ID = `0x${'1'.repeat(64)}`;
const FIXED_NOW = 2_000_000_000_000;
const OLD_ORACLE_TS = 1_000_000_000_000; // ~1000s old → far beyond the threshold

const config: AppConfig = {
  nodeEnv: 'test',
  port: 0,
  suiRpcUrl: 'https://fullnode.testnet.sui.io:443',
  suiTestnetChainId: '4c78adac',
  packageIds: { policy: 'pkg', demoMarket: 'demo', adapters: 'adapters' },
  walrusPublisherUrl: 'https://publisher.walrus-testnet.walrus.space',
  walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
  databaseUrl: 'postgresql://localhost:5432/sentinel',
  redisUrl: 'redis://localhost:6379',
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  llm: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
};

/** In-memory repositories satisfying the indexer's repo ports. */
function makeFakeRepositories(): {
  repositories: Repositories;
  created: ActionInsert[];
  linked: Array<{ blobId: string; actionId: string; hash: string }>;
} {
  const created: ActionInsert[] = [];
  const linked: Array<{ blobId: string; actionId: string; hash: string }> = [];
  const actionsByDigest = new Map<string, ActionRow>();

  const market: MarketRow = {
    id: 'market-uuid',
    on_chain_id: 'market-onchain',
    market_type: 'demo',
    name: 'Demo Market',
    status: 'Normal',
    freshness_threshold_ms: '1000',
    created_at: new Date(),
  };
  const policy: PolicyRow = {
    id: 'policy-uuid',
    market_id: 'market-uuid',
    on_chain_policy_id: 'policy-onchain',
    guardian_cap_id: 'gcap',
    override_cap_id: 'ocap',
    owner_address: '0xowner',
    dao_address: '0xdao',
    allowed_actions: ['pause_new_borrows'],
    max_ltv_delta_bps: 1000,
    max_margin_delta_bps: 1000,
    pause_duration_limit_ms: '86400000',
    cooldown_ms: '0',
    risk_thresholds: {},
    is_revoked: false,
    is_paused: false,
    version: 1,
    walrus_config_blob_id: null,
    created_at: new Date(),
  };
  let blob: WalrusBlobRow | null = {
    blob_id: 'blob-1',
    action_id: null,
    market_id: 'market-uuid',
    status: 'uploaded',
    evidence_hash: null,
    attempt_count: 1,
    last_attempt_at: new Date(),
    payload: null,
    created_at: new Date(),
  };

  const repositories = {
    actions: {
      getByTxDigest: async (txDigest: string) => actionsByDigest.get(txDigest) ?? null,
      create: async (input: ActionInsert): Promise<ActionRow> => {
        created.push(input);
        const row: ActionRow = {
          id: `action-${created.length}`,
          policy_id: input.policy_id,
          market_id: input.market_id,
          incident_id: null,
          actor: input.actor,
          actor_type: input.actor_type,
          risk_score: input.risk_score ?? null,
          action_type: input.action_type,
          old_value: input.old_value ?? null,
          new_value: input.new_value ?? null,
          walrus_evidence_blob_id: input.walrus_evidence_blob_id ?? null,
          evidence_hash: input.evidence_hash ?? null,
          tx_digest: input.tx_digest ?? null,
          is_reversed: false,
          reversed_by: null,
          reversal_tx_digest: null,
          override_reason: input.override_reason ?? null,
          timestamp_ms: String(input.timestamp_ms),
          created_at: new Date(),
        };
        if (row.tx_digest) {
          actionsByDigest.set(row.tx_digest, row);
        }
        return row;
      },
    },
    walrusBlobs: {
      getById: async (blobId: string) => (blob && blob.blob_id === blobId ? blob : null),
      linkToAction: async (blobId: string, actionId: string, hash: string) => {
        linked.push({ blobId, actionId, hash });
        if (blob && blob.blob_id === blobId) {
          blob = { ...blob, action_id: actionId, evidence_hash: hash, status: 'linked_on_chain' };
        }
        return blob;
      },
    },
    markets: {
      getByOnChainId: async (onChainId: string) =>
        onChainId === market.on_chain_id ? market : null,
      updateStatus: async (_id: string, _status: MarketStatus) => market,
    },
    policies: {
      getByOnChainPolicyId: async (onChainPolicyId: string) =>
        onChainPolicyId === policy.on_chain_policy_id ? policy : null,
      setRevoked: async (_id: string, _isRevoked: boolean) => policy,
    },
  } as unknown as Repositories;

  return { repositories, created, linked };
}

/** A cursor-aware fake event source serving a single RiskActionExecuted event. */
function makeEventSource(): SuiEventSource {
  const raw = {
    id: { txDigest: '0xdigest', eventSeq: '0' },
    type: '0xpkg::policy::RiskActionExecuted',
    parsedJson: {
      policy_id: 'policy-onchain',
      market_id: 'market-onchain',
      action_type: 0,
      risk_score: 80,
      old_value: '0',
      new_value: '0',
      evidence_blob_id: 'blob-1',
      evidence_hash: '0xabcd',
    },
    sender: '0xowner',
    timestampMs: String(FIXED_NOW),
  };
  return {
    queryEvents: async (query: EventQuery): Promise<EventPage> => {
      // Events come AFTER the cursor; with a null cursor serve the event, with
      // any persisted cursor serve nothing (restart resumes cleanly).
      if (query.cursor == null) {
        return { data: [raw], nextCursor: raw.id, hasNextPage: false };
      }
      return { data: [], nextCursor: query.cursor, hasNextPage: false };
    },
  };
}

/** Build the real ActionExecutor with fakes recording the call timeline. */
function makeActionExecutor(timeline: string[]): ActionExecutor {
  const network: NetworkVerifier = {
    verifySubmissionTarget: async () => {
      timeline.push('network');
    },
    verifyDigestOrigin: async () => true,
  };
  const evidence: EvidenceCoordinator = {
    generate: () => ({}) as never,
    upload: async () => {
      timeline.push('upload');
      return { blobId: 'blob-1', evidenceHash: 'abcd' };
    },
    link: async () => {
      timeline.push('link');
    },
  };
  const simulator: TransactionSimulator = {
    dryRun: async (): Promise<DryRunResponseLike> => {
      timeline.push('simulate');
      return { effects: { status: { status: 'success' } }, events: [] };
    },
  };
  const submitter: TransactionSubmitter = {
    submit: async (): Promise<SubmitResponseLike> => {
      timeline.push('submit');
      return { txDigest: '0xdigest', events: [{ kind: 'RiskActionExecuted' }] };
    },
  };
  return new ActionExecutor({ policyPackageId: 'pkg' }, simulator, {
    network,
    evidence,
    submitter,
  });
}

function buildWiredComposition() {
  const { repositories, created, linked } = makeFakeRepositories();
  const timeline: string[] = [];
  const checkpointStore = new InMemoryCheckpointStore();
  const indexerSource = makeEventSource();

  const riskEngine = new FailClosedRiskEngine(new DeterministicRiskEngine());
  const actionExecutor = makeActionExecutor(timeline);
  const planner = new DefaultActionRequestPlanner({
    now: () => FIXED_NOW,
    markets: [
      {
        marketId: 'demo-market',
        policyId: 'policy-onchain',
        policyObjectId: OBJECT_ID,
        guardianCapObjectId: OBJECT_ID,
        marketStateObjectId: OBJECT_ID,
        agentSigner: '0xagent',
        defaultPauseDurationMs: 3_600_000,
      },
    ],
  });

  const composition = buildComposition({
    config,
    repositories,
    riskEngine,
    actionExecutor,
    planner,
    now: () => FIXED_NOW,
    assemblerMarkets: [
      {
        marketId: 'demo-market',
        freshnessThresholdMs: 1000,
        utilization: 0.5,
        exposure: 1_000_000,
        currentMaxLtvBps: 7500,
        policy: { allowedActions: ['pause_new_borrows'] },
        policyPermitsStalePause: true,
      },
    ],
    indexerSource,
    checkpointStore,
  });

  return { composition, repositories, created, linked, timeline, checkpointStore, indexerSource };
}

/** Subscribe a fake WS connection to a market and capture received messages. */
function subscribeListener(
  composition: ReturnType<typeof buildWiredComposition>['composition'],
  marketId: string,
): ServerMessage[] {
  const received: ServerMessage[] = [];
  const conn: WsConnection = {
    send: (data: string) => received.push(JSON.parse(data) as ServerMessage),
  };
  composition.registry.subscribe(conn, marketId);
  return received;
}

describe('composition root — full risk-control loop wiring (task 21.1)', () => {
  it('drives workers → risk → action → WS and indexer persistence end-to-end', async () => {
    const wired = buildWiredComposition();
    const received = subscribeListener(wired.composition, 'demo-market');

    // 1. A worker oracle reading flows through the assembler into the loop.
    //    The stale timestamp forces a fail-closed emergency pause (threshold
    //    crossing), which runs the full network-gated action flow.
    await wired.composition.assembler.oracleSink.record({
      marketId: 'demo-market',
      feedId: 'feed-1',
      price: '1000000',
      confidence: '100',
      timestampMs: OLD_ORACLE_TS,
      observedAtMs: FIXED_NOW,
    });

    // 2. The loop pushed a live risk_update AND an action_executed to the
    //    subscribed dashboard. (Req 3.7, 9.4)
    const types = received.map((m) => m.type);
    expect(types).toContain('risk_update');
    expect(types).toContain('action_executed');

    const actionMsg = received.find((m) => m.type === 'action_executed');
    expect(actionMsg).toBeDefined();
    if (actionMsg && actionMsg.type === 'action_executed') {
      expect(actionMsg.action.txDigest).toBe('0xdigest');
      expect(actionMsg.action.walrusEvidenceBlobId).toBe('blob-1');
      expect(actionMsg.action.actionType).toBe('pause_new_borrows');
    }

    // 3. Evidence was uploaded BEFORE the PTB was built/simulated. (Req 9.1)
    expect(wired.timeline[0]).toBe('network');
    expect(wired.timeline.indexOf('upload')).toBeLessThan(wired.timeline.indexOf('simulate'));
    expect(wired.timeline.indexOf('simulate')).toBeLessThan(wired.timeline.indexOf('submit'));
    expect(wired.timeline).toEqual(['network', 'upload', 'simulate', 'submit', 'link']);

    // 4. The indexer observes the on-chain RiskActionExecuted event, persists
    //    the action row, and flips the linked evidence to linked_on_chain.
    //    (Req 9.4, 9.5, 17.6)
    const run1 = await wired.composition.indexer.runOnce();
    expect(run1.actionsPersisted).toBe(1);
    expect(run1.evidenceLinked).toBe(1);
    expect(wired.created).toHaveLength(1);
    expect(wired.created[0]?.tx_digest).toBe('0xdigest');
    expect(wired.created[0]?.walrus_evidence_blob_id).toBe('blob-1');
    expect(wired.linked).toEqual([
      { blobId: 'blob-1', actionId: 'action-1', hash: '0xabcd' },
    ]);

    // 5. Restart recovery: a fresh indexer over the SAME persisted checkpoint
    //    resumes and reprocesses nothing. (Req 17.7, 17.8)
    const restarted = new ProtocolStateIndexer({
      source: wired.indexerSource,
      checkpoints: wired.checkpointStore,
      actions: wired.repositories.actions,
      walrus: wired.repositories.walrusBlobs,
      markets: wired.repositories.markets,
      policies: wired.repositories.policies,
      publisher: wired.composition.publisher,
    });
    const run2 = await restarted.runOnce();
    expect(run2.processed).toBe(0);
    expect(run2.actionsPersisted).toBe(0);
    expect(wired.created).toHaveLength(1);
  });

  it('exposes the recommend port and every action service from the composition', () => {
    const wired = buildWiredComposition();
    const services = wired.composition.actionServices;
    expect(services.recommend).toBeDefined();
    expect(services.execute).toBeDefined();
    // No orphaned components: the loop, assembler, and indexer are all reachable.
    expect(wired.composition.loop).toBeDefined();
    expect(wired.composition.assembler).toBeDefined();
    expect(wired.composition.indexer).toBeDefined();
  });

  it('publishes guardian_revoked through the same registry when the indexer sees a revocation', async () => {
    const wired = buildWiredComposition();
    const received = subscribeListener(wired.composition, 'market-uuid');

    const revokeSource: SuiEventSource = {
      queryEvents: async (query: EventQuery): Promise<EventPage> => {
        if (query.cursor == null) {
          return {
            data: [
              {
                id: { txDigest: '0xrevoke', eventSeq: '0' },
                type: '0xpkg::policy::GuardianRevoked',
                parsedJson: {
                  policy_id: 'policy-onchain',
                  guardian_cap_id: 'gcap',
                  dao_address: '0xdao',
                },
                sender: '0xdao',
                timestampMs: String(FIXED_NOW),
              },
            ],
            nextCursor: { txDigest: '0xrevoke', eventSeq: '0' },
            hasNextPage: false,
          };
        }
        return { data: [], nextCursor: query.cursor, hasNextPage: false };
      },
    };

    const indexer = new ProtocolStateIndexer({
      source: revokeSource,
      checkpoints: new InMemoryCheckpointStore(),
      actions: wired.repositories.actions,
      walrus: wired.repositories.walrusBlobs,
      markets: wired.repositories.markets,
      policies: wired.repositories.policies,
      publisher: wired.composition.publisher,
    });

    const result = await indexer.runOnce();
    expect(result.revocations).toBe(1);
    expect(received.map((m) => m.type)).toContain('guardian_revoked');
  });
});
