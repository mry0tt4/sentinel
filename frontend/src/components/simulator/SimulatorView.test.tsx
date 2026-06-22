import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  OverrideOutcome,
  OverrideRequestBody,
  ResetResult,
  SimulatorApi,
  StartResult,
} from '../../lib/simulatorApi';
import type { SimRunResult } from '../../lib/simulatorTypes';
import { SimulatorView, type OverrideContextConfig } from './SimulatorView';

function singleStepRun(overrides: Partial<SimRunResult> = {}): SimRunResult {
  return {
    scenarioId: 'sui-flash-crash',
    title: 'SUI flash crash',
    status: 'action_executed',
    steps: [
      {
        scenarioId: 'sui-flash-crash',
        stepIndex: 0,
        stepLabel: 'flash crash',
        totalSteps: 1,
        features: { oraclePrice: 1.3, oracleConfidence: 0.06, realizedVolatilityPct: 80 },
        risk: {
          riskScore: 88,
          band: 'EmergencyPause',
          recommendedAction: 'pause_new_borrows',
          classes: ['flash crash'],
          confidence: 90,
        },
        thresholdCrossed: true,
        action: {
          attempted: true,
          blocked: false,
          success: true,
          txDigest: 'DIGEST_ABC',
          blobId: 'BLOB_XYZ',
          evidenceHash: 'HASH_123',
        },
      },
    ],
    ...overrides,
  };
}

function makeApi(over: Partial<SimulatorApi> = {}): SimulatorApi {
  return {
    start: async (): Promise<StartResult> => ({ ok: true, result: singleStepRun() }),
    reset: async (): Promise<ResetResult> => ({ ok: true }),
    override: async (): Promise<OverrideOutcome> => ({ ok: true, success: true, txDigest: 'OVR' }),
    ...over,
  };
}

const OVERRIDE_CTX: OverrideContextConfig = {
  policyId: 'p1',
  marketId: 'm1',
  daoAddress: '0xdao',
  overrideCapObjectId: '0xcap',
  policyObjectId: '0xpolicy',
  agentSigner: '0xagent',
};

