/**
 * Backend composition root (task 21.1).
 *
 * This module is the single place the full risk-control loop is assembled from
 * the services that already exist (and are tested) in isolation. It does NOT
 * rebuild or alter any service — it only *wires* them:
 *
 *   workers (oracle + liquidity)
 *        └─▶ MarketFeatureAssembler ─▶ RiskControlLoop
 *                                          ├─▶ Risk Engine (fail-closed)
 *                                          ├─▶ Action Executor (network-gated:
 *                                          │     evidence-first → simulate →
 *                                          │     submit → link)  ─▶ on-chain
 *                                          │     ActionLog / RiskActionExecuted
 *                                          └─▶ WebSocket push (risk_update /
 *                                                action_executed / stale_data)
 *   on-chain events
 *        └─▶ ProtocolStateIndexer ─▶ actions row + linked_on_chain evidence
 *                                  └─▶ WebSocket push (guardian_revoked)
 *   REST  ─▶ ActionRouteServices (recommend / execute / override / evidence /
 *                                  simulator / policy-simulate)
 *
 * The shared {@link SubscriptionRegistry} is the one WebSocket push surface for
 * BOTH the loop (risk_update / action_executed / stale_data / override_applied /
 * env_check_failed) and the indexer (guardian_revoked), so subscribed
 * dashboards receive every live update from a single socket. (Req 3.7, 12.2)
 *
 * Everything is injected through {@link CompositionDeps}, so the wiring test
 * drives the whole loop with in-memory fakes (no live RPC / DB / Walrus / Redis)
 * and the production factory ({@link createProductionComposition}) constructs
 * the real adapters lazily, gated behind config/env. Importing this module
 * never opens a connection. (Req 15.2, 16.3)
 */

import type { Server as HttpServer } from 'node:http';

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

import type {
  ActionResult,
  ExecuteRequest,
  NetworkVerifier,
  TransactionSimulator,
  TransactionSubmitter,
} from './action/actionExecutor.js';
import {
  ActionExecutor,
  createSuiClientSimulator,
  createSuiClientSubmitter,
} from './action/actionExecutor.js';
import { OverrideExecutor } from './action/overrideExecutor.js';
import type {
  ActionRouteServices,
  EvidenceUploaderPort,
  OverrideExecutorPort,
  PolicyDeploymentSimulatorPort,
  RiskRecommenderPort,
  SimulatorPort,
} from './api/actionRoutes.js';
import type { AppConfig, AppSecrets } from './config/env.js';
import { SnapshotCache, getRedis } from './cache/redis.js';
import { createRepositories, type Repositories } from './db/repositories/index.js';
import { EvidenceService } from './evidence/evidenceService.js';
import type { OnChainHashRecorder } from './evidence/uploadManager.js';
import { HttpWalrusClient } from './evidence/walrusClient.js';
import {
  InMemoryCheckpointStore,
  ProtocolStateIndexer,
  SuiClientEventSource,
  type CheckpointStore,
  type IndexerOptions,
  type SuiEventSource,
} from './indexer/index.js';
import {
  LiquidityWorker,
  type LiquidityReadingSink,
  type SnapshotWriter as LiquiditySnapshotWriter,
  type TimerLike as LiquidityTimerLike,
} from './liquidity/liquidityWorker.js';
import {
  createLiquiditySource,
  type LiquiditySource,
  type OrderBookSnapshot,
} from './liquidity/liquiditySource.js';
import {
  OracleIngestionWorker,
  type OracleFeedMapping,
  type OracleReadingSink,
  type SnapshotWriter as OracleSnapshotWriter,
  type TimerLike as OracleTimerLike,
} from './oracle/oracleIngestionWorker.js';
import { createOracleAdapter, type OracleAdapter } from './oracle/oracleAdapter.js';
import { NetworkGuard } from './network/networkGuard.js';
import {
  DeterministicRiskEngine,
  FailClosedRiskEngine,
  createAiExplanationService,
  createLlmClient,
  type AiExplanationService,
  type FailClosedGuardContext,
} from './risk/index.js';
import type { FeatureVector } from './risk/types.js';
import {
  attachWebSocketServer,
  SubscriptionRegistry,
  type MessagePublisher,
  type WebSocketHandle,
} from './ws/index.js';

