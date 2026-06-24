// Backend client abstraction for the Incident Replay page (Req 13).
//
// The HTTP transport is injectable (a `fetch`-like function) so component tests
// can drive the replay UI without a live backend. Mirrors the pattern used by
// `dashboardApi.ts` / `policyApi.ts`.
//
// The client maps the `GET /api/incidents/:id` response into the rich
// {@link IncidentTimeline} DTO the replay UI consumes. It is tolerant of two
// server shapes:
//
//   1. A rich, step-based timeline: `{ incident, timeline: { ...steps[] } }`
//      (or the timeline object at the top level) — used directly.
//   2. The current action-row response: `{ incident, timeline: ActionRow[] }`
//      — mapped into action steps plus the incident envelope, so the replay UI
//      works against today's backend while preferring the richer DTO.

import type {
  ActorType,
  BeforeAfterParams,
  IncidentTimeline,
  ScoreDirection,
  ScoreMovement,
  TimelineActionStep,
  TimelineSnapshotStep,
  TimelineStep,
} from './incidentTypes';
import { resolveBackendBaseUrl } from './backendConfig';

/** Minimal response shape compatible with the Fetch API `Response`. */
export interface BackendResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Minimal `fetch`-like transport. The global `fetch` satisfies this shape. */
export type BackendFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<BackendResponse>;

/**
 * The incident replay backend surface. {@link IncidentApiClient} implements it;
 * tests may supply a stub returning a fixture timeline.
 */
export interface IncidentDataClient {
  /** Assemble the replay timeline for an incident. (Req 13.1-13.6) */
  getTimeline(incidentId: string): Promise<IncidentTimeline>;
}

// ---------------------------------------------------------------------------
// Coercion helpers — tolerant of partial / loosely-typed JSON.
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback = ''): string {
  return value === undefined || value === null ? fallback : String(value);
}

