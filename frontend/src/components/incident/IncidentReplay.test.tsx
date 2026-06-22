import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  IncidentApiClient,
  type BackendFetch,
  type BackendResponse,
  type IncidentDataClient,
} from '../../lib/incidentApi';
import type { IncidentTimeline as IncidentTimelineData } from '../../lib/incidentTypes';
import { IncidentReplay } from './IncidentReplay';

// Component tests for the Incident Replay page (Task 20.2).
//
// These drive the REAL replay composition end to end — IncidentReplay ->
// (injectable) IncidentDataClient -> mapIncidentTimeline -> IncidentTimeline ->
// ScoreMovementChart / ActionPointMarker / BeforeAfterParams / SimulationMarker
// — with stubbed incident data so no live backend is needed. They assert:
//   - timeline assembly: condition/score-movement timeline renders in order (Req 13.1);
//   - action points render tx digest + Walrus blob id (Req 13.3);
//   - before/after parameters render (Req 13.5);
//   - the simulation marker renders where applicable (Req 13.6).

/** Build a fake BackendFetch returning a canned JSON body (mirrors incidentApi.test.ts). */
function fakeFetch(body: unknown, ok = true, status = 200): BackendFetch {
  return async (): Promise<BackendResponse> => ({
    ok,
    status,
    json: async () => body,
  });
}

/** An injectable client backed by a fake backend transport (real mapping/assembly). */
function clientReturning(body: unknown): IncidentDataClient {
  return new IncidentApiClient(fakeFetch(body));
}

/** A pure stub client that returns an already-assembled timeline. */
function stubClient(timeline: IncidentTimelineData): IncidentDataClient {
  return { getTimeline: async () => timeline };
}

