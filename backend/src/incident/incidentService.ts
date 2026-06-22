/**
 * Incident Service — assembles incident timelines for replay.
 *
 * Given an incident id, the service stitches together three off-chain sources
 * into a single chronologically ordered timeline DTO the frontend replay UI
 * (`/incidents/:id`) can render without further joins:
 *
 *  1. `risk_snapshots` for the incident's market within the incident window —
 *     each becomes a *snapshot step* carrying the market conditions, the
 *     Risk_Score, the per-step AI explanation, and the Risk_Score *movement*
 *     relative to the previous snapshot. (Req 13.1, 13.2)
 *  2. `actions` belonging to the incident — each becomes an *action step*
 *     carrying its on-chain transaction digest and the linked Walrus evidence
 *     blob id (Req 13.3), the before/after parameters of the change
 *     (Req 13.5), and override / revocation / reversal markers so the timeline
 *     can surface those events distinctly (Req 13.4).
 *  3. the `incidents` row itself — supplies the incident window plus the
 *     simulation marker set whenever the incident originated from a simulation
 *     (an explicitly simulated incident or one tied to a scenario). (Req 13.6)
 *
 * The three data sources are injected as narrow read-only *ports* so the
 * service runs against the concrete Postgres-backed repositories in production
 * (which are structurally assignable to these ports) and against in-memory
 * fakes in unit tests — no live database required.
 */

import type {
  ActionRow,
  ActorType,
  IncidentRow,
  RiskSnapshotRow,
} from '../db/types.js';

// ---------------------------------------------------------------------------
// Repository ports — the minimal read surfaces the service depends on. The
// concrete IncidentsRepository / RiskSnapshotsRepository / ActionsRepository
// satisfy these structurally.
// ---------------------------------------------------------------------------

/** Read surface of the incidents store the service needs. */
export interface IncidentReader {
  getById(id: string): Promise<IncidentRow | null>;
}

/** Read surface of the risk-snapshot store the service needs. */
export interface RiskSnapshotReader {
  listByMarket(marketId: string, limit?: number): Promise<RiskSnapshotRow[]>;
}

/** Read surface of the actions store the service needs. */
export interface ActionReader {
  listByIncident(incidentId: string): Promise<ActionRow[]>;
}

/** The three ports the {@link IncidentService} composes. */
export interface IncidentServicePorts {
  incidents: IncidentReader;
  riskSnapshots: RiskSnapshotReader;
  actions: ActionReader;
}

/** Tunable behaviour for timeline assembly. */
export interface IncidentServiceOptions {
  /**
   * Upper bound on snapshots pulled for the market before windowing. Defaults
   * to 1000 so long-running incidents are fully covered. Injectable so tests
   * can keep fakes small.
   */
  maxSnapshots?: number;
}

// ---------------------------------------------------------------------------
// Timeline DTO types.
// ---------------------------------------------------------------------------

/** Direction of Risk_Score change between consecutive snapshot steps. */
export type ScoreDirection = 'up' | 'down' | 'flat';

/** Risk_Score movement of a snapshot relative to the previous snapshot. */
export interface ScoreMovement {
  /** Risk_Score at this step. */
  score: number;
  /**
   * Signed change from the previous snapshot step, or `null` for the first
   * snapshot in the incident (no prior point to compare against).
   */
  delta: number | null;
  /** Qualitative direction of {@link delta}, or `null` for the first step. */
  direction: ScoreDirection | null;
}

/** A point on the timeline produced from a `risk_snapshots` row. (Req 13.1) */
export interface TimelineSnapshotStep {
  kind: 'snapshot';
  /** Common chronological sort key, epoch milliseconds (UTC). */
  atMs: number;
  /** ISO 8601 UTC timestamp of the snapshot. */
  at: string;
  snapshotId: string;
  /** Market conditions captured at this step. */
  band: string;
  classes: string[];
  recommendedAction: string | null;
  /** Plain-language AI explanation for this step. (Req 13.2) */
  explanation: string | null;
  /** Risk_Score and its movement vs. the previous snapshot. (Req 13.1) */
  scoreMovement: ScoreMovement;
}

/** Before/after parameter values for an action. (Req 13.5) */
export interface BeforeAfterParams {
  /** Parameter value prior to the action (`old_value`), or `null`. */
  before: string | null;
  /** Parameter value after the action (`new_value`), or `null`. */
  after: string | null;
}

/** A point on the timeline produced from an `actions` row. (Req 13.3-13.5) */
export interface TimelineActionStep {
  kind: 'action';
  /** Common chronological sort key, epoch milliseconds (UTC). */
  atMs: number;
  /** ISO 8601 UTC timestamp derived from the action's `timestamp_ms`. */
  at: string;
  actionId: string;
  actionType: string;
  actor: string;
  actorType: ActorType;
  riskScore: number | null;
  /** On-chain transaction digest for the action. (Req 13.3) */
  txDigest: string | null;
  /** Linked Walrus evidence blob id. (Req 13.3) */
  walrusBlobId: string | null;
  /** Before/after parameter values for the change. (Req 13.5) */
  params: BeforeAfterParams;
  /** True when this action is a DAO override event. (Req 13.4) */
  isOverride: boolean;
  /** True when this action revokes a Guardian_Cap. (Req 13.4) */
  isRevocation: boolean;
  /** True when this action reverses a prior action. (Req 13.4) */
  isReversal: boolean;
  /** Human-supplied reason recorded for an override, or `null`. */
  overrideReason: string | null;
  /** True when this action was itself later reversed. (Req 13.4) */
  wasReversed: boolean;
  /** Who reversed this action, if it was reversed. */
  reversedBy: string | null;
  /** Transaction digest of the reversal, if it was reversed. */
  reversalTxDigest: string | null;
}

