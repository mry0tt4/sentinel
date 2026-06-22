import { describe, expect, it } from 'vitest';

import {
  IncidentApiClient,
  mapIncidentTimeline,
  type BackendFetch,
  type BackendResponse,
} from './incidentApi';
import { isActionStep, isSnapshotStep } from './incidentTypes';

/** Build a fake BackendFetch returning a canned JSON body. */
function fakeFetch(body: unknown, ok = true, status = 200): BackendFetch {
  return async (): Promise<BackendResponse> => ({
    ok,
    status,
    json: async () => body,
  });
}

describe('mapIncidentTimeline', () => {
  it('maps the rich step-based timeline DTO directly', () => {
    const timeline = mapIncidentTimeline('inc-1', {
      incident: { id: 'inc-1' },
      timeline: {
        incidentId: 'inc-1',
        marketId: 'mkt-1',
        startedAt: '2024-01-01T00:00:00.000Z',
        endedAt: null,
        summary: 'sum',
        scenarioId: null,
        isSimulated: false,
        steps: [
          {
            kind: 'snapshot',
            atMs: 2_000,
            at: '2024-01-01T00:00:02.000Z',
            snapshotId: 's2',
            band: 'Warning',
            classes: ['volatility'],
            recommendedAction: null,
            explanation: 'later',
            scoreMovement: { score: 50, delta: 5, direction: 'up' },
          },
          {
            kind: 'snapshot',
            atMs: 1_000,
            at: '2024-01-01T00:00:01.000Z',
            snapshotId: 's1',
            band: 'Normal',
            classes: [],
            recommendedAction: null,
            explanation: 'first',
            scoreMovement: { score: 45, delta: null, direction: null },
          },
        ],
      },
    });

    // Steps are sorted chronologically (oldest first) by the mapper.
    expect(timeline.steps.map((s) => (isSnapshotStep(s) ? s.snapshotId : ''))).toEqual([
      's1',
      's2',
    ]);
    expect(timeline.endedAt).toBeNull();
  });

  it('maps the action-row response shape into action steps (current backend)', () => {
    const timeline = mapIncidentTimeline('inc-2', {
      incident: {
        id: 'inc-2',
        market_id: 'mkt-2',
        started_at: '2024-01-01T00:00:00.000Z',
        ended_at: null,
        summary: null,
        scenario_id: 'scn-9',
        is_simulated: false,
      },
      timeline: [
        {
          id: 'act-1',
          actionType: 'override_action',
          actor: '0xdao',
          actorType: 'dao',
          riskScore: 70,
          oldValue: 'ltv=80',
          newValue: 'ltv=70',
          txDigest: 'DIG1',
          walrusEvidenceBlobId: 'blob-1',
          overrideReason: 'manual',
          timestampMs: 5_000,
          isReversed: false,
        },
      ],
    });

    expect(timeline.marketId).toBe('mkt-2');
    // Simulation marker derived from scenario id. (Req 13.6)
    expect(timeline.isSimulated).toBe(true);
    expect(timeline.scenarioId).toBe('scn-9');

    const step = timeline.steps[0];
    expect(step).toBeDefined();
    expect(step && isActionStep(step)).toBe(true);
    if (step && isActionStep(step)) {
      expect(step.actionId).toBe('act-1');
      expect(step.params).toEqual({ before: 'ltv=80', after: 'ltv=70' });
      expect(step.txDigest).toBe('DIG1');
      expect(step.txDigestVerifiedTestnet).toBe(true);
      expect(step.walrusBlobId).toBe('blob-1');
      // Override derived from action type + dao actor. (Req 13.4)
      expect(step.isOverride).toBe(true);
      expect(step.overrideReason).toBe('manual');
    }
  });
});

describe('IncidentApiClient', () => {
  it('fetches and maps the incident timeline', async () => {
    const client = new IncidentApiClient(
      fakeFetch({
        incident: { id: 'inc-3', market_id: 'mkt-3', started_at: '2024-01-01T00:00:00.000Z' },
        timeline: [],
      }),
    );
    const timeline = await client.getTimeline('inc-3');
    expect(timeline.incidentId).toBe('inc-3');
    expect(timeline.steps).toEqual([]);
  });

  it('throws a descriptive error on a non-ok response', async () => {
    const client = new IncidentApiClient(fakeFetch({ error: 'incident_not_found' }, false, 404));
    let caught: unknown;
    try {
      await client.getTimeline('missing');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('status 404');
  });
});