import {
  RiskControlLoop,
  type ActionRequestPlanner,
  type LoopLogger,
  type LoopRiskEnginePort,
  type RiskSnapshotRecorder,
} from './loop/riskControlLoop.js';
import {
  MarketFeatureAssembler,
  type MarketAssemblerConfig,
} from './loop/marketFeatureAssembler.js';
import { createRepositorySnapshotRecorder } from './loop/snapshotRecorder.js';
import { SimulationService } from './simulation/simulationService.js';
import { createIncidentSummarizer, type IncidentSummarizer } from './incident/incidentSummary.js';
import {
  createDefiLlamaReserveReader,
  type ProtocolReserveReader,
} from './protocol/protocolReserve.js';
import { readOnChainMarket } from './demo/onChainMarket.js';
import {
  DEEPBOOK_INDEXER_URL,
  DEMO_DEEPBOOK_POOL,
  DEMO_FRESHNESS_THRESHOLD_MS,
  DEMO_MARKET_BASELINE,
  DEMO_MARKET_ID,
  DEMO_ORACLE_FEED_ID,
  DEMO_OWNER_ADDRESS,
  DEMO_POLICY_ID,
} from './demo/demoMarket.js';
import { EXTRA_MARKETS_LIVE } from './demo/extraMarkets.js';

// ---------------------------------------------------------------------------
// Injected service ports for the loop's action execution.
// ---------------------------------------------------------------------------

/** Port over {@link ActionExecutor.execute} used by both the loop and the API. */
export interface CompositionActionExecutor {
  execute(input: ExecuteRequest): Promise<ActionResult>;
}

/** Worker-construction inputs (adapter + cache + feeds), gated behind config. */
export interface OracleWorkerInputs {
  adapter: OracleAdapter;
  cache: OracleSnapshotWriter;
  feeds: OracleFeedMapping[];
  pollIntervalMs: number;
  timer?: OracleTimerLike;
}

/** Worker-construction inputs for the liquidity worker. */
export interface LiquidityWorkerInputs {
  source: LiquiditySource;
  cache: LiquiditySnapshotWriter;
  markets: string[];
  pollIntervalMs: number;
  timer?: LiquidityTimerLike;
}

/** Everything the composition root needs, all injectable for tests. */
export interface CompositionDeps {
  config: AppConfig;
  repositories: Repositories;

  /** Shared WebSocket push surface; created when omitted. */
  registry?: SubscriptionRegistry;

  /** The fail-closed Risk Engine (loop, simulator, and `/recommend` all use it). */
  riskEngine: LoopRiskEnginePort;

  /**
   * Optional AI Explanation Service. When present, the loop and `/recommend`
   * fill each evaluation's `explanation` with a ≤1000-char narrative. It has no
   * authority over the gating decision. (Req 6.5, 6.13)
   */
  explainer?: AiExplanationService;

  /** Action Executor port; when omitted the loop never acts and `/execute` is 503. */
  actionExecutor?: CompositionActionExecutor;
  /** Plans the on-chain action for a threshold crossing; omit to disable execution. */
  planner?: ActionRequestPlanner;

  /** DAO Override_Console executor port (for `/api/actions/override`). */
  overrideExecutor?: OverrideExecutorPort;
  /** Evidence upload port (for `/api/evidence/upload`). */
  evidenceUploader?: EvidenceUploaderPort;
  /** Simulation_Lab port (for `/api/simulator/*`). */
  simulator?: SimulatorPort;
  /** Policy-deployment dry-run port (for `/api/policies/simulate`). */
  simulatePolicyDeployment?: PolicyDeploymentSimulatorPort;

  /** Per-market feature-assembler configs wiring workers → loop. */
  assemblerMarkets?: MarketAssemblerConfig[];
  /** Optional durable risk-snapshot recorder used by the loop. */
  snapshots?: RiskSnapshotRecorder;

  /** Indexer event source (production: {@link SuiClientEventSource}; tests: a fake). */
  indexerSource: SuiEventSource;
  /** Durable checkpoint store; defaults to {@link InMemoryCheckpointStore}. */
  checkpointStore?: CheckpointStore;
  indexerOptions?: IndexerOptions;

  /** Oracle worker construction inputs; omit to run without the oracle worker. */
  oracle?: OracleWorkerInputs;
  /** Liquidity worker construction inputs; omit to run without the liquidity worker. */
  liquidity?: LiquidityWorkerInputs;

  now?: () => number;
  logger?: LoopLogger;
}

/** The fully-wired backend, returned by {@link buildComposition}. */
export interface Composition {
  /** The shared WebSocket subscription core / push surface. */
  registry: SubscriptionRegistry;
  /** Convenience alias: the registry as a {@link MessagePublisher}. */
  publisher: MessagePublisher;
  /** The live risk-control loop (workers → risk → action → WS). */
  loop: RiskControlLoop;
  /** Bridges worker readings to the loop. The workers' sinks point here. */
  assembler: MarketFeatureAssembler;
  /** Protocol State Indexer (persists actions, links evidence, pushes guardian_revoked). */
  indexer: ProtocolStateIndexer;
  /** Service ports injected into the REST action router. */
  actionServices: ActionRouteServices;
  /** Repository bundle the REST read routes use. */
  repositories: Repositories;
  /** AI incident summarizer for the incident read endpoint (governance report). */
  incidentSummarizer?: IncidentSummarizer;
  /** Reader for a real Sui lending protocol's live reserves (impact anchoring). */
  protocolReserve?: ProtocolReserveReader;
  /** Oracle ingestion worker, when configured (sink → assembler). */
  oracleWorker?: OracleIngestionWorker;
  /** Liquidity worker, when configured (sink → assembler). */
  liquidityWorker?: LiquidityWorker;

