import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  IncidentTimeline as IncidentTimelineData,
  TimelineActionStep,
  TimelineSnapshotStep,
} from '../../lib/incidentTypes';
import { UNVERIFIED_DIGEST_MESSAGE } from '../TxDigestDisplay';
import { IncidentTimeline } from './IncidentTimeline';

function snapshotStep(overrides: Partial<TimelineSnapshotStep> = {}): TimelineSnapshotStep {
  return {
    kind: 'snapshot',
    atMs: 1_000,
    at: '2024-01-01T00:00:01.000Z',
    snapshotId: 'snap-1',
    band: 'Warning',
    classes: ['volatility'],
    recommendedAction: null,
    explanation: 'Volatility rising on the SUI feed.',
    scoreMovement: { score: 45, delta: null, direction: null },
    ...overrides,
  };
}

function actionStep(overrides: Partial<TimelineActionStep> = {}): TimelineActionStep {
  return {
    kind: 'action',
    atMs: 3_000,
    at: '2024-01-01T00:00:03.000Z',
    actionId: 'act-1',
    actionType: 'pause_market',
    actor: '0xagent',
    actorType: 'agent',
    riskScore: 92,
    txDigest: 'DIGEST_ABC123',
    txDigestVerifiedTestnet: true,
    walrusBlobId: 'blob-xyz-789',
    params: { before: 'ltv=80', after: 'ltv=80,paused=true' },
    isOverride: false,
    isRevocation: false,
    isReversal: false,
    overrideReason: null,
    wasReversed: false,
    reversedBy: null,
    reversalTxDigest: null,
    ...overrides,
  };
}

function timeline(overrides: Partial<IncidentTimelineData> = {}): IncidentTimelineData {
  return {
    incidentId: 'inc-1',
    marketId: 'mkt-1',
    startedAt: '2024-01-01T00:00:00.000Z',
    endedAt: '2024-01-01T00:10:00.000Z',
    summary: 'SUI flash crash response',
    scenarioId: null,
    isSimulated: false,
    steps: [
      snapshotStep({
        snapshotId: 'snap-1',
        atMs: 1_000,
        scoreMovement: { score: 45, delta: null, direction: null },
      }),
      snapshotStep({
        snapshotId: 'snap-2',
        atMs: 2_000,
        at: '2024-01-01T00:00:02.000Z',
        band: 'EmergencyPause',
        explanation: 'Sharp drop detected; emergency pause recommended.',
        scoreMovement: { score: 92, delta: 47, direction: 'up' },
      }),
      actionStep(),
    ],
    ...overrides,
  };
}

describe('IncidentTimeline', () => {
  it('renders chronological snapshot steps with score movement (Req 13.1)', () => {
    render(<IncidentTimeline timeline={timeline()} />);

    // Score-movement chart present (from snapshot steps).
    expect(screen.getByTestId('score-movement-chart')).toBeInTheDocument();

    // Both snapshot steps render with their scores.
    expect(screen.getByTestId('snapshot-step-snap-1')).toHaveTextContent('Risk 45');
    const second = screen.getByTestId('snapshot-step-snap-2');
    expect(second).toHaveTextContent('Risk 92');
    // The second snapshot shows the upward movement delta.
    expect(within(second).getByTestId('snapshot-delta')).toHaveTextContent('+47');
  });

  it('shows the per-step AI explanation for snapshot steps (Req 13.2)', () => {
    render(<IncidentTimeline timeline={timeline()} />);
    const explanations = screen.getAllByTestId('snapshot-explanation');
    expect(explanations[0]).toHaveTextContent('Volatility rising on the SUI feed.');
    expect(explanations[1]).toHaveTextContent('emergency pause recommended');
  });

  it('renders action points with tx digest and Walrus blob id (Req 13.3)', () => {
    render(<IncidentTimeline timeline={timeline()} />);
    const action = screen.getByTestId('action-point-act-1');
    expect(within(action).getByTestId('tx-digest')).toHaveTextContent('DIGEST_ABC123');
    expect(within(action).getByTestId('action-walrus-blob')).toHaveTextContent('blob-xyz-789');
  });

  it('blocks an unverified tx digest on an action point (Req 1.9)', () => {
    const t = timeline({
      steps: [actionStep({ txDigest: 'UNVERIFIED', txDigestVerifiedTestnet: false })],
    });
    render(<IncidentTimeline timeline={t} />);
    expect(screen.queryByText('UNVERIFIED')).not.toBeInTheDocument();
    expect(screen.getByTestId('tx-digest-blocked')).toHaveTextContent(UNVERIFIED_DIGEST_MESSAGE);
  });

  it('surfaces override and revocation events distinctly (Req 13.4)', () => {
    const t = timeline({
      steps: [
        actionStep({
          actionId: 'ov-1',
          actionType: 'override_action',
          actorType: 'dao',
          isOverride: true,
          overrideReason: 'Manual DAO intervention',
        }),
        actionStep({
          actionId: 'rv-1',
          actionType: 'revoke_guardian',
          actorType: 'dao',
          isRevocation: true,
        }),
        actionStep({
          actionId: 'rs-1',
          actionType: 'reverse_action',
          actorType: 'dao',
          isReversal: true,
        }),
      ],
    });
    render(<IncidentTimeline timeline={t} />);

    expect(
      within(screen.getByTestId('action-point-ov-1')).getByTestId('action-marker-override'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('action-override-reason')).toHaveTextContent(
      'Manual DAO intervention',
    );
    expect(
      within(screen.getByTestId('action-point-rv-1')).getByTestId('action-marker-revocation'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('action-point-rs-1')).getByTestId('action-marker-reversal'),
    ).toBeInTheDocument();
  });

  it('shows before/after parameters for each action (Req 13.5)', () => {
    render(<IncidentTimeline timeline={timeline()} />);
    const action = screen.getByTestId('action-point-act-1');
    expect(within(action).getByTestId('param-before')).toHaveTextContent('ltv=80');
    expect(within(action).getByTestId('param-after')).toHaveTextContent('ltv=80,paused=true');
  });

  it('shows the simulation marker for a simulated incident (Req 13.6)', () => {
    render(
      <IncidentTimeline
        timeline={timeline({ isSimulated: true, scenarioId: 'sui-flash-crash' })}
      />,
    );
    expect(screen.getByTestId('simulation-marker')).toBeInTheDocument();
    expect(screen.getByTestId('simulation-scenario')).toHaveTextContent('sui-flash-crash');
  });

  it('omits the simulation marker for a live incident (Req 13.6)', () => {
    render(<IncidentTimeline timeline={timeline({ isSimulated: false, scenarioId: null })} />);
    expect(screen.queryByTestId('simulation-marker')).not.toBeInTheDocument();
  });
});
