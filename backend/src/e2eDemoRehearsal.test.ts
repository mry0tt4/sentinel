/**
 * End-to-end demo rehearsal test (task 21.2).
 *
 * A SCRIPTED rehearsal of the full judge-facing demo path, in order:
 *
 *   1. Deploy a policy via the wizard (sign-to-deploy) → on-chain object ids + tx digest
 *   2. Run a scenario (the Simulation_Lab "oracle staleness" climax, fed through
 *      the live loop's oracle sink) → the Risk Engine escalates fail-closed
 *   3. Observe the AUTONOMOUS `pause_new_borrows` action (the PTB) execute with
 *      strict evidence-before-PTB ordering
 *   4. Verify the on-chain ActionLog + `RiskActionExecuted` event + Walrus
 *      Blob_ID + tx digest are produced (the indexer persists the row + links
 *      the evidence)
 *   5. Perform a DAO reverse (Override_Console `reverse_action`)
 *   6. Revoke the guardian (Override_Console `revoke_guardian`)
 *   7. Confirm a SUBSEQUENT autonomous action is REJECTED because the guardian
 *      is revoked (fail-closed, Req 12.3)
 *
 * (Req 1.6, 7.1, 9.4, 12.3, 14.3)
 *
 * ── Live vs. faked split ───────────────────────────────────────────────────
 * A TRUE on-chain rehearsal needs the three Move packages published to Sui
 * Testnet and a funded agent signer. Until those exist, the LIVE variant is
 * gated (mirroring `oracleAdapter.integration.test.ts` /
 * `walrusUpload.integration.test.ts`): it runs ONLY when `RUN_INTEGRATION=1`
 * AND `deployments/testnet.json` carries real (non-placeholder) package ids;
 * otherwise it SKIPS with a clear message so the suite stays green in CI
 * without a funded wallet.
 *
 * To keep the rehearsal LOGIC exercised in CI, the FAKED variant runs the exact
 * same scripted sequence deterministically with in-memory fakes (mirroring
 * `composition.test.ts`): it wires the real {@link RiskControlLoop},
 * {@link FailClosedRiskEngine}, {@link ActionExecutor},
 * {@link DefaultActionRequestPlanner}, {@link ProtocolStateIndexer}, and
 * {@link OverrideExecutor} via {@link buildComposition} and only fakes their
 * leaf infra collaborators (no live RPC / DB / Walrus / Redis).
 *
 * NOTE: a real on-chain rehearsal still requires funding the agent wallet and
 * running `./scripts/deploy_testnet.sh` to publish the packages and record the
 * real ids into `deployments/testnet.json`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { ActionExecutor } from './action/actionExecutor.js';
import type {
  DryRunResponseLike,
  EvidenceCoordinator,
  NetworkVerifier,
  SubmitResponseLike,
  TransactionSimulator,
  TransactionSubmitter,
} from './action/actionExecutor.js';
import {
  OverrideExecutor,
  type OverrideActionRecord,
  type OverrideActionRecorder,
  type OverrideExecuteRequest,
} from './action/overrideExecutor.js';
import { OVERRIDE_OPERATION, type OverrideActionRequest } from './action/types.js';
import type { DraftedPolicy } from './api/actionRoutes.js';
import { buildComposition, createProductionComposition } from './composition.js';
import type { AppConfig, AppSecrets } from './config/env.js';
import type { Repositories } from './db/repositories/index.js';
import type {
  ActionInsert,
  ActionRow,
  MarketRow,
  MarketStatus,
  PolicyRow,
  WalrusBlobRow,
} from './db/types.js';
import type { ActionContext, EvidenceBundle } from './evidence/types.js';
import { InMemoryCheckpointStore } from './indexer/index.js';
import type { EventPage, EventQuery, SuiEventSource } from './indexer/index.js';
import { DefaultActionRequestPlanner } from './loop/actionRequestPlanner.js';
import type { MarketAssemblerConfig } from './loop/marketFeatureAssembler.js';
import { DeterministicRiskEngine, FailClosedRiskEngine } from './risk/index.js';
import type { FeatureVector, RiskEvaluation } from './risk/types.js';
import type { ServerMessage } from './ws/messages.js';
import type { WsConnection } from './ws/subscriptionRegistry.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const OBJECT_ID = `0x${'1'.repeat(64)}`;
const FIXED_NOW = 2_000_000_000_000;
/** A reading far older than the freshness threshold → fail-closed stale pause. */
const STALE_ORACLE_TS = 1_000_000_000_000;