describe('IncidentReplay (component)', () => {
  it('assembles and renders the condition/score-movement timeline in chronological order (Req 13.1)', async () => {
    // Backend returns a rich step-based timeline with steps OUT OF ORDER; the
    // client assembles (maps + sorts) them, and the replay renders them oldest
    // first with the score-movement chart.
    const client = clientReturning({
      incident: { id: 'inc-1' },
      timeline: {
        incidentId: 'inc-1',
        marketId: 'mkt-1',
        startedAt: '2024-01-01T00:00:00.000Z',
        endedAt: '2024-01-01T00:10:00.000Z',
        summary: 'SUI flash crash response',
        scenarioId: null,
        isSimulated: false,
        steps: [
          {
            kind: 'snapshot',
            atMs: 3_000,
            at: '2024-01-01T00:00:03.000Z',
            snapshotId: 'snap-late',
            band: 'EmergencyPause',
            classes: ['volatility'],
            recommendedAction: null,
            explanation: 'Sharp drop; emergency pause recommended.',
            scoreMovement: { score: 92, delta: 47, direction: 'up' },
          },
          {
            kind: 'snapshot',
            atMs: 1_000,
            at: '2024-01-01T00:00:01.000Z',
            snapshotId: 'snap-early',
            band: 'Warning',
            classes: [],
            recommendedAction: null,
            explanation: 'Volatility rising.',
            scoreMovement: { score: 45, delta: null, direction: null },
          },
        ],
      },
    });

    render(<IncidentReplay incidentId="inc-1" dataClient={client} />);

    // Once assembly completes, the timeline replaces the loading state.
    await waitFor(() => expect(screen.getByTestId('incident-timeline')).toBeInTheDocument());

    // Score-movement chart is present (Req 13.1).
    expect(screen.getByTestId('score-movement-chart')).toBeInTheDocument();

    // Steps are rendered oldest-first regardless of the order returned by the backend.
    const earlyStep = screen.getByTestId('snapshot-step-snap-early');
    const lateStep = screen.getByTestId('snapshot-step-snap-late');
    expect(earlyStep).toHaveTextContent('Risk 45');
    expect(lateStep).toHaveTextContent('Risk 92');
    // The early snapshot precedes the late one in document order.
    expect(
      earlyStep.compareDocumentPosition(lateStep) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The later snapshot carries the upward movement delta.
    expect(within(lateStep).getByTestId('snapshot-delta')).toHaveTextContent('+47');
  });

  it('renders action points with the tx digest and Walrus blob id (Req 13.3)', async () => {
    // Backed by the current action-row backend shape, mapped by the client.
    const client = clientReturning({
      incident: {
        id: 'inc-2',
        market_id: 'mkt-2',
        started_at: '2024-01-01T00:00:00.000Z',
      },
      timeline: [
        {
          id: 'act-1',
          actionType: 'pause_market',
          actor: '0xagent',
          actorType: 'agent',
          riskScore: 92,
          oldValue: 'ltv=80',
          newValue: 'ltv=80,paused=true',
          txDigest: 'DIGEST_ABC123',
          walrusEvidenceBlobId: 'blob-xyz-789',
          timestampMs: 3_000,
          isReversed: false,
        },
      ],
    });

    render(<IncidentReplay incidentId="inc-2" dataClient={client} />);

    const action = await screen.findByTestId('action-point-act-1');
    // Verified testnet digest is shown via the guarded TxDigestDisplay.
    expect(within(action).getByTestId('tx-digest')).toHaveTextContent('DIGEST_ABC123');
    // Linked Walrus blob id is rendered.
    expect(within(action).getByTestId('action-walrus-blob')).toHaveTextContent('blob-xyz-789');
  });

  it('renders the before/after parameters for an action (Req 13.5)', async () => {
    const client = clientReturning({
      incident: {
        id: 'inc-3',
        market_id: 'mkt-3',
        started_at: '2024-01-01T00:00:00.000Z',
      },
      timeline: [
        {
          id: 'act-2',
          actionType: 'adjust_ltv',
          actor: '0xagent',
          actorType: 'agent',
          riskScore: 70,
          oldValue: 'ltv=80',
          newValue: 'ltv=65',
          txDigest: 'DIG_LTV',
          walrusEvidenceBlobId: 'blob-ltv',
          timestampMs: 4_000,
          isReversed: false,
        },
      ],
    });

    render(<IncidentReplay incidentId="inc-3" dataClient={client} />);

    const action = await screen.findByTestId('action-point-act-2');
    expect(within(action).getByTestId('param-before')).toHaveTextContent('ltv=80');
    expect(within(action).getByTestId('param-after')).toHaveTextContent('ltv=65');
  });

  it('renders the simulation marker for a simulated incident (Req 13.6)', async () => {
    // Simulation is derived from a scenario id by the client mapper.
    const client = clientReturning({
      incident: {
        id: 'inc-4',
        market_id: 'mkt-4',
        started_at: '2024-01-01T00:00:00.000Z',
        scenario_id: 'sui-flash-crash',
      },
      timeline: [],
    });

    render(<IncidentReplay incidentId="inc-4" dataClient={client} />);

    await waitFor(() => expect(screen.getByTestId('simulation-marker')).toBeInTheDocument());
    expect(screen.getByTestId('simulation-scenario')).toHaveTextContent('sui-flash-crash');
  });

  it('omits the simulation marker for a live incident (Req 13.6)', async () => {
    const live: IncidentTimelineData = {
      incidentId: 'inc-5',
      marketId: 'mkt-5',
      startedAt: '2024-01-01T00:00:00.000Z',
      endedAt: null,
      summary: null,
      scenarioId: null,
      isSimulated: false,
      steps: [
        {
          kind: 'snapshot',
          atMs: 1_000,
          at: '2024-01-01T00:00:01.000Z',
          snapshotId: 'snap-1',
          band: 'Normal',
          classes: [],
          recommendedAction: null,
          explanation: 'Nominal conditions.',
          scoreMovement: { score: 20, delta: null, direction: null },
        },
      ],
    };

    render(<IncidentReplay incidentId="inc-5" dataClient={stubClient(live)} />);

    await waitFor(() => expect(screen.getByTestId('incident-timeline')).toBeInTheDocument());
    expect(screen.queryByTestId('simulation-marker')).not.toBeInTheDocument();
  });
});
