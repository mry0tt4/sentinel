// Client-side types for the Incident Replay page (Req 13).
//
// These mirror the rich `IncidentTimeline` DTO assembled by the backend
// Incident Service (`backend/src/incident/incidentService.ts`). The frontend
// keeps its own copy so the replay island bundle stays self-contained and does
// not import backend internals — the same pattern `dashboardTypes.ts` uses for
// the dashboard.
//
// A timeline is a chronologically ordered list of `TimelineStep`s. Each step is
// either:
//   - a `snapshot` step (from a `risk_snapshots` row) carrying market
//     conditions, the Risk_Score and its movement vs. the previous snapshot,
//     and the per-step AI explanation (Req 13.1, 13.2); or
//   - an `action` step (from an `actions` row) carrying the on-chain tx digest
//     and linked Walrus blob id (Req 13.3), override/revocation/reversal
//     markers (Req 13.4), and the before/after parameters of the change
//     (Req 13.5).
// The incident itself carries a simulation marker (Req 13.6).

/** Actor that performed an action. */
export type ActorType = 'agent' | 'dao' | 'admin';

/** Direction of Risk_Score change between consecutive snapshot steps. */
export type ScoreDirection = 'up' | 'down' | 'flat';

/** Risk_Score movement of a snapshot relative to the previous snapshot. */
export interface ScoreMovement {
  /** Risk_Score at this step (integer 0..100). */
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
  /**
   * Whether the tx digest has been verified by the backend Network_Guard as
   * originating from Sui Testnet. Persisted action digests are recorded only
   * after a network-gated submission, so this defaults to `true` when a digest
   * is present unless the backend marks it otherwise. Drives the guarded
   * {@link TxDigestDisplay}. (Req 1.9)
   */
  txDigestVerifiedTestnet: boolean;
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

/** The assembled incident timeline rendered by the replay UI. */
export interface IncidentTimeline {
  incidentId: string;
  marketId: string;
  /** ISO 8601 UTC incident start. */
  startedAt: string;
  /** ISO 8601 UTC incident end, or `null` while the incident is open. */
  endedAt: string | null;
  summary: string | null;
  /** AI-authored governance report over the incident timeline (advisory). */
  aiSummary?: string | null;
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

/** Narrowing helper: a snapshot step. */
export function isSnapshotStep(step: TimelineStep): step is TimelineSnapshotStep {
  return step.kind === 'snapshot';
}

/** Narrowing helper: an action step. */
export function isActionStep(step: TimelineStep): step is TimelineActionStep {
  return step.kind === 'action';
}

/** A single point on the incident score-movement chart. */
export interface ScoreMovementPoint {
  /** Sequential index of the snapshot step (chart x-axis). */
  t: number;
  /** Risk_Score at the step (chart y-axis, 0..100). */
  score: number;
  /** Epoch milliseconds of the snapshot, for tooltips. */
  atMs: number;
}

/**
 * Project the snapshot steps of a timeline into the score-movement series used
 * by {@link ScoreMovementChart}. Action steps carry no Risk_Score movement and
 * are skipped. (Req 13.1)
 */
export function toScoreMovementSeries(timeline: IncidentTimeline): ScoreMovementPoint[] {
  return timeline.steps.filter(isSnapshotStep).map((step, index) => ({
    t: index,
    score: step.scoreMovement.score,
    atMs: step.atMs,
  }));
}
