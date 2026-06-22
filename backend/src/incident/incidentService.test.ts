import { describe, expect, it } from 'vitest';

import type {
  ActionRow,
  IncidentRow,
  RiskSnapshotRow,
} from '../db/types.js';

import {
  IncidentService,
  type ActionReader,
  type IncidentReader,
  type RiskSnapshotReader,
  type TimelineActionStep,
  type TimelineSnapshotStep,
} from './incidentService.js';

// ---------------------------------------------------------------------------
// In-memory fakes for the three repository ports. No live database required.
// ---------------------------------------------------------------------------

class FakeIncidents implements IncidentReader {
  constructor(private readonly rows: Record<string, IncidentRow>) {}
  async getById(id: string): Promise<IncidentRow | null> {
    return this.rows[id] ?? null;
  }
}

class FakeRiskSnapshots implements RiskSnapshotReader {
  constructor(private readonly rows: RiskSnapshotRow[]) {}
  async listByMarket(marketId: string, limit = 100): Promise<RiskSnapshotRow[]> {
    // Mirror the real repository: newest first, capped by limit.
    return this.rows
      .filter((r) => r.market_id === marketId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, limit);
  }
}

class FakeActions implements ActionReader {
  constructor(private readonly rows: ActionRow[]) {}
  async listByIncident(incidentId: string): Promise<ActionRow[]> {
    // Mirror the real repository: oldest first.
    return this.rows
      .filter((r) => r.incident_id === incidentId)
      .sort((a, b) => Number(a.timestamp_ms) - Number(b.timestamp_ms));
  }
}

// ---------------------------------------------------------------------------
// Row builders with sensible defaults so tests state only what they assert.
// ---------------------------------------------------------------------------

function incident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc1',
    market_id: 'mkt1',
    started_at: new Date('2024-01-01T00:00:00.000Z'),
    ended_at: new Date('2024-01-01T01:00:00.000Z'),
    scenario_id: null,
    is_simulated: false,
    summary: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<RiskSnapshotRow> = {}): RiskSnapshotRow {
  return {
    id: 'snap',
    market_id: 'mkt1',
    risk_score: 0,
    band: 'Normal',
    classes: [],
    confidence: 0.9,
    feature_vector: {},
    rule_outputs: {},
    recommended_action: null,
    refusal_reason: null,
    model_version: 'm1',
    prompt_config_version: 'p1',
    explanation: null,
    is_simulated: false,
    data_source: 'live',
    created_at: new Date('2024-01-01T00:10:00.000Z'),
    ...overrides,
  };
}

function action(overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    id: 'act',
    policy_id: 'pol1',
    market_id: 'mkt1',
    incident_id: 'inc1',
    actor: '0xagent',
    actor_type: 'agent',
    risk_score: 50,
    action_type: 'set_ltv',
    old_value: null,
    new_value: null,
    walrus_evidence_blob_id: null,
    evidence_hash: null,
    tx_digest: null,
    is_reversed: false,
    reversed_by: null,
    reversal_tx_digest: null,
    override_reason: null,
    timestamp_ms: '1704067800000',
    created_at: new Date('2024-01-01T00:30:00.000Z'),
    ...overrides,
  };
}

function service(opts: {
  incidents?: IncidentRow[];
  snapshots?: RiskSnapshotRow[];
  actions?: ActionRow[];
}): IncidentService {
  const incidentMap: Record<string, IncidentRow> = {};
  for (const i of opts.incidents ?? [incident()]) {
    incidentMap[i.id] = i;
  }
  return new IncidentService({
    incidents: new FakeIncidents(incidentMap),
    riskSnapshots: new FakeRiskSnapshots(opts.snapshots ?? []),
    actions: new FakeActions(opts.actions ?? []),
  });
}

const snapshotSteps = (t: { steps: { kind: string }[] }): TimelineSnapshotStep[] =>
  t.steps.filter((s): s is TimelineSnapshotStep => s.kind === 'snapshot');
const actionSteps = (t: { steps: { kind: string }[] }): TimelineActionStep[] =>
  t.steps.filter((s): s is TimelineActionStep => s.kind === 'action');

