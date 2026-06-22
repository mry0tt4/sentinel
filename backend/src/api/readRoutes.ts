/**
 * REST read endpoints (Req 15.1).
 *
 * This module is intentionally self-contained: it exports an Express `Router`
 * carrying ONLY the read-side routes plus the small types/helpers they need.
 * `createApp` mounts the router under `/api`. Keeping the read routes in their
 * own router means the action endpoints (task 13.2) can be added as a *second*
 * router mounted on the same app without colliding with or editing this file.
 *
 * Endpoints:
 *   GET /api/markets            — list monitored markets with status (Req 3.2)
 *   GET /api/markets/:id        — market detail: params, last action, last tx
 *                                 digest, last blob id, DAO override status
 *                                 (Req 3.6)
 *   GET /api/markets/:id/risk   — current risk score/band/indicators/freshness
 *                                 (Req 3.3, 3.5)
 *   GET /api/incidents/:id      — incident timeline assembled from repos (Req 13)
 *   GET /api/actions/:id        — single action record
 *
 * Every response carries the resolved caller {@link Role}. Repositories and the
 * role resolver are injected so HTTP tests can drive the router with in-memory
 * fakes (no database). (Req 15.1)
 */

import { Router, type Request, type Response } from 'express';

import type { ActionsRepository } from '../db/repositories/actions.js';
import type { IncidentsRepository } from '../db/repositories/incidents.js';
import type { MarketsRepository } from '../db/repositories/markets.js';
import type { PoliciesRepository } from '../db/repositories/policies.js';
import type { RiskSnapshotsRepository } from '../db/repositories/riskSnapshots.js';
import type { ActionRow, IncidentRow, MarketRow, PolicyRow, RiskSnapshotRow } from '../db/types.js';
import { computeImpact, type ImpactInputs } from '../impact/impactMetrics.js';
import type { IncidentSummarizer } from '../incident/incidentSummary.js';
import type { ProtocolReserveReader } from '../protocol/protocolReserve.js';
import {
  getHistoricalEvent,
  runHistoricalReplay,
  HISTORICAL_EVENTS,
} from '../replay/historicalReplay.js';
import { resolveMarketSources } from '../demo/marketSources.js';

// ---------------------------------------------------------------------------
// Role resolution (Req 15.1 — "Resolves wallet role").
// ---------------------------------------------------------------------------

/**
 * Caller roles recognised by the API gateway:
 *  - `DeFi User`      — default for any (or no) wallet.
 *  - `Protocol_Admin` — wallet that owns at least one policy.
 *  - `DAO_Governor`   — wallet that holds an OverrideCap (i.e. is the DAO
 *                       override address of at least one policy).
 */
export type Role = 'DeFi User' | 'Protocol_Admin' | 'DAO_Governor';

/** Header used as a session stub to identify the calling wallet. */
export const WALLET_ADDRESS_HEADER = 'x-wallet-address';

/** Resolves the caller {@link Role} from a (possibly absent) wallet address. */
export interface RoleResolver {
  resolve(address: string | undefined): Promise<Role>;
}

/** Subset of {@link PoliciesRepository} the default role resolver depends on. */
export type PolicyOwnershipLookup = Pick<
  PoliciesRepository,
  'listByOwnerAddress' | 'listByDaoAddress'
>;

/**
 * Default role resolver backed by the policies table. A wallet that holds an
 * OverrideCap (matches a policy's DAO address) is a DAO_Governor; a wallet that
 * owns a policy is a Protocol_Admin; everyone else is a DeFi User. (Req 15.1)
 */
export function createRoleResolver(policies: PolicyOwnershipLookup): RoleResolver {
  return {
    async resolve(address: string | undefined): Promise<Role> {
      const wallet = address?.trim();
      if (wallet === undefined || wallet === '') {
        return 'DeFi User';
      }
      const dao = await policies.listByDaoAddress(wallet);
      if (dao.length > 0) {
        return 'DAO_Governor';
      }
      const owned = await policies.listByOwnerAddress(wallet);
      if (owned.length > 0) {
        return 'Protocol_Admin';
      }
      return 'DeFi User';
    },
  };
}

// ---------------------------------------------------------------------------
// Injected dependencies.
// ---------------------------------------------------------------------------