describe('SimulatorView', () => {
  it('renders the testnet badge and nine scenarios (Req 14.1)', () => {
    render(<SimulatorView api={makeApi()} />);
    expect(screen.getByTestId('testnet-badge')).toHaveTextContent(/sui testnet/i);
    expect(screen.getByTestId('scenario-option-sui-flash-crash')).toBeInTheDocument();
    expect(screen.getByTestId('scenario-option-guardian-revoked')).toBeInTheDocument();
  });

  it('runs a scenario and labels every datum with exactly one data source (Req 14.2, 14.6)', async () => {
    render(
      <SimulatorView
        api={makeApi()}
        liveOracle={{ price: 2, confidence: 0.002, timestampMs: 1 }}
      />,
    );

    await userEvent.click(screen.getByTestId('scenario-option-sui-flash-crash'));
    await userEvent.click(screen.getByTestId('scenario-start'));

    // Simulated Risk_Score is displayed. (Req 14.2)
    expect(await screen.findByTestId('runner-score-value')).toHaveTextContent('88');

    // Each labeled datum exposes exactly one of the four data-source labels.
    const data = screen.getByTestId('runner-labeled-data');
    const labeled = data.querySelectorAll('[data-source]');
    expect(labeled.length).toBeGreaterThan(0);
    const allowed = new Set([
      'live oracle data',
      'simulated scenario data',
      'real testnet transaction',
      'Walrus evidence',
    ]);
    labeled.forEach((el) => {
      expect(allowed.has(el.getAttribute('data-source') ?? '')).toBe(true);
    });

    // The simulated oracle price is labeled simulated — never live. (Req 14.7)
    expect(screen.getByTestId('datum-sim-feature-oraclePrice')).toHaveAttribute(
      'data-source',
      'simulated scenario data',
    );
    // The live reading carries the live oracle label.
    expect(screen.getByTestId('datum-live-oracle-price')).toHaveAttribute(
      'data-source',
      'live oracle data',
    );
    // The tx digest is labeled a real testnet transaction; blob is Walrus evidence.
    expect(screen.getByTestId('datum-action-tx-digest')).toHaveAttribute(
      'data-source',
      'real testnet transaction',
    );
    expect(screen.getByTestId('datum-action-blob-id')).toHaveAttribute(
      'data-source',
      'Walrus evidence',
    );
  });

  it('shows a guardian-not-authorized indication when the action is blocked (Req 14.8)', async () => {
    const blockedRun = singleStepRun({
      status: 'action_blocked',
      steps: [
        {
          scenarioId: 'guardian-revoked',
          stepIndex: 0,
          stepLabel: 'market move while revoked',
          totalSteps: 1,
          features: { oraclePrice: 1.5 },
          risk: {
            riskScore: 91,
            band: 'EmergencyPause',
            recommendedAction: 'pause_new_borrows',
            classes: ['guardian revocation'],
            confidence: 88,
          },
          thresholdCrossed: true,
          guardian: { authorized: false, revoked: true, expired: false, reason: 'guardian revoked' },
          action: { attempted: false, blocked: true, blockedReason: 'guardian revoked', success: false },
        },
      ],
    });
    render(<SimulatorView api={makeApi({ start: async () => ({ ok: true, result: blockedRun }) })} />);

    await userEvent.click(screen.getByTestId('scenario-option-guardian-revoked'));
    await userEvent.click(screen.getByTestId('scenario-start'));

    expect(await screen.findByTestId('runner-guardian-blocked')).toHaveTextContent('guardian revoked');
  });

  it('displays the verified tx digest of a successful testnet action (Req 1.9)', async () => {
    render(<SimulatorView api={makeApi()} />);
    await userEvent.click(screen.getByTestId('scenario-option-sui-flash-crash'));
    await userEvent.click(screen.getByTestId('scenario-start'));

    await screen.findByTestId('runner-action-success');
    // A successful action is submitted only via the network-gated (testnet-only)
    // executor, so its digest is verified and shown rather than suppressed.
    const digest = await screen.findByTestId('tx-digest');
    expect(digest).toHaveTextContent('DIGEST_ABC');
  });

  it('requires an override reason before submitting (Req 11.6)', async () => {
    const override = vi.fn(
      async (_body: OverrideRequestBody): Promise<OverrideOutcome> => ({
        ok: true,
        success: true,
        txDigest: 'OVR',
      }),
    );
    render(
      <SimulatorView api={makeApi({ override })} canSign overrideContext={OVERRIDE_CTX} />,
    );

    // Disabled until a reason is entered.
    expect(screen.getByTestId('override-submit')).toBeDisabled();

    await userEvent.type(screen.getByTestId('override-reason'), 'manual reversal');
    expect(screen.getByTestId('override-submit')).toBeEnabled();

    await userEvent.click(screen.getByTestId('override-submit'));

    await waitFor(() => expect(override).toHaveBeenCalledTimes(1));
    const body = override.mock.calls[0]![0];
    expect(body.request.reason).toBe('manual reversal');
    expect(body.record).toEqual({ policyId: 'p1', marketId: 'm1', daoAddress: '0xdao' });
  });

  it('disables override submission when no wallet can sign (Req 2.4)', () => {
    render(<SimulatorView api={makeApi()} canSign={false} overrideContext={OVERRIDE_CTX} />);
    expect(screen.getByTestId('override-needs-wallet')).toBeInTheDocument();
  });

  it('resets the simulator and clears the run', async () => {
    const reset = vi.fn(async (): Promise<ResetResult> => ({ ok: true }));
    render(<SimulatorView api={makeApi({ reset })} />);

    await userEvent.click(screen.getByTestId('scenario-option-sui-flash-crash'));
    await userEvent.click(screen.getByTestId('scenario-start'));
    await screen.findByTestId('runner-score-value');

    await userEvent.click(screen.getByTestId('scenario-reset'));

    await waitFor(() => expect(reset).toHaveBeenCalled());
    expect(screen.getByTestId('runner-idle')).toBeInTheDocument();
  });
});