describe('IncidentService.assembleTimeline', () => {
  it('returns null when the incident does not exist', async () => {
    const svc = service({ incidents: [incident({ id: 'inc1' })] });
    expect(await svc.assembleTimeline('missing')).toBeNull();
  });

  it('orders snapshot and action steps chronologically with score movement', async () => {
    // Req 13.1, 13.2: timeline of conditions + Risk_Score movement + per-step
    // AI explanation, oldest first.
    const svc = service({
      snapshots: [
        snapshot({
          id: 's2',
          risk_score: 80,
          band: 'Guarded',
          explanation: 'Risk climbing fast',
          created_at: new Date('2024-01-01T00:40:00.000Z'),
        }),
        snapshot({
          id: 's1',
          risk_score: 30,
          band: 'Warning',
          explanation: 'Volatility rising',
          created_at: new Date('2024-01-01T00:10:00.000Z'),
        }),
      ],
      actions: [
        action({ id: 'a1', timestamp_ms: '1704069000000' }), // 00:30:00Z
      ],
    });

    const timeline = await svc.assembleTimeline('inc1');
    expect(timeline).not.toBeNull();

    // Chronological order: s1 (00:10) -> a1 (00:30) -> s2 (00:40).
    expect(timeline!.steps.map((s) => s.atMs)).toEqual([
      new Date('2024-01-01T00:10:00.000Z').getTime(),
      new Date('2024-01-01T00:30:00.000Z').getTime(),
      new Date('2024-01-01T00:40:00.000Z').getTime(),
    ]);

    const snaps = snapshotSteps(timeline!);
    // First snapshot has no prior point: delta/direction null.
    expect(snaps[0].scoreMovement).toEqual({ score: 30, delta: null, direction: null });
    // Second snapshot moved up by 50.
    expect(snaps[1].scoreMovement).toEqual({ score: 80, delta: 50, direction: 'up' });
    // Per-step AI explanation carried through. (Req 13.2)
    expect(snaps[0].explanation).toBe('Volatility rising');
    expect(snaps[1].explanation).toBe('Risk climbing fast');
  });

  it('excludes snapshots outside the incident window', async () => {
    const svc = service({
      incidents: [
        incident({
          started_at: new Date('2024-01-01T00:00:00.000Z'),
          ended_at: new Date('2024-01-01T01:00:00.000Z'),
        }),
      ],
      snapshots: [
        snapshot({ id: 'before', created_at: new Date('2023-12-31T23:00:00.000Z') }),
        snapshot({ id: 'inside', created_at: new Date('2024-01-01T00:30:00.000Z') }),
        snapshot({ id: 'after', created_at: new Date('2024-01-01T02:00:00.000Z') }),
      ],
    });

    const timeline = await svc.assembleTimeline('inc1');
    expect(snapshotSteps(timeline!).map((s) => s.snapshotId)).toEqual(['inside']);
  });

  it('includes open-incident snapshots when ended_at is null', async () => {
    const svc = service({
      incidents: [incident({ ended_at: null })],
      snapshots: [
        snapshot({ id: 'recent', created_at: new Date('2024-06-01T00:00:00.000Z') }),
      ],
    });
    const timeline = await svc.assembleTimeline('inc1');
    expect(timeline!.endedAt).toBeNull();
    expect(snapshotSteps(timeline!).map((s) => s.snapshotId)).toEqual(['recent']);
  });

  it('carries tx digest, Walrus blob id, and before/after params on action points', async () => {
    // Req 13.3 (tx digest + linked blob id) and Req 13.5 (before/after params).
    const svc = service({
      actions: [
        action({
          id: 'a1',
          action_type: 'set_ltv',
          old_value: '7000',
          new_value: '5000',
          tx_digest: '0xdigest',
          walrus_evidence_blob_id: 'blob-123',
        }),
      ],
    });

    const timeline = await svc.assembleTimeline('inc1');
    const step = actionSteps(timeline!)[0];
    expect(step.txDigest).toBe('0xdigest');
    expect(step.walrusBlobId).toBe('blob-123');
    expect(step.params).toEqual({ before: '7000', after: '5000' });
  });

  it('marks override and revocation events on the timeline', async () => {
    // Req 13.4: override event and revocation event surfaced distinctly.
    const svc = service({
      actions: [
        action({
          id: 'override',
          actor_type: 'dao',
          action_type: 'override_action',
          override_reason: 'DAO intervened',
          timestamp_ms: '1704067800000',
        }),
        action({
          id: 'revoke',
          actor_type: 'dao',
          action_type: 'revoke_guardian',
          timestamp_ms: '1704067860000',
        }),
        action({
          id: 'reversed',
          action_type: 'set_ltv',
          is_reversed: true,
          reversed_by: '0xdao',
          reversal_tx_digest: '0xrev',
          timestamp_ms: '1704067900000',
        }),
      ],
    });

    const timeline = await svc.assembleTimeline('inc1');
    const steps = actionSteps(timeline!);
    const byId = Object.fromEntries(steps.map((s) => [s.actionId, s]));

    expect(byId.override.isOverride).toBe(true);
    expect(byId.override.overrideReason).toBe('DAO intervened');
    expect(byId.revoke.isRevocation).toBe(true);
    expect(byId.reversed.wasReversed).toBe(true);
    expect(byId.reversed.reversedBy).toBe('0xdao');
    expect(byId.reversed.reversalTxDigest).toBe('0xrev');
  });

  it('sets the simulation marker for a simulated incident', async () => {
    // Req 13.6: simulation marker when the incident originates from a simulation.
    const sim = service({ incidents: [incident({ is_simulated: true })] });
    expect((await sim.assembleTimeline('inc1'))!.isSimulated).toBe(true);

    const scenario = service({
      incidents: [incident({ is_simulated: false, scenario_id: 'scn-7' })],
    });
    const scenarioTimeline = await scenario.assembleTimeline('inc1');
    expect(scenarioTimeline!.isSimulated).toBe(true);
    expect(scenarioTimeline!.scenarioId).toBe('scn-7');
  });

  it('leaves the simulation marker unset for a live incident', async () => {
    const live = service({
      incidents: [incident({ is_simulated: false, scenario_id: null })],
    });
    const timeline = await live.assembleTimeline('inc1');
    expect(timeline!.isSimulated).toBe(false);
    expect(timeline!.scenarioId).toBeNull();
  });
});