/** Repository surface used by the read routes (narrowed for easy faking). */
export interface ReadRouteRepositories {
  markets: Pick<MarketsRepository, 'list' | 'getById'>;
  riskSnapshots: Pick<RiskSnapshotsRepository, 'getLatestByMarket'>;
  actions: Pick<ActionsRepository, 'getById' | 'listByMarket' | 'listByIncident'>;
  incidents: Pick<IncidentsRepository, 'getById'>;
  policies: Pick<PoliciesRepository, 'listByMarketId'> & PolicyOwnershipLookup;
}

export interface ReadRouteOptions {
  repositories: ReadRouteRepositories;
  /** Defaults to a policies-backed {@link createRoleResolver}. */
  resolveRole?: RoleResolver;
  /** Optional AI incident summarizer; when present, incident GETs include a report. */
  incidentSummarizer?: IncidentSummarizer;
  /**
   * Optional reader for a REAL Sui lending protocol's live reserves. When
   * present, the risk endpoint anchors its impact figures (protected value /
   * exposure) to genuine on-chain capital instead of the synthetic baseline.
   */
  protocolReserve?: ProtocolReserveReader;
}

// ---------------------------------------------------------------------------
// Row → API DTO mappers (snake_case rows → camelCase JSON).
// ---------------------------------------------------------------------------

function toMarketSummary(row: MarketRow): Record<string, unknown> {
  return {
    id: row.id,
    onChainId: row.on_chain_id,
    marketType: row.market_type,
    name: row.name,
    status: row.status,
    freshnessThresholdMs: row.freshness_threshold_ms,
    createdAt: row.created_at,
  };
}

function toActionDto(row: ActionRow): Record<string, unknown> {
  return {
    id: row.id,
    policyId: row.policy_id,
    marketId: row.market_id,
    incidentId: row.incident_id,
    actor: row.actor,
    actorType: row.actor_type,
    riskScore: row.risk_score,
    actionType: row.action_type,
    oldValue: row.old_value,
    newValue: row.new_value,
    walrusEvidenceBlobId: row.walrus_evidence_blob_id,
    evidenceHash: row.evidence_hash,
    txDigest: row.tx_digest,
    isReversed: row.is_reversed,
    reversedBy: row.reversed_by,
    reversalTxDigest: row.reversal_tx_digest,
    overrideReason: row.override_reason,
    timestampMs: row.timestamp_ms,
    createdAt: row.created_at,
  };
}

function toPolicyParams(row: PolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    onChainPolicyId: row.on_chain_policy_id,
    guardianCapId: row.guardian_cap_id,
    overrideCapId: row.override_cap_id,
    ownerAddress: row.owner_address,
    daoAddress: row.dao_address,
    allowedActions: row.allowed_actions,
    maxLtvDeltaBps: row.max_ltv_delta_bps,
    maxMarginDeltaBps: row.max_margin_delta_bps,
    pauseDurationLimitMs: row.pause_duration_limit_ms,
    cooldownMs: row.cooldown_ms,
    riskThresholds: row.risk_thresholds,
    isRevoked: row.is_revoked,
    isPaused: row.is_paused,
    version: row.version,
    walrusConfigBlobId: row.walrus_config_blob_id,
  };
}

/**
 * Derive the DAO override status surfaced on the market detail (Req 3.6) from
 * the most recent action: a reversed action means the DAO overrode it; an
 * action carrying an override reason was DAO-overridden; otherwise none.
 */
function deriveOverrideStatus(lastAction: ActionRow | null): 'none' | 'overridden' | 'reversed' {
  if (lastAction === null) {
    return 'none';
  }
  if (lastAction.is_reversed) {
    return 'reversed';
  }
  if (lastAction.override_reason !== null && lastAction.override_reason !== '') {
    return 'overridden';
  }
  return 'none';
}

function toIncidentDto(row: IncidentRow): Record<string, unknown> {
  return {
    id: row.id,
    marketId: row.market_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    scenarioId: row.scenario_id,
    isSimulated: row.is_simulated,
    summary: row.summary,
  };
}