const MARKET_ID = 'demo-market';
const POLICY_ON_CHAIN_ID = 'policy-onchain';
const MARKET_ON_CHAIN_ID = 'market-onchain';
const BLOB_ID = 'walrus-blob-rehearsal';
const EVIDENCE_HASH_HEX = 'deadbeefcafef00d';
const ON_CHAIN_EVIDENCE_HASH = '0xabcd';
const TX_DIGEST = '0xrehearsaldigest';

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

// ---------------------------------------------------------------------------
// Step 1 helper — wizard sign-to-deploy (the policy-deployment path)
// ---------------------------------------------------------------------------

/** What the wizard's sign-to-deploy PTB yields on success. (Req 4.10) */
interface DeployedPolicy {
  txDigest: string;
  policyObjectId: string;
  guardianCapObjectId: string;
  overrideCapObjectId: string;
  marketStateObjectId: string;
  policyOnChainId: string;
  marketOnChainId: string;
}

/**
 * Model the wizard's review → sign → deploy step. The real wizard builds a
 * server-defined policy-deployment PTB, the connected testnet wallet signs it,
 * and the resulting object ids + tx digest are persisted. Here a fake captures
 * the drafted policy and returns deterministic ids so the rest of the rehearsal
 * is driven by the "deployed" objects.
 */
function deployPolicyViaWizard(
  draft: DraftedPolicy,
  recordedDrafts: DraftedPolicy[],
): DeployedPolicy {
  recordedDrafts.push(draft);
  return {
    txDigest: '0xdeploydigest',
    policyObjectId: OBJECT_ID,
    guardianCapObjectId: OBJECT_ID,
    overrideCapObjectId: OBJECT_ID,
    marketStateObjectId: OBJECT_ID,
    policyOnChainId: POLICY_ON_CHAIN_ID,
    marketOnChainId: MARKET_ON_CHAIN_ID,
  };
}

function sampleDraft(): DraftedPolicy {
  return {
    marketId: MARKET_ID,
    allowedActions: ['pause_new_borrows', 'reduce_max_ltv'],
    maxLtvDeltaBps: 1_000,
    maxMarginDeltaBps: 1_000,
    pauseDurationLimitMs: 86_400_000,
    cooldownMs: 0,
    daoAddress: '0xdao',
    riskThresholds: {},
  };
}