/** A single chronological point on an incident timeline. */
export type TimelineStep = TimelineSnapshotStep | TimelineActionStep;

/** The assembled incident timeline returned to the replay UI. */
export interface IncidentTimeline {
  incidentId: string;
  marketId: string;
  /** ISO 8601 UTC incident start. */
  startedAt: string;
  /** ISO 8601 UTC incident end, or `null` while the incident is open. */
  endedAt: string | null;
  summary: string | null;
  /** Scenario id when the incident is tied to a simulation scenario. */
  scenarioId: string | null;
  /**
   * Simulation marker — true when the incident originates from a simulation
   * (explicitly simulated or attached to a scenario). (Req 13.6)
   */
  isSimulated: boolean;
  /** Chronologically ordered timeline steps (oldest first). */
  steps: TimelineStep[];
}

const DEFAULT_MAX_SNAPSHOTS = 1000;

/** Action types that represent a DAO override of agent action. (Req 13.4) */
const OVERRIDE_ACTION_TYPES = new Set(['override_action']);
/** Action types that represent a Guardian_Cap revocation. (Req 13.4) */
const REVOCATION_ACTION_TYPES = new Set(['revoke_guardian']);
/** Action types that represent reversing a prior action. (Req 13.4) */
const REVERSAL_ACTION_TYPES = new Set(['reverse_action']);

export class IncidentService {
  private readonly maxSnapshots: number;

  constructor(
    private readonly ports: IncidentServicePorts,
    options: IncidentServiceOptions = {},
  ) {
    this.maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
  }

  /**
   * Assemble the full replay timeline for an incident, or `null` if no
   * incident exists for the given id.
   */
  async assembleTimeline(incidentId: string): Promise<IncidentTimeline | null> {
    const incident = await this.ports.incidents.getById(incidentId);
    if (incident === null) {
      return null;
    }

    const [snapshotRows, actionRows] = await Promise.all([
      this.ports.riskSnapshots.listByMarket(incident.market_id, this.maxSnapshots),
      this.ports.actions.listByIncident(incidentId),
    ]);

    const snapshotSteps = buildSnapshotSteps(snapshotRows, incident);
    const actionSteps = actionRows.map(buildActionStep);

    const steps: TimelineStep[] = [...snapshotSteps, ...actionSteps].sort(
      (a, b) => a.atMs - b.atMs,
    );

    return {
      incidentId: incident.id,
      marketId: incident.market_id,
      startedAt: toIso(incident.started_at),
      endedAt: incident.ended_at === null ? null : toIso(incident.ended_at),
      summary: incident.summary,
      scenarioId: incident.scenario_id,
      // A simulation marker is set when the incident is flagged simulated or is
      // tied to a simulation scenario. (Req 13.6)
      isSimulated: incident.is_simulated || incident.scenario_id !== null,
      steps,
    };
  }
}

/**
 * Project the market's snapshots that fall within the incident window into
 * chronologically ordered snapshot steps, computing Risk_Score movement
 * between consecutive steps. (Req 13.1, 13.2)
 */
function buildSnapshotSteps(
  rows: readonly RiskSnapshotRow[],
  incident: IncidentRow,
): TimelineSnapshotStep[] {
  const startMs = incident.started_at.getTime();
  const endMs = incident.ended_at === null ? Number.POSITIVE_INFINITY : incident.ended_at.getTime();

  const windowed = rows
    .filter((row) => {
      const ms = row.created_at.getTime();
      return ms >= startMs && ms <= endMs;
    })
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  let previousScore: number | null = null;
  return windowed.map((row) => {
    const delta = previousScore === null ? null : row.risk_score - previousScore;
    const step: TimelineSnapshotStep = {
      kind: 'snapshot',
      atMs: row.created_at.getTime(),
      at: toIso(row.created_at),
      snapshotId: row.id,
      band: row.band,
      classes: row.classes,
      recommendedAction: row.recommended_action,
      explanation: row.explanation,
      scoreMovement: {
        score: row.risk_score,
        delta,
        direction: directionOf(delta),
      },
    };
    previousScore = row.risk_score;
    return step;
  });
}

/** Project an action row into a timeline action step. (Req 13.3, 13.4, 13.5) */
function buildActionStep(row: ActionRow): TimelineActionStep {
  const atMs = Number(row.timestamp_ms);
  return {
    kind: 'action',
    atMs,
    at: new Date(atMs).toISOString(),
    actionId: row.id,
    actionType: row.action_type,
    actor: row.actor,
    actorType: row.actor_type,
    riskScore: row.risk_score,
    txDigest: row.tx_digest,
    walrusBlobId: row.walrus_evidence_blob_id,
    params: {
      before: row.old_value,
      after: row.new_value,
    },
    isOverride:
      OVERRIDE_ACTION_TYPES.has(row.action_type) ||
      (row.actor_type === 'dao' && row.override_reason !== null),
    isRevocation: REVOCATION_ACTION_TYPES.has(row.action_type),
    isReversal: REVERSAL_ACTION_TYPES.has(row.action_type),
    overrideReason: row.override_reason,
    wasReversed: row.is_reversed,
    reversedBy: row.reversed_by,
    reversalTxDigest: row.reversal_tx_digest,
  };
}

/** Qualitative direction of a signed score delta. */
function directionOf(delta: number | null): ScoreDirection | null {
  if (delta === null) {
    return null;
  }
  if (delta > 0) {
    return 'up';
  }
  if (delta < 0) {
    return 'down';
  }
  return 'flat';
}

/** Render a `Date` as an ISO 8601 UTC string. */
function toIso(value: Date): string {
  return value.toISOString();
}