/** Compute freshness for the latest snapshot relative to the market threshold. */
function computeFreshness(
  snapshot: RiskSnapshotRow | null,
  freshnessThresholdMs: string,
  now: number,
): Record<string, unknown> {
  const thresholdMs = Number(freshnessThresholdMs);
  if (snapshot === null) {
    return { snapshotAt: null, ageMs: null, thresholdMs, stale: true };
  }
  const snapshotAt = new Date(snapshot.created_at);
  const ageMs = now - snapshotAt.getTime();
  return {
    snapshotAt: snapshot.created_at,
    ageMs,
    thresholdMs,
    // Older than the configured threshold ⇒ stale. (Req 3.9)
    stale: ageMs > thresholdMs,
  };
}

// ---------------------------------------------------------------------------
// Router factory.
// ---------------------------------------------------------------------------

/**
 * Build the read-endpoints router. Self-contained so the action router
 * (task 13.2) can be mounted alongside it without conflict.
 */
export function createReadRouter(options: ReadRouteOptions): Router {
  const { repositories } = options;
  const resolveRole = options.resolveRole ?? createRoleResolver(repositories.policies);
  const incidentSummarizer = options.incidentSummarizer;

  const router = Router();

  const callerAddress = (req: Request): string | undefined => {
    const header = req.header(WALLET_ADDRESS_HEADER);
    return header === undefined ? undefined : header;
  };

  // GET /api/markets — list monitored markets with status. (Req 3.2)
  router.get('/markets', async (req: Request, res: Response) => {
    const role = await resolveRole.resolve(callerAddress(req));
    const markets = await repositories.markets.list();
    res.json({ role, markets: markets.map(toMarketSummary) });
  });

  // GET /api/replay — list available real-event replays.
  router.get('/replay', (_req: Request, res: Response) => {
    res.json({
      events: HISTORICAL_EVENTS.map((e) => ({
        id: e.id,
        title: e.title,
        asset: e.asset,
        description: e.description,
        source: e.source,
      })),
    });
  });

  // GET /api/replay/:id — replay a REAL historical price series through the
  // deterministic Risk Engine and return the score trajectory + summary.
  router.get('/replay/:id', (req: Request, res: Response) => {
    const event = getHistoricalEvent(req.params.id);
    if (event === undefined) {
      res.status(404).json({ error: 'event_not_found', id: req.params.id });
      return;
    }
    res.json(runHistoricalReplay(event));
  });

  // GET /api/markets/:id — market detail. (Req 3.6)
  router.get('/markets/:id/risk', async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const role = await resolveRole.resolve(callerAddress(req));
    const market = await repositories.markets.getById(id);
    if (market === null) {
      res.status(404).json({ error: 'market_not_found', id });
      return;
    }
    const snapshot = await repositories.riskSnapshots.getLatestByMarket(market.id);
    const featureVector = (snapshot?.feature_vector ?? null) as ImpactInputs | null;
    const recommended = snapshot?.recommended_action ?? null;
    const mitigationActive = recommended !== null;

    // Per-market source provenance (real Pyth feed + liquidity venue for THIS
    // market) and whether its impact is anchored to a real external lending
    // protocol's reserves (only the SUI lending demo market is).
    const marketSources = resolveMarketSources(market.id);

    // Anchor impact to a REAL Sui lending protocol's live reserves only for the
    // market that legitimately maps to it; otherwise use the snapshot's own
    // on-chain exposure so we never misattribute another protocol's TVL.
    const reserve =
      marketSources.anchorProtocolReserve && options.protocolReserve
        ? await options.protocolReserve.read()
        : null;
    let impact = featureVector ? computeImpact(featureVector, { mitigationActive }) : null;
    if (reserve !== null) {
      impact = computeImpact(
        {
          ...(featureVector ?? {}),
          exposure: reserve.borrowedUsd,
          utilization: reserve.utilization,
        },
        { mitigationActive },
      );
    }
    res.json({
      role,
      marketId: market.id,
      status: market.status,
      riskScore: snapshot?.risk_score ?? null,
      band: snapshot?.band ?? null,
      classes: snapshot?.classes ?? [],
      confidence: snapshot?.confidence ?? null,
      recommendedAction: snapshot?.recommended_action ?? null,
      // The latest AI explanation (DeepSeek when configured, else template) so
      // the dashboard "Why?" panel is populated on initial load. (Req 3.8)
      explanation: snapshot?.explanation ?? null,
      ruleOutputs: snapshot?.rule_outputs ?? [],
      // Oracle freshness/confidence, volatility, liquidity, exposure live in the
      // snapshot's feature vector. (Req 3.5)
      indicators: snapshot?.feature_vector ?? null,
      // USD impact figures (TVL protected / exposure / loss prevented) derived
      // from the REAL on-chain exposure + live Pyth price. (Real-World value)
      impact,
      // Verifiable provenance of every live reading — all real Sui Testnet
      // sources (no mocks), resolved PER MARKET: this market's Pyth feed, its
      // liquidity venue, and its on-chain MarketState.
      sources: {
        network: 'sui:testnet',
        oracle: marketSources.oracle,
        liquidity: marketSources.liquidity,
        marketState: market.on_chain_id,
        evidence: 'Walrus',
        // Real Sui lending protocol whose live reserves anchor the impact
        // figures (read-only; Sentinel's bounded actions stay on testnet).
        // Only attached for the market that legitimately maps to it.
        protocol:
          reserve === null
            ? null
            : {
                name: reserve.name,
                slug: reserve.slug,
                network: 'sui:mainnet',
                suppliedUsd: reserve.suppliedUsd,
                borrowedUsd: reserve.borrowedUsd,
                utilization: reserve.utilization,
                url: reserve.url,
                asOfMs: reserve.asOfMs,
              },
      },
      dataSource: snapshot?.data_source ?? null,
      isSimulated: snapshot?.is_simulated ?? null,
      freshness: computeFreshness(snapshot, market.freshness_threshold_ms, Date.now()),
    });
  });

  // GET /api/markets/:id — market detail: params, last action, last tx digest,
  // last blob id, DAO override status. (Req 3.6)
  router.get('/markets/:id', async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const role = await resolveRole.resolve(callerAddress(req));
    const market = await repositories.markets.getById(id);
    if (market === null) {
      res.status(404).json({ error: 'market_not_found', id });
      return;
    }
    const [policies, actions] = await Promise.all([
      repositories.policies.listByMarketId(market.id),
      repositories.actions.listByMarket(market.id),
    ]);
    const activePolicy = policies[0] ?? null;
    const lastAction = actions[0] ?? null;

    res.json({
      role,
      market: toMarketSummary(market),
      params: activePolicy === null ? null : toPolicyParams(activePolicy),
      lastAction: lastAction === null ? null : toActionDto(lastAction),
      lastTxDigest: lastAction?.tx_digest ?? null,
      lastWalrusBlobId: lastAction?.walrus_evidence_blob_id ?? null,
      daoOverrideStatus: deriveOverrideStatus(lastAction),
    });
  });

  // GET /api/incidents/:id — incident timeline for replay. (Req 13)
  router.get('/incidents/:id', async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const role = await resolveRole.resolve(callerAddress(req));
    const incident = await repositories.incidents.getById(id);
    if (incident === null) {
      res.status(404).json({ error: 'incident_not_found', id });
      return;
    }
    const actions = await repositories.actions.listByIncident(incident.id);
    // Optional AI-authored governance report over the real incident timeline.
    let aiSummary: string | null = null;
    if (incidentSummarizer) {
      const market = await repositories.markets.getById(incident.market_id);
      try {
        aiSummary = await incidentSummarizer.summarize({
          marketName: market?.name ?? incident.market_id,
          startedAt: new Date(incident.started_at).toISOString(),
          endedAt: incident.ended_at ? new Date(incident.ended_at).toISOString() : null,
          summary: incident.summary,
          actions: actions.map((a) => ({
            actionType: a.action_type,
            actorType: a.actor_type,
            oldValue: a.old_value,
            newValue: a.new_value,
            riskScore: a.risk_score,
            txDigest: a.tx_digest,
            overrideReason: a.override_reason,
            timestampMs: a.timestamp_ms,
          })),
        });
      } catch {
        aiSummary = null;
      }
    }
    res.json({
      role,
      incident: toIncidentDto(incident),
      timeline: actions.map(toActionDto),
      aiSummary,
    });
  });

  // GET /api/actions/:id — single action record.
  router.get('/actions/:id', async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const role = await resolveRole.resolve(callerAddress(req));
    const action = await repositories.actions.getById(id);
    if (action === null) {
      res.status(404).json({ error: 'action_not_found', id });
      return;
    }
    res.json({ role, action: toActionDto(action) });
  });

  return router;
}