function asNullableString(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function asActorType(value: unknown): ActorType {
  return value === 'dao' || value === 'admin' ? value : 'agent';
}

function asDirection(value: unknown): ScoreDirection | null {
  return value === 'up' || value === 'down' || value === 'flat' ? value : null;
}

function toIsoFromMs(atMs: number): string {
  return Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date(0).toISOString();
}

// ---------------------------------------------------------------------------
// Step mappers.
// ---------------------------------------------------------------------------

function toSnapshotStep(row: Record<string, unknown>): TimelineSnapshotStep {
  const movement = (row.scoreMovement ?? {}) as Record<string, unknown>;
  const scoreMovement: ScoreMovement = {
    score: asNumberOrNull(movement.score) ?? 0,
    delta: asNumberOrNull(movement.delta),
    direction: asDirection(movement.direction),
  };
  const atMs = asNumberOrNull(row.atMs) ?? 0;
  return {
    kind: 'snapshot',
    atMs,
    at: asString(row.at, toIsoFromMs(atMs)),
    snapshotId: asString(row.snapshotId),
    band: asString(row.band),
    classes: asStringArray(row.classes),
    recommendedAction: asNullableString(row.recommendedAction),
    explanation: asNullableString(row.explanation),
    scoreMovement,
  };
}

/**
 * Map an action-shaped row into a {@link TimelineActionStep}. Handles both a
 * rich step (already carrying `params` / `isOverride` / ...) and the current
 * `ActionRow` DTO (with `oldValue` / `newValue` / `actionType` / etc.).
 */
function toActionStep(row: Record<string, unknown>): TimelineActionStep {
  const rawParams = (row.params ?? null) as Record<string, unknown> | null;
  const params: BeforeAfterParams = {
    before: asNullableString(rawParams ? rawParams.before : row.oldValue),
    after: asNullableString(rawParams ? rawParams.after : row.newValue),
  };

  const actionType = asString(row.actionType);
  const actorType = asActorType(row.actorType);
  const overrideReason = asNullableString(row.overrideReason);

  // Prefer explicit markers from a rich step; otherwise derive from the action
  // type / actor (mirrors the backend Incident Service classification). (Req 13.4)
  const isOverride =
    row.isOverride !== undefined
      ? asBool(row.isOverride)
      : actionType === 'override_action' || (actorType === 'dao' && overrideReason !== null);
  const isRevocation =
    row.isRevocation !== undefined ? asBool(row.isRevocation) : actionType === 'revoke_guardian';
  const isReversal =
    row.isReversal !== undefined ? asBool(row.isReversal) : actionType === 'reverse_action';

  const atMs = asNumberOrNull(row.atMs) ?? asNumberOrNull(row.timestampMs) ?? 0;
  const txDigest = asNullableString(row.txDigest);

  return {
    kind: 'action',
    atMs,
    at: asString(row.at, toIsoFromMs(atMs)),
    actionId: asString(row.actionId ?? row.id),
    actionType,
    actor: asString(row.actor),
    actorType,
    riskScore: asNumberOrNull(row.riskScore),
    txDigest,
    // Persisted action digests are network-gated on the backend; honour an
    // explicit flag when present, else treat a present digest as verified.
    txDigestVerifiedTestnet:
      row.txDigestVerifiedTestnet !== undefined
        ? asBool(row.txDigestVerifiedTestnet)
        : txDigest !== null,
    walrusBlobId: asNullableString(row.walrusBlobId ?? row.walrusEvidenceBlobId),
    params,
    isOverride,
    isRevocation,
    isReversal,
    overrideReason,
    wasReversed: row.wasReversed !== undefined ? asBool(row.wasReversed) : asBool(row.isReversed),
    reversedBy: asNullableString(row.reversedBy),
    reversalTxDigest: asNullableString(row.reversalTxDigest),
  };
}

function toStep(row: Record<string, unknown>): TimelineStep {
  // A rich snapshot step is the only one tagged `kind: 'snapshot'`. Everything
  // else (rich action step or raw ActionRow) maps to an action step.
  return row.kind === 'snapshot' ? toSnapshotStep(row) : toActionStep(row);
}

// ---------------------------------------------------------------------------
// Timeline mapper.
// ---------------------------------------------------------------------------

/**
 * Map the `GET /api/incidents/:id` payload into an {@link IncidentTimeline},
 * tolerant of the rich step-based DTO and today's `{ incident, timeline:
 * ActionRow[] }` shape.
 */
export function mapIncidentTimeline(
  incidentId: string,
  payload: Record<string, unknown>,
): IncidentTimeline {
  // The timeline object may be at the top level or nested under `timeline`.
  const timelineObj =
    payload.timeline && !Array.isArray(payload.timeline)
      ? (payload.timeline as Record<string, unknown>)
      : payload;

  const incident = (payload.incident ?? {}) as Record<string, unknown>;

  // Steps source: a rich `steps` array, else the action-row `timeline` array.
  const rawSteps: unknown[] = Array.isArray(timelineObj.steps)
    ? (timelineObj.steps as unknown[])
    : Array.isArray(payload.timeline)
      ? (payload.timeline as unknown[])
      : [];

  const steps = rawSteps
    .map((s) => toStep(s as Record<string, unknown>))
    .sort((a, b) => a.atMs - b.atMs);

  const scenarioId = asNullableString(
    timelineObj.scenarioId ?? incident.scenarioId ?? incident.scenario_id,
  );
  const explicitSimulated =
    timelineObj.isSimulated !== undefined
      ? asBool(timelineObj.isSimulated)
      : asBool(incident.isSimulated ?? incident.is_simulated);

  return {
    incidentId: asString(timelineObj.incidentId ?? incident.id, incidentId),
    marketId: asString(timelineObj.marketId ?? incident.marketId ?? incident.market_id),
    startedAt: asString(timelineObj.startedAt ?? incident.startedAt ?? incident.started_at),
    endedAt: asNullableString(timelineObj.endedAt ?? incident.endedAt ?? incident.ended_at),
    summary: asNullableString(timelineObj.summary ?? incident.summary),
    aiSummary: asNullableString(payload.aiSummary ?? timelineObj.aiSummary),
    scenarioId,
    // Simulation marker: explicit flag, or derived from a scenario id. (Req 13.6)
    isSimulated: explicitSimulated || scenarioId !== null,
    steps,
  };
}

/**
 * Thin client over the Sentinel backend incident endpoint. All network access
 * goes through the injected {@link BackendFetch}, keeping the replay UI
 * testable without a live server.
 */
export class IncidentApiClient implements IncidentDataClient {
  private readonly fetchFn: BackendFetch;
  private readonly baseUrl: string;

  constructor(fetchFn: BackendFetch, baseUrl = '') {
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getTimeline(incidentId: string): Promise<IncidentTimeline> {
    const res = await this.fetchFn(
      `${this.baseUrl}/api/incidents/${encodeURIComponent(incidentId)}`,
      { method: 'GET' },
    );
    if (!res.ok) {
      throw new Error(`Failed to load incident ${incidentId} (status ${res.status})`);
    }
    const payload = (await res.json()) as Record<string, unknown>;
    return mapIncidentTimeline(incidentId, payload);
  }
}

/** Build an {@link IncidentApiClient} from the global `fetch`, pointed at the backend. */
export function createDefaultIncidentClient(): IncidentApiClient {
  const baseUrl = resolveBackendBaseUrl();
  const transport: BackendFetch = (url, init) =>
    fetch(url, init) as unknown as Promise<BackendResponse>;
  return new IncidentApiClient(transport, baseUrl);
}