// ---------------------------------------------------------------------------
// In-memory repositories (indexer ports) — mirrors composition.test.ts
// ---------------------------------------------------------------------------

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
    on_chain_id: MARKET_ON_CHAIN_ID,
    market_type: 'demo',
    name: 'Demo Market',
    status: 'Normal',
    freshness_threshold_ms: '1000',
    created_at: new Date(),
  };
  const policy: PolicyRow = {
    id: 'policy-uuid',
    market_id: 'market-uuid',
    on_chain_policy_id: POLICY_ON_CHAIN_ID,
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
    blob_id: BLOB_ID,
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
function makeRiskActionEventSource(): SuiEventSource {
  const raw = {
    id: { txDigest: TX_DIGEST, eventSeq: '0' },
    type: '0xpkg::policy::RiskActionExecuted',
    parsedJson: {
      policy_id: POLICY_ON_CHAIN_ID,
      market_id: MARKET_ON_CHAIN_ID,
      action_type: 0, // pause_new_borrows
      risk_score: 80,
      old_value: '0',
      new_value: '0',
      evidence_blob_id: BLOB_ID,
      evidence_hash: ON_CHAIN_EVIDENCE_HASH,
    },
    sender: '0xowner',
    timestampMs: String(FIXED_NOW),
  };
  return {
    queryEvents: async (query: EventQuery): Promise<EventPage> => {
      if (query.cursor == null) {
        return { data: [raw], nextCursor: raw.id, hasNextPage: false };
      }
      return { data: [], nextCursor: query.cursor, hasNextPage: false };
    },
  };
}

/**
 * Build the real {@link ActionExecutor} with fakes that record the call
 * timeline (so we can assert evidence-before-PTB ordering) and return the
 * rehearsal's fixed Blob_ID + tx digest.
 */
function makeActionExecutor(timeline: string[]): ActionExecutor {
  const network: NetworkVerifier = {
    verifySubmissionTarget: async () => {
      timeline.push('network');
    },
    verifyDigestOrigin: async () => true,
  };
  const evidence: EvidenceCoordinator = {
    generate: () => ({}) as unknown as EvidenceBundle,
    upload: async () => {
      timeline.push('upload');
      return { blobId: BLOB_ID, evidenceHash: EVIDENCE_HASH_HEX };
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
      return {
        txDigest: TX_DIGEST,
        events: [{ kind: 'RiskActionExecuted' }],
        effects: { status: { status: 'success' } },
      };
    },
  };
  return new ActionExecutor({ policyPackageId: 'pkg' }, simulator, {
    network,
    evidence,
    submitter,
  });
}

// ---------------------------------------------------------------------------
// Override Executor fakes (DAO reverse + guardian revoke)
// ---------------------------------------------------------------------------

interface OverrideHarness {
  executor: OverrideExecutor;
  callLog: string[];
  createdRecords: OverrideActionRecord[];
  reversedCalls: Array<{ id: string; by: string; digest: string }>;
}

function makeOverrideHarness(): OverrideHarness {
  const callLog: string[] = [];
  const createdRecords: OverrideActionRecord[] = [];
  const reversedCalls: Array<{ id: string; by: string; digest: string }> = [];

  const network: NetworkVerifier = {
    async verifySubmissionTarget(packageId: string): Promise<void> {
      callLog.push(`network.verifySubmissionTarget:${packageId}`);
    },
    async verifyDigestOrigin(txDigest: string): Promise<boolean> {
      callLog.push(`network.verifyDigestOrigin:${txDigest}`);
      return true;
    },
  };
  const evidence: EvidenceCoordinator = {
    generate(_evaluation: RiskEvaluation, actionContext: ActionContext): EvidenceBundle {
      callLog.push('evidence.generate');
      return { overrideReason: actionContext.overrideReason } as unknown as EvidenceBundle;
    },
    async upload(): Promise<{ blobId: string; evidenceHash: string }> {
      callLog.push('evidence.upload');
      return { blobId: 'override-blob', evidenceHash: 'cafef00ddeadbeef' };
    },
    async link(): Promise<void> {
      callLog.push('evidence.link');
    },
  };
  const submitter: TransactionSubmitter = {
    async submit(): Promise<SubmitResponseLike> {
      callLog.push('submitter.submit');
      return {
        txDigest: '0xoverridedigest',
        events: [{ type: 'RiskActionOverridden' }],
        effects: { status: { status: 'success' } },
      };
    },
  };
  const simulator: TransactionSimulator = {
    async dryRun(): Promise<DryRunResponseLike> {
      callLog.push('simulator.dryRun');
      return { effects: { status: { status: 'success' } }, events: [] };
    },
  };
  const recorder: OverrideActionRecorder = {
    async create(input: OverrideActionRecord): Promise<{ id: string }> {
      callLog.push('recorder.create');
      createdRecords.push(input);
      return { id: `override-action-${createdRecords.length}` };
    },
    async markReversed(id: string, reversedBy: string, reversalTxDigest: string): Promise<unknown> {
      callLog.push(`recorder.markReversed:${id}`);
      reversedCalls.push({ id, by: reversedBy, digest: reversalTxDigest });
      return undefined;
    },
  };

  const executor = new OverrideExecutor({ policyPackageId: 'pkg' }, simulator, {
    network,
    evidence,
    submitter,
    recorder,
  });

  return { executor, callLog, createdRecords, reversedCalls };
}

function makeEvaluation(): RiskEvaluation {
  const featureVector: FeatureVector = {
    oraclePrice: 2.0,
    oracleConfidence: 0.002,
    oracleTimestampMs: FIXED_NOW - 5_000,
    nowMs: FIXED_NOW,
    freshnessThresholdMs: 60_000,
    priceChange1mPct: 0,
    priceChange5mPct: 0,
    priceChange15mPct: 0,
    realizedVolatilityPct: 1,
    liquidityDepth: 1_000_000,
    spreadBps: 5,
    imbalance: 0,
    utilization: 0.4,
    exposure: 2_000_000,
    currentMaxLtvBps: 7_500,
    borrowPaused: true,
    guardedMode: false,
    policyActive: true,
    guardianRevoked: false,
    priorActionsCount: 1,
    priorOverridesCount: 0,
    historicalEvidenceRefs: [],
  };
  return {
    marketId: MARKET_ID,
    riskScore: 42,
    band: 'Warning',
    classes: ['liquidity collapse'],
    recommendedAction: null,
    confidence: 70,
    explanation: 'Conditions normalized.',
    ruleOutputs: [],
    modelVersion: 'risk-model@1.0.0',
    promptConfigVersion: 'prompt@1.0.0',
    featureVector,
  };
}

function overrideInput(
  request: OverrideActionRequest,
  deployed: DeployedPolicy,
  originalActionId: string | undefined,
): OverrideExecuteRequest {
  return {
    request,
    evaluation: makeEvaluation(),
    actionContext: {
      policyId: 'policy-uuid',
      agentSigner: '0xagentpublic',
      dataSource: 'live',
    },
    actionLogId: 'on-chain-log-1',
    record: {
      policyId: 'policy-uuid',
      marketId: 'market-uuid',
      daoAddress: '0xdao',
      originalActionId,
    },
  };
}

// ---------------------------------------------------------------------------
// Faked composition wiring (mirrors composition.test.ts)
// ---------------------------------------------------------------------------

function buildRehearsalComposition(deployed: DeployedPolicy) {
  const { repositories, created, linked } = makeFakeRepositories();
  const timeline: string[] = [];
  const checkpointStore = new InMemoryCheckpointStore();
  const indexerSource = makeRiskActionEventSource();

  const riskEngine = new FailClosedRiskEngine(new DeterministicRiskEngine());
  const actionExecutor = makeActionExecutor(timeline);
  const planner = new DefaultActionRequestPlanner({
    now: () => FIXED_NOW,
    markets: [
      {
        marketId: MARKET_ID,
        policyId: deployed.policyOnChainId,
        policyObjectId: deployed.policyObjectId,
        guardianCapObjectId: deployed.guardianCapObjectId,
        marketStateObjectId: deployed.marketStateObjectId,
        agentSigner: '0xagentpublic',
        defaultPauseDurationMs: 3_600_000,
      },
    ],
  });

  // A single, MUTABLE market config: revoking the guardian later flips
  // `guardianRevoked` so the subsequent tick fails closed. (Req 12.3)
  const marketConfig: MarketAssemblerConfig = {
    marketId: MARKET_ID,
    freshnessThresholdMs: 1000,
    utilization: 0.5,
    exposure: 1_000_000,
    currentMaxLtvBps: 7500,
    guardianRevoked: false,
    policy: { allowedActions: ['pause_new_borrows'] },
    policyPermitsStalePause: true,
  };

  const composition = buildComposition({
    config,
    repositories,
    riskEngine,
    actionExecutor,
    planner,
    now: () => FIXED_NOW,
    assemblerMarkets: [marketConfig],
    indexerSource,
    checkpointStore,
  });

  return { composition, repositories, created, linked, timeline, marketConfig };
}

/** Subscribe a fake WS connection to a market and capture received messages. */
function subscribeListener(
  registry: ReturnType<typeof buildRehearsalComposition>['composition']['registry'],
  marketId: string,
): ServerMessage[] {
  const received: ServerMessage[] = [];
  const conn: WsConnection = {
    send: (data: string) => received.push(JSON.parse(data) as ServerMessage),
  };
  registry.subscribe(conn, marketId);
  return received;
}

/** Record the "oracle staleness" scenario climax reading into the live loop. */
async function feedStaleOracleReading(
  composition: ReturnType<typeof buildRehearsalComposition>['composition'],
): Promise<void> {
  await composition.assembler.oracleSink.record({
    marketId: MARKET_ID,
    feedId: 'feed-1',
    price: '1000000',
    confidence: '100',
    timestampMs: STALE_ORACLE_TS,
    observedAtMs: FIXED_NOW,
  });
}

// ---------------------------------------------------------------------------
// FAKED rehearsal — runs the full scripted sequence deterministically in CI
// ---------------------------------------------------------------------------

describe('e2e demo rehearsal — faked infra (deterministic, runs in CI)', () => {
  it('walks deploy → scenario → autonomous pause → on-chain mirror → DAO reverse → revoke → reject', async () => {
    // ── Step 1: deploy a policy via the wizard (sign-to-deploy) ────────────
    const recordedDrafts: DraftedPolicy[] = [];
    const deployed = deployPolicyViaWizard(sampleDraft(), recordedDrafts);
    expect(recordedDrafts).toHaveLength(1);
    expect(deployed.txDigest).toMatch(/^0x/); // a deployment tx digest is produced (Req 4.10)
    expect(deployed.policyObjectId).toBe(OBJECT_ID);

    const wired = buildRehearsalComposition(deployed);
    const received = subscribeListener(wired.composition.registry, MARKET_ID);

    // ── Step 2 + 3: run the scenario → AUTONOMOUS pause_new_borrows PTB ─────
    // The "oracle staleness" climax (a reading far past freshness) escalates
    // the fail-closed Risk Engine to an emergency pause, which drives the full
    // network-gated action flow. (Req 14.3, 7.1)
    await feedStaleOracleReading(wired.composition);

    const types = received.map((m) => m.type);
    expect(types).toContain('risk_update');
    expect(types).toContain('stale_data');
    expect(types).toContain('action_executed');

    const actionMsg = received.find((m) => m.type === 'action_executed');
    expect(actionMsg).toBeDefined();
    if (actionMsg && actionMsg.type === 'action_executed') {
      expect(actionMsg.action.actionType).toBe('pause_new_borrows'); // Req 7.1
      expect(actionMsg.action.txDigest).toBe(TX_DIGEST);
      expect(actionMsg.action.walrusEvidenceBlobId).toBe(BLOB_ID);
      expect(actionMsg.action.actorType).toBe('agent');
    }

    // The PTB ran network-gated with evidence uploaded BEFORE build/simulate.
    // (Req 1.6 network gate first; Req 9.1 evidence-before-PTB)
    expect(wired.timeline[0]).toBe('network');
    expect(wired.timeline).toEqual(['network', 'upload', 'simulate', 'submit', 'link']);

    // ── Step 4: verify on-chain ActionLog + event + Blob_ID + tx digest ────
    // The indexer observes the RiskActionExecuted event, persists the action
    // row, and flips the linked evidence to linked_on_chain. (Req 9.4)
    const run = await wired.composition.indexer.runOnce();
    expect(run.actionsPersisted).toBe(1);
    expect(run.evidenceLinked).toBe(1);
    expect(wired.created).toHaveLength(1);
    expect(wired.created[0]?.tx_digest).toBe(TX_DIGEST);
    expect(wired.created[0]?.walrus_evidence_blob_id).toBe(BLOB_ID);
    expect(wired.linked).toEqual([
      { blobId: BLOB_ID, actionId: 'action-1', hash: ON_CHAIN_EVIDENCE_HASH },
    ]);

    // ── Step 5: DAO reverse (Override_Console reverse_action) ──────────────
    const override = makeOverrideHarness();
    const reverseRequest: OverrideActionRequest = {
      operation: OVERRIDE_OPERATION.REVERSE_ACTION,
      reason: 'Oracle recovered; emergency pause no longer warranted',
      policyObjectId: deployed.policyObjectId,
      overrideCapObjectId: deployed.overrideCapObjectId,
      actionLogObjectId: OBJECT_ID,
      marketStateObjectId: deployed.marketStateObjectId,
    };
    const reverseResult = await override.executor.execute(
      overrideInput(reverseRequest, deployed, 'action-1'),
    );
    expect(reverseResult.success).toBe(true);
    expect(reverseResult.operation).toBe('reverse_action');
    expect(reverseResult.overrideReason).toBe(reverseRequest.reason);
    expect(reverseResult.originalActionReversed).toBe(true);
    expect(override.reversedCalls).toEqual([
      { id: 'action-1', by: '0xdao', digest: '0xoverridedigest' },
    ]);
    expect(override.createdRecords[0]?.override_reason).toBe(reverseRequest.reason);

    // ── Step 6: revoke the guardian (Override_Console revoke_guardian) ─────
    const revokeRequest: OverrideActionRequest = {
      operation: OVERRIDE_OPERATION.REVOKE_GUARDIAN,
      reason: 'Agent key rotation; revoking guardian for the demo',
      policyObjectId: deployed.policyObjectId,
      overrideCapObjectId: deployed.overrideCapObjectId,
      guardianCapObjectId: deployed.guardianCapObjectId,
    };
    const revokeResult = await override.executor.execute(
      overrideInput(revokeRequest, deployed, undefined),
    );
    expect(revokeResult.success).toBe(true);
    expect(revokeResult.operation).toBe('revoke_guardian');
    expect(revokeResult.originalActionReversed).toBe(false);

    // The on-chain GuardianCap is now revoked → reflect that in the live market
    // state the loop evaluates.
    wired.marketConfig.guardianRevoked = true;
    const actionCountBefore = received.filter((m) => m.type === 'action_executed').length;
    const timelineLenBefore = wired.timeline.length;

    // ── Step 7: a SUBSEQUENT autonomous action is REJECTED (revoked) ───────
    await feedStaleOracleReading(wired.composition);

    // No new action executed: the executor was never invoked again.
    const actionCountAfter = received.filter((m) => m.type === 'action_executed').length;
    expect(actionCountAfter).toBe(actionCountBefore);
    expect(wired.timeline.length).toBe(timelineLenBefore);

    // The latest risk_update refused the action with a revocation reason. (Req 12.3)
    const riskUpdates = received.filter(
      (m): m is Extract<ServerMessage, { type: 'risk_update' }> => m.type === 'risk_update',
    );
    const lastRisk = riskUpdates[riskUpdates.length - 1];
    expect(lastRisk.snapshot.recommendedAction).toBeNull();
    expect(lastRisk.snapshot.refusalReason).toMatch(/revoked/i);
  });
});

// ---------------------------------------------------------------------------
// LIVE rehearsal — opt-in, requires a funded wallet + published packages
// ---------------------------------------------------------------------------

/** Opt-in flag (mirrors the oracle/Walrus integration suites). */
const RUN_INTEGRATION =
  process.env.RUN_INTEGRATION === '1' || process.env.RUN_INTEGRATION === 'true';

const DEPLOYMENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../deployments/testnet.json',
);