  /** Start the background workers (oracle + liquidity), if configured. */
  startWorkers(): void;
  /** Stop the background workers, if configured. */
  stopWorkers(): void;
  /**
   * Attach the WebSocket server to a running HTTP server, binding sockets to
   * the shared registry so the loop's and indexer's pushes reach dashboards.
   */
  attachWebSocket(server: HttpServer): WebSocketHandle;
  /**
   * Start periodic sync of REAL on-chain demo-market state (utilization +
   * exposure) into the live loop. No-op when the on-chain market is not
   * provisioned. Returns a stop handle.
   */
  startMarketStateSync?(): { stop(): void };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Assemble the full composition from already-constructed services. Pure wiring:
 * no infra is opened here. Used directly by the wiring test (with fakes) and by
 * {@link createProductionComposition} (with real adapters).
 */
export function buildComposition(deps: CompositionDeps): Composition {
  const registry = deps.registry ?? new SubscriptionRegistry();
  const publisher: MessagePublisher = registry;

  // --- Risk-control loop: risk → action → WS push ---------------------------
  const loop = new RiskControlLoop({
    riskEngine: deps.riskEngine,
    actionExecutor: deps.actionExecutor ?? disabledActionExecutor(),
    publisher,
    planner: deps.actionExecutor ? deps.planner : undefined,
    snapshots: deps.snapshots,
    explainer: deps.explainer,
    now: deps.now,
    logger: deps.logger,
  });

  // --- Workers → assembler → loop ------------------------------------------
  const assembler = new MarketFeatureAssembler({
    loop,
    markets: deps.assemblerMarkets ?? [],
    now: deps.now,
  });

  let oracleWorker: OracleIngestionWorker | undefined;
  if (deps.oracle) {
    const sink: OracleReadingSink = assembler.oracleSink;
    oracleWorker = new OracleIngestionWorker({
      adapter: deps.oracle.adapter,
      cache: deps.oracle.cache,
      sink,
      feeds: deps.oracle.feeds,
      pollIntervalMs: deps.oracle.pollIntervalMs,
      timer: deps.oracle.timer,
      now: deps.now,
    });
  }

  let liquidityWorker: LiquidityWorker | undefined;
  if (deps.liquidity) {
    const sink: LiquidityReadingSink = assembler.liquiditySink;
    liquidityWorker = new LiquidityWorker({
      source: deps.liquidity.source,
      cache: deps.liquidity.cache,
      sink,
      markets: deps.liquidity.markets,
      pollIntervalMs: deps.liquidity.pollIntervalMs,
      timer: deps.liquidity.timer,
      now: deps.now,
    });
  }

  // --- Indexer: on-chain events → persistence + guardian_revoked push -------
  const indexer = new ProtocolStateIndexer(
    {
      source: deps.indexerSource,
      checkpoints: deps.checkpointStore ?? new InMemoryCheckpointStore(),
      actions: deps.repositories.actions,
      walrus: deps.repositories.walrusBlobs,
      markets: deps.repositories.markets,
      policies: deps.repositories.policies,
      publisher,
    },
    deps.indexerOptions,
  );

  // --- REST action services -------------------------------------------------
  const recommend: RiskRecommenderPort = {
    recommend: async (input) => {
      const evaluation = await deps.riskEngine.evaluate(
        input.marketId,
        input.features,
        input.guard ?? defaultGuardContext(input.features),
      );
      // Attach a plain-language explanation (no authority over the decision).
      if (deps.explainer) {
        try {
          const explanation = await deps.explainer.explain({
            score: evaluation.riskScore,
            band: evaluation.band,
            classes: evaluation.classes,
            ruleOutputs: evaluation.ruleOutputs,
          });
          return { ...evaluation, explanation };
        } catch {
          // Fall back to the evaluation without an LLM explanation.
        }
      }
      return evaluation;
    },
  };

  const actionServices: ActionRouteServices = {
    recommend,
    execute: deps.actionExecutor,
    overrideExecute: deps.overrideExecutor,
    uploadEvidence: deps.evidenceUploader,
    simulator: deps.simulator,
    simulatePolicyDeployment: deps.simulatePolicyDeployment,
    // Persist a deployed policy record after the wizard signs. (Req 4.10)
    persistPolicy: {
      persist: async (input) => {
        const daoAddress = input.daoAddress ?? '';
        const row = await deps.repositories.policies.create({
          market_id: input.marketId,
          on_chain_policy_id: `policy::${input.txDigest}`,
          owner_address: daoAddress,
          dao_address: daoAddress,
          allowed_actions: input.allowedActions,
          max_ltv_delta_bps: input.maxLtvDeltaBps,
          max_margin_delta_bps: input.maxMarginDeltaBps,
          pause_duration_limit_ms: input.pauseDurationLimitMs,
          cooldown_ms: input.cooldownMs,
          risk_thresholds: (input.riskThresholds ?? {
            warning: 40,
            guarded: 60,
            paramAdjust: 75,
            emergency: 90,
          }) as never,
        });
        return { id: row.id };
      },
    },
  };

  return {
    registry,
    publisher,
    loop,
    assembler,
    indexer,
    actionServices,
    repositories: deps.repositories,
    oracleWorker,
    liquidityWorker,
    startWorkers(): void {
      oracleWorker?.start();
      liquidityWorker?.start();
    },
    stopWorkers(): void {
      oracleWorker?.stop();
      liquidityWorker?.stop();
    },
    attachWebSocket(server: HttpServer): WebSocketHandle {
      return attachWebSocketServer({ server, registry });
    },
  };
}

/**
 * A permissive fail-closed guard context for `/api/actions/recommend` when the
 * caller does not supply one: the evaluation is treated as complete with
 * present oracle data on Sui Testnet and a non-revoked guardian, deriving the
 * staleness age from the feature vector. The deterministic score, band, and
 * classes are unaffected — only the fail-closed post-processing reads this.
 */
export function defaultGuardContext(features: FeatureVector): FailClosedGuardContext {
  const oracleAgeMs = Math.max(0, features.nowMs - features.oracleTimestampMs);
  return {
    evaluationComplete: true,
    oracle: { present: true },
    isSuiTestnet: true,
    guardianRevoked: features.guardianRevoked,
    policy: {
      allowedActions: [
        'pause_new_borrows',
        'reduce_max_ltv',
        'enter_guarded_mode',
        'increase_maintenance_margin',
      ],
    },
    proposedMagnitude: {},
    oracleAgeMs,
    freshnessThresholdMs: features.freshnessThresholdMs,
    policyPermitsStalePause: true,
  };
}

/** A stand-in executor used when none is configured; it is never invoked because
 * the loop's planner is also left undefined, but it satisfies the loop's port. */
function disabledActionExecutor(): CompositionActionExecutor {
  return {
    execute: async () => ({
      success: false,
      stage: 'network_verification',
      failureReason: 'action execution is not configured in this deployment',
    }),
  };
}

/**
 * Build a {@link LiquiditySource} backed by the REAL DeepBook v3 SUI/USDC pool
 * on Sui Testnet, read through the public DeepBook indexer's level-2 order-book
 * endpoint. Depth / spread / imbalance are derived from the live book; a thin
 * or unreachable book transparently falls back to the deterministic simulated
 * source so the loop always produces a snapshot. (Req 6.1)
 */
function createDeepBookLiquiditySource(): LiquiditySource {
  const reader = async (poolName: string): Promise<OrderBookSnapshot | null> => {
    try {
      const res = await fetch(
        `${DEEPBOOK_INDEXER_URL}/orderbook/${encodeURIComponent(poolName)}?level=2&depth=50`,
      );
      if (!res.ok) {
        return null;
      }
      const body = (await res.json()) as {
        bids?: [string, string][];
        asks?: [string, string][];
      };
      const toLevels = (rows?: [string, string][]) =>
        (rows ?? [])
          .map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) }))
          .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.quantity));
      return { bids: toLevels(body.bids), asks: toLevels(body.asks) };
    } catch {
      return null;
    }
  };
  // Map every live market that trades against a real DeepBook pool to it; the
  // primary demo market and the SUI Perps market both use the SUI/USDC book.
  // Markets without a pool (e.g. the USDC Vault) transparently fall back to a
  // deterministic stable baseline inside the source.
  const pools: Record<string, string> = { [DEMO_MARKET_ID]: DEMO_DEEPBOOK_POOL };
  for (const m of EXTRA_MARKETS_LIVE) {
    if (m.deepBookPool) {
      pools[m.marketId] = m.deepBookPool;
    }
  }
  return createLiquiditySource({ kind: 'deepbook', pools, reader });
}