interface DeploymentManifest {
  status?: string;
  packageIds?: { policy?: string; demoMarket?: string; adapters?: string };
}

function readDeploymentManifest(): DeploymentManifest | null {
  try {
    return JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8')) as DeploymentManifest;
  } catch {
    return null;
  }
}

/** A real package id is a 0x-prefixed value, not blank and not the placeholder. */
function isRealPackageId(value: string | undefined): boolean {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value !== 'NOT_DEPLOYED' &&
    value.startsWith('0x')
  );
}

function deploymentReady(manifest: DeploymentManifest | null): boolean {
  if (manifest === null) {
    return false;
  }
  if (manifest.status !== undefined && manifest.status !== 'DEPLOYED') {
    return false;
  }
  const ids = manifest.packageIds ?? {};
  return isRealPackageId(ids.policy) && isRealPackageId(ids.demoMarket) && isRealPackageId(ids.adapters);
}

const deploymentManifest = readDeploymentManifest();
const LIVE_REHEARSAL_ENABLED = RUN_INTEGRATION && deploymentReady(deploymentManifest);

describe('e2e demo rehearsal — live Sui Testnet (opt-in)', () => {
  beforeAll(() => {
    if (!LIVE_REHEARSAL_ENABLED) {
      const why = !RUN_INTEGRATION
        ? 'RUN_INTEGRATION is not set'
        : 'deployments/testnet.json has no real (published) package ids';
      // eslint-disable-next-line no-console
      console.warn(
        `[e2eDemoRehearsal] Skipping the LIVE on-chain rehearsal — ${why}. ` +
          'Fund the agent wallet, run ./scripts/deploy_testnet.sh to publish the three ' +
          'Move packages, then set RUN_INTEGRATION=1 to enable it.',
      );
    }
  });

  // The live rehearsal verifies the production wiring connects to the REAL
  // deployed packages. The full on-chain sequence (deploy via wizard → scenario
  // → autonomous pause PTB → ActionLog/event/Blob_ID/digest → DAO reverse →
  // revoke → subsequent rejection) is then driven by a funded operator signer.
  // This CI-skippable check is the live-infra-dependent portion we can assert
  // automatically; it runs ONLY with RUN_INTEGRATION + a real deployment.
  it.runIf(LIVE_REHEARSAL_ENABLED)(
    'wires the production composition against the published testnet packages',
    () => {
      const manifest = deploymentManifest!;
      const ids = manifest.packageIds!;
      const liveConfig: AppConfig = {
        ...config,
        packageIds: {
          policy: ids.policy!,
          demoMarket: ids.demoMarket!,
          adapters: ids.adapters!,
        },
      };
      const secrets: AppSecrets = { agentSignerKey: '', llmApiKey: '' };

      const { composition, networkGuard } = createProductionComposition(liveConfig, secrets);

      // No live connection is opened here; we only assert the loop, indexer,
      // and action surface are wired against the real package ids. (Req 1.6)
      expect(composition.loop).toBeDefined();
      expect(composition.indexer).toBeDefined();
      expect(composition.actionServices.recommend).toBeDefined();
      expect(networkGuard).toBeDefined();
      expect(isRealPackageId(liveConfig.packageIds.policy)).toBe(true);
    },
  );

  // Always-present guard so this file is never an empty suite in default runs.
  it('is opt-in and never fails a default offline test run', () => {
    expect(typeof LIVE_REHEARSAL_ENABLED).toBe('boolean');
  });
});