// ---------------------------------------------------------------------------
// Production factory (real adapters, gated behind config/env).
// ---------------------------------------------------------------------------

/** The production composition plus the {@link NetworkGuard} used at startup. */
export interface ProductionComposition {
  composition: Composition;
  networkGuard: NetworkGuard;
}

/**
 * Construct the production composition with real adapters. Real RPC/DB/Walrus/
 * Redis clients are created here (lazily — none opens a connection until first
 * use), gated behind config:
 *  - the oracle/liquidity workers run only when at least one feed/market is
 *    configured,
 *  - the live action-execution path (Action Executor + planner) is wired only
 *    when the policy package id is configured; the per-deployment signer +
 *    Walrus on-chain recorder are injected via {@link CompositionOverrides} so
 *    the live testnet submission wiring (task 21.2) can supply them without
 *    changing this factory.
 *
 * Importing this module never opens a connection; only calling this function
 * constructs clients.
 */
export function createProductionComposition(
  config: AppConfig,
  secrets: AppSecrets,
  overrides: CompositionOverrides = {},
): ProductionComposition {
  const repositories = overrides.repositories ?? createRepositories();
  const suiClient = overrides.suiClient ?? new SuiClient({ url: config.suiRpcUrl });

  const networkGuard =
    overrides.networkGuard ??
    new NetworkGuard(suiClient, repositories.environmentChecks, {
      suiTestnetChainId: config.suiTestnetChainId,
      packageIds: config.packageIds,
    });

  // Default-config engine (1M liquidity baseline) — used by the Simulation_Lab,
  // whose scenarios carry large synthetic depths. The LIVE loop uses an engine
  // tuned to real Sui-Testnet DeepBook reality, where the SUI/USDC book is thin
  // (tens–hundreds of quote units) and spreads are wide (~100+ bps); without
  // tuning, a healthy-but-thin testnet book would peg liquidity risk. (Req 6.1)
  const defaultRiskEngine =
    overrides.riskEngine ?? new FailClosedRiskEngine(new DeterministicRiskEngine());
  const riskEngine =
    overrides.riskEngine ??
    new FailClosedRiskEngine(
      new DeterministicRiskEngine({
        liquidityBaselineDepth: 120,
        spreadFullRiskBps: 400,
        liquidityCollapseDepthFraction: 0.15,
        liquidityCollapseSpreadBps: 600,
      }),
    );

  // AI Explanation Service. Builds an OpenAI-compatible (DeepSeek) LLM client
  // from config + the LLM_API_KEY secret when present; otherwise the factory
  // returns the deterministic template service. Explanation text only — never
  // any authority over the gating decision. (Req 6.5, 6.13)
  const explainerLlm = createLlmClient({
    apiKey: secrets.llmApiKey,
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
  });
  const explainer = overrides.explainer ?? createAiExplanationService({ llm: explainerLlm });

  // Evidence service (Walrus upload + repository-backed status store). The
  // on-chain hash recorder used by `link` is supplied via overrides for the
  // live path; without it the executor's link step is unavailable, so the
  // full execute flow is wired only when an executor is provided/derivable.
  const evidenceService =
    overrides.evidenceService ??
    new EvidenceService({
      walrus: new HttpWalrusClient({ publisherUrl: config.walrusPublisherUrl }),
      store: repositories.walrusBlobs,
      // The evidence hash + blob id are already recorded on-chain inside
      // `execute_guardian_action`'s ActionLog, so the separate link-time
      // recorder is a no-op (it only flips the off-chain status to
      // `linked_on_chain`). A real secondary recorder can be injected. (Req 10.4)
      recordOnChain: overrides.recordEvidenceOnChain ?? (async () => {}),
    });

  // Resolve a transaction submitter + simulator. When none is injected, build a
  // signer-backed pair from the AGENT_SIGNER_KEY secret (bech32 `suiprivkey…`)
  // so the agent can submit real Testnet actions. A malformed key is logged and
  // leaves submission disabled (no partial/broken startup). (Req 16.1, 16.2)
  let submitter: TransactionSubmitter | undefined = overrides.submitter;
  let executorSimulator: TransactionSimulator | undefined = overrides.executorSimulator;
  if (submitter === undefined && secrets.agentSignerKey.trim() !== '') {
    try {
      const { secretKey } = decodeSuiPrivateKey(secrets.agentSignerKey);
      const keypair = Ed25519Keypair.fromSecretKey(secretKey);
      submitter = createSuiClientSubmitter(suiClient, keypair);
      executorSimulator =
        executorSimulator ??
        createSuiClientSimulator(suiClient, { sender: keypair.toSuiAddress() });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        'AGENT_SIGNER_KEY is set but could not be decoded; on-chain submission disabled:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // The live action executor is wired only when the policy package is
  // configured AND a transaction submitter is available. Otherwise execution is
  // disabled and `/execute` responds 503 — the rest of the loop (workers → risk
  // → WS, indexer) is still fully wired.
  let actionExecutor: CompositionActionExecutor | undefined = overrides.actionExecutor;
  if (actionExecutor === undefined && config.packageIds.policy.trim() !== '' && submitter) {
    const networkVerifier: NetworkVerifier = networkGuard;
    actionExecutor = new ActionExecutor(
      { policyPackageId: config.packageIds.policy },
      executorSimulator,
      {
        network: networkVerifier,
        evidence: evidenceService,
        submitter,
      },
    );
  }

  // The DAO Override_Console executor: same fail-closed flow as the agent
  // executor, signed by the agent key (which holds the OverrideCap on the demo
  // policy). Wired only when the policy package is configured AND a submitter
  // is available; otherwise `/api/actions/override` responds 503.
  let overrideExecutor = overrides.overrideExecutor;
  if (overrideExecutor === undefined && config.packageIds.policy.trim() !== '' && submitter) {
    const networkVerifier: NetworkVerifier = networkGuard;
    overrideExecutor = new OverrideExecutor(
      { policyPackageId: config.packageIds.policy },
      executorSimulator,
      {
        network: networkVerifier,
        evidence: evidenceService,
        submitter,
        recorder: repositories.actions,
      },
    );
  }

  const snapshotCache = overrides.snapshotCache ?? new SnapshotCache(getRedis());

  // The oracle worker runs only when feed mappings are configured; the
  // liquidity worker only when markets are configured. Otherwise they are
  // omitted entirely (no orphaned, idle worker). (gated behind config)
  const oracle: OracleWorkerInputs | undefined =
    overrides.oracle ??
    (overrides.oracleFeeds && overrides.oracleFeeds.length > 0
      ? {
          adapter: createOracleAdapter({ kind: 'pyth' }),
          cache: snapshotCache,
          feeds: overrides.oracleFeeds,
          pollIntervalMs: overrides.pollIntervalMs ?? 15_000,
        }
      : undefined);

  const liquidity: LiquidityWorkerInputs | undefined =
    overrides.liquidity ??
    (overrides.liquidityMarkets && overrides.liquidityMarkets.length > 0
      ? {
          source: createLiquiditySource({ kind: 'simulated' }),
          cache: snapshotCache,
          markets: overrides.liquidityMarkets,
          pollIntervalMs: overrides.pollIntervalMs ?? 15_000,
        }
      : undefined);

  const indexerSource: SuiEventSource =
    overrides.indexerSource ??
    new SuiClientEventSource(suiClient, {
      modules: indexerModules(config),
    });

  // ----- Demo live wiring -------------------------------------------------
  // Unless explicitly disabled (DEMO_MARKET_LIVE=0), wire the seeded Demo_Market
  // into the live loop so the dashboard shows REAL, moving data: a Pyth SUI/USD
  // oracle feed + simulated demo liquidity drive the Risk Engine each tick, the
  // evaluation is persisted as a risk_snapshot AND pushed over the WebSocket.
  // No planner is wired, so the loop never auto-submits on-chain (the demo has
  // no provisioned policy/guardian objects) — it evaluates, persists, pushes.
  // The Simulation_Lab port is wired so `/api/simulator/*` works. (Req 3.7, 14)
  const demoLive = (process.env.DEMO_MARKET_LIVE ?? '1') !== '0';

  // Real on-chain object ids from provisioning (npm run provision).
  const demoMarketStateId = process.env.DEMO_MARKET_STATE_ID ?? '';
  const demoPolicyObjectId = process.env.DEMO_POLICY_OBJECT_ID ?? '';
  const demoGuardianCapId = process.env.DEMO_GUARDIAN_CAP_ID ?? '';

  const demoAssembler: MarketAssemblerConfig = {
    marketId: DEMO_MARKET_ID,
    freshnessThresholdMs: DEMO_FRESHNESS_THRESHOLD_MS,
    utilization: DEMO_MARKET_BASELINE.utilization,
    exposure: DEMO_MARKET_BASELINE.exposure,
    currentMaxLtvBps: DEMO_MARKET_BASELINE.currentMaxLtvBps,
    realizedVolatilityPct: DEMO_MARKET_BASELINE.realizedVolatilityPct,
    // Pyth returns SUI/USD in 1e-8 fixed point (~71_500_000 ≈ $0.715). The
    // reference is in the SAME fixed-point scale so the divergence check (a
    // unit-invariant ratio) stays correct and does not false-fire. (Req 6.1)
    referencePrice: 72_000_000,
    liquidityDepth: DEMO_MARKET_BASELINE.liquidityDepth,
    spreadBps: DEMO_MARKET_BASELINE.spreadBps,
    policy: {
      allowedActions: [
        'pause_new_borrows',
        'reduce_max_ltv',
        'enter_guarded_mode',
        'increase_maintenance_margin',
      ],
    },
    policyPermitsStalePause: true,
  };

  // The two ADDITIONAL monitored markets (SUI Perps, USDC Vault), wired into
  // the SAME live loop so their dashboard data is real and fresh (real Pyth
  // oracle each tick) instead of a one-shot seed that goes stale. Monitor-only:
  // no planner is wired for them, so the loop evaluates + persists + pushes but
  // never auto-submits an on-chain action.
  const extraAssemblerConfigs: MarketAssemblerConfig[] = EXTRA_MARKETS_LIVE.map((m) => ({
    marketId: m.marketId,
    freshnessThresholdMs: m.freshnessThresholdMs,
    utilization: m.utilization,
    exposure: m.exposure,
    currentMaxLtvBps: m.currentMaxLtvBps,
    realizedVolatilityPct: m.realizedVolatilityPct,
    referencePrice: m.referencePrice,
    expectedPegPrice: m.expectedPegPrice,
    liquidityDepth: m.liquidityDepth,
    spreadBps: m.spreadBps,
    policy: {
      allowedActions: [
        'pause_new_borrows',
        'reduce_max_ltv',
        'enter_guarded_mode',
        'increase_maintenance_margin',
      ],
    },
    policyPermitsStalePause: true,
  }));

  const assemblerMarkets =
    overrides.assemblerMarkets ??
    (demoLive ? [demoAssembler, ...extraAssemblerConfigs] : undefined);

  const snapshots =
    overrides.snapshots ??
    (demoLive ? createRepositorySnapshotRecorder(repositories.riskSnapshots) : undefined);

  const oracleResolved: OracleWorkerInputs | undefined =
    oracle ??
    (demoLive
      ? {
          adapter: createOracleAdapter({ kind: 'pyth' }),
          cache: snapshotCache,
          feeds: [
            { marketId: DEMO_MARKET_ID, feedId: DEMO_ORACLE_FEED_ID },
            ...EXTRA_MARKETS_LIVE.map((m) => ({ marketId: m.marketId, feedId: m.oracleFeedId })),
          ],
          pollIntervalMs: 8_000,
        }
      : undefined);

  const liquidityResolved: LiquidityWorkerInputs | undefined =
    liquidity ??
    (demoLive
      ? {
          source: createDeepBookLiquiditySource(),
          cache: snapshotCache,
          markets: [DEMO_MARKET_ID, ...EXTRA_MARKETS_LIVE.map((m) => m.marketId)],
          pollIntervalMs: 8_000,
        }
      : undefined);

  const simulatorPort =
    overrides.simulatorPort ??
    (demoLive
      ? new SimulationService({
          riskEngine: defaultRiskEngine,
          actionExecutor: actionExecutor ?? disabledActionExecutor(),
          demoMarket: {
            marketId: DEMO_MARKET_ID,
            policyId: DEMO_POLICY_ID,
            policyObjectId: demoPolicyObjectId || config.packageIds.policy || '0x0',
            guardianCapObjectId: demoGuardianCapId || '0x0',
            marketStateObjectId: demoMarketStateId || '0x0',
            agentSigner: DEMO_OWNER_ADDRESS,
          },
          // Persist the off-chain action mirror so evidence links to a real
          // action UUID and the executed action surfaces in the dashboard.
          actionRecorder: {
            createPending: async (input) => {
              const row = await repositories.actions.create({
                policy_id: input.policyId,
                market_id: input.marketId,
                actor: input.actor,
                actor_type: 'agent',
                risk_score: input.riskScore,
                action_type: input.actionType,
                old_value: input.oldValue,
                new_value: input.newValue,
                timestamp_ms: input.timestampMs,
              });
              return row.id;
            },
            finalize: async (id, result) => {
              await repositories.actions.attachExecutionResult(id, {
                txDigest: result.txDigest ?? null,
                walrusEvidenceBlobId: result.blobId ?? null,
                evidenceHash: result.evidenceHash ?? null,
              });
            },
          },
        })
      : undefined);

  const composition = buildComposition({
    config,
    repositories,
    registry: overrides.registry,
    riskEngine,
    explainer,
    actionExecutor,
    planner: overrides.planner,
    overrideExecutor,
    evidenceUploader: overrides.evidenceUploader ?? evidenceService,
    simulator: simulatorPort,
    simulatePolicyDeployment: overrides.simulatePolicyDeployment,
    assemblerMarkets,
    snapshots,
    indexerSource,
    checkpointStore: overrides.checkpointStore,
    indexerOptions: overrides.indexerOptions,
    oracle: oracleResolved,
    liquidity: liquidityResolved,
    now: overrides.now,
    logger: overrides.logger,
  });

  // Wire periodic sync of REAL on-chain demo-market state (utilization +
  // exposure) into the assembler config the live loop reads. Read-only
  // devInspect (no gas). No-op when the market is not provisioned. (Req 5.2)
  if (demoLive && demoMarketStateId.trim() !== '' && config.packageIds.policy.trim() !== '') {
    composition.startMarketStateSync = (): { stop(): void } => {
      let stopped = false;
      const tick = async (): Promise<void> => {
        const reading = await readOnChainMarket(
          suiClient,
          config.packageIds.policy,
          demoMarketStateId,
          DEMO_OWNER_ADDRESS,
        );
        if (reading) {
          demoAssembler.utilization = reading.utilizationBps / 10_000;
          demoAssembler.exposure = reading.exposure;
        }
      };
      void tick();
      const handle = setInterval(() => {
        if (!stopped) void tick();
      }, 15_000);
      return {
        stop: () => {
          stopped = true;
          clearInterval(handle);
        },
      };
    };
  }

  // AI incident summarizer (governance report) backed by the same LLM client
  // as the explainer (DeepSeek when configured, template fallback otherwise).
  composition.incidentSummarizer = createIncidentSummarizer(explainerLlm);

  // Real Sui lending protocol whose live reserves anchor the dashboard impact
  // figures to genuine on-chain capital (read-only; actions stay on testnet).
  composition.protocolReserve = createDefiLlamaReserveReader({
    slug: process.env.SENTINEL_PROTOCOL_SLUG ?? 'suilend',
    displayName: process.env.SENTINEL_PROTOCOL_NAME ?? 'Suilend',
  });

  return { composition, networkGuard };
}

/**
 * Optional overrides for {@link createProductionComposition}. Every field is
 * optional; supplying one replaces the default construction for that piece.
 * This is the seam the live testnet rehearsal (task 21.2) uses to inject a real
 * signer-backed submitter and on-chain evidence recorder.
 */
export interface CompositionOverrides {
  repositories?: Repositories;
  suiClient?: SuiClient;
  networkGuard?: NetworkGuard;
  riskEngine?: LoopRiskEnginePort;
  evidenceService?: EvidenceService;
  /** AI Explanation Service override (e.g. a stub in tests). */
  explainer?: AiExplanationService;
  /** A real signer-backed transaction submitter for live submission (task 21.2). */
  submitter?: TransactionSubmitter;
  /** A dry-run simulator for the executor (production: a SuiClient-backed adapter). */
  executorSimulator?: TransactionSimulator;
  /** Records the evidence hash on-chain during `link` (task 21.2). */
  recordEvidenceOnChain?: OnChainHashRecorder;
  actionExecutor?: CompositionActionExecutor;
  planner?: ActionRequestPlanner;
  overrideExecutor?: OverrideExecutorPort;
  evidenceUploader?: EvidenceUploaderPort;
  /** The Simulation_Lab port for `/api/simulator/*`. */
  simulatorPort?: SimulatorPort;
  simulatePolicyDeployment?: PolicyDeploymentSimulatorPort;
  registry?: SubscriptionRegistry;
  assemblerMarkets?: MarketAssemblerConfig[];
  snapshots?: RiskSnapshotRecorder;
  snapshotCache?: SnapshotCache;
  indexerSource?: SuiEventSource;
  checkpointStore?: CheckpointStore;
  indexerOptions?: IndexerOptions;
  oracle?: OracleWorkerInputs;
  liquidity?: LiquidityWorkerInputs;
  oracleFeeds?: OracleFeedMapping[];
  liquidityMarkets?: string[];
  pollIntervalMs?: number;
  now?: () => number;
  logger?: LoopLogger;
}

/**
 * The Move module the indexer subscribes to, derived from configured packages.
 *
 * Every event the {@link ProtocolStateIndexer} acts on — `RiskActionExecuted`,
 * `RiskActionOverridden`, `GuardianRevoked`, `PolicyUpdated` — is emitted by the
 * `policy` module, so a SINGLE `MoveModule` filter is both complete and the only
 * shape the Sui fullnode's `queryEvents` accepts: combination filters (`Any`)
 * are rejected ("'Any' queries are not supported by the fullnode"). The
 * `demo_market` module emits no events the indexer processes, so it is not
 * subscribed. Falls back to the `0x0` placeholder so construction never throws
 * before the package id is configured (the indexer simply observes no events).
 */
function indexerModules(config: AppConfig): { package: string; module: string }[] {
  const policyPackage = config.packageIds.policy.trim() !== '' ? config.packageIds.policy : '0x0';
  return [{ package: policyPackage, module: 'policy' }];
}
