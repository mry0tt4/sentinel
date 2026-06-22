import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  OverrideConsoleData,
  OverrideConsoleMarket,
  OverrideDataClient,
  OverrideSubmissionResult,
} from '../../lib/overrideApi';
import type { MarketSummary } from '../../lib/dashboardTypes';
import { UNVERIFIED_DIGEST_MESSAGE } from '../TxDigestDisplay';
import { OverrideConsoleView } from './OverrideConsoleView';
import type { OverrideWallet } from './overrideWallet';

const MARKET: MarketSummary = {
  id: 'market-a',
  onChainId: '0xmarket',
  name: 'SUI Lending',
  status: 'Paused',
  marketType: 'lending',
};

function entry(overrides: Partial<OverrideConsoleMarket> = {}): OverrideConsoleMarket {
  return {
    market: MARKET,
    policy: {
      id: 'policy-a',
      onChainPolicyId: '0xpolicy',
      ownerAddress: '0xowner',
      daoAddress: '0xdaoHolder',
      allowedActions: ['pause_new_borrows', 'reduce_max_ltv'],
      maxLtvDeltaBps: 500,
      maxMarginDeltaBps: 250,
      pauseDurationLimitMs: 3_600_000,
      cooldownMs: 60_000,
      isRevoked: false,
      isPaused: true,
    },
    activeAction: {
      id: 'action-1',
      policyId: 'policy-a',
      marketId: 'market-a',
      actor: '0xagent',
      actorType: 'agent',
      riskScore: 88,
      actionType: 'reduce_max_ltv',
      oldValue: '7000',
      newValue: '6500',
      walrusEvidenceBlobId: 'blob-evidence-1',
      evidenceHash: '0xhash',
      txDigest: 'DIGEST_LATEST',
      isReversed: false,
    },
    riskScoreAtAction: 88,
    evidenceBlobId: 'blob-evidence-1',
    isPaused: true,
    daoOverrideStatus: 'none',
    lastTxDigest: 'DIGEST_LATEST',
    lastTxDigestVerifiedTestnet: true,
    overrideCapHolder: '0xdaoHolder',
    ...overrides,
  };
}

function data(overrides: Partial<OverrideConsoleMarket> = {}): OverrideConsoleData {
  return { markets: [entry(overrides)] };
}

function testnetWallet(overrides: Partial<OverrideWallet> = {}): OverrideWallet {
  return {
    connected: true,
    canSign: true,
    network: 'sui:testnet',
    address: '0xdaoHolder',
    ...overrides,
  };
}

function makeClient(
  consoleData: OverrideConsoleData,
  submit?: (s: unknown) => Promise<OverrideSubmissionResult>,
): OverrideDataClient {
  return {
    loadConsole: vi.fn(async () => consoleData),
    submitOverride: vi.fn(
      submit ??
        (async () => ({
          success: true,
          operation: 'reverse_action' as const,
          txDigest: 'OVERRIDE_DIGEST',
          txDigestVerifiedTestnet: true,
          blobId: 'blob-2',
          overrideReason: 'because',
          failureReason: null,
        })),
    ),
  };
}

const user = () => userEvent.setup();

describe('OverrideConsoleView — context display (Req 11.1, 11.2)', () => {
  it('renders the OverrideCap holder, risk score at action time, evidence, and paused state', async () => {
    render(<OverrideConsoleView dataClient={makeClient(data())} wallet={testnetWallet()} />);

    const panel = await screen.findByTestId('override-panel-market-a');
    expect(within(panel).getByTestId('override-cap-holder')).toHaveTextContent('0xdaoHolder');
    expect(within(panel).getByTestId('override-risk-score')).toHaveTextContent('88');
    expect(within(panel).getByTestId('override-evidence-blob')).toHaveTextContent(
      'blob-evidence-1',
    );
    expect(within(panel).getByTestId('override-paused-badge')).toBeInTheDocument();
    expect(within(panel).getByTestId('override-action-type')).toHaveTextContent('reduce_max_ltv');
    expect(within(panel).getByTestId('override-policy-actions')).toHaveTextContent(
      'pause_new_borrows, reduce_max_ltv',
    );
  });

  it('blocks an unverified last tx digest via TxDigestDisplay (Req 1.8, 1.9)', async () => {
    render(
      <OverrideConsoleView
        dataClient={makeClient(data({ lastTxDigestVerifiedTestnet: false }))}
        wallet={testnetWallet()}
      />,
    );
    expect(await screen.findByTestId('tx-digest-blocked')).toHaveTextContent(
      UNVERIFIED_DIGEST_MESSAGE,
    );
  });
});

describe('OverrideConsoleView — controls (Req 11.5)', () => {
  it('offers confirm, revoke, update-thresholds, unpause, restore, and reverse controls', async () => {
    render(<OverrideConsoleView dataClient={makeClient(data())} wallet={testnetWallet()} />);
    const panel = await screen.findByTestId('override-panel-market-a');

    expect(within(panel).getByTestId('override-control-reverse_action')).toBeInTheDocument();
    expect(within(panel).getByTestId('override-control-confirm_action')).toBeInTheDocument();
    expect(within(panel).getByTestId('override-control-revoke_guardian')).toBeInTheDocument();
    expect(within(panel).getByTestId('override-control-update_thresholds')).toBeInTheDocument();
    expect(within(panel).getByTestId('override-control-unpause_market')).toBeInTheDocument();
    expect(within(panel).getByTestId('override-control-restore_ltv')).toBeInTheDocument();
  });
});

describe('OverrideConsoleView — preview before signing (Req 11.3)', () => {
  it('shows before/after changes when an operation is selected', async () => {
    const u = user();
    render(<OverrideConsoleView dataClient={makeClient(data())} wallet={testnetWallet()} />);
    const panel = await screen.findByTestId('override-panel-market-a');

    await u.click(within(panel).getByTestId('override-control-reverse_action'));

    expect(within(panel).getByTestId('override-preview')).toBeInTheDocument();
    expect(within(panel).getByTestId('override-preview-before-0')).toHaveTextContent('6500');
    expect(within(panel).getByTestId('override-preview-after-0')).toHaveTextContent('7000');
  });
});

describe('OverrideConsoleView — override reason required (Req 11.6)', () => {
  it('disables signing until a reason is provided', async () => {
    const u = user();
    render(<OverrideConsoleView dataClient={makeClient(data())} wallet={testnetWallet()} />);
    const panel = await screen.findByTestId('override-panel-market-a');

    await u.click(within(panel).getByTestId('override-control-reverse_action'));
    const submit = within(panel).getByTestId('override-submit-button');
    expect(submit).toBeDisabled();
    expect(within(panel).getByTestId('override-reason-required')).toBeInTheDocument();

    await u.type(within(panel).getByTestId('override-reason-input'), 'Oracle recovered');
    expect(submit).toBeEnabled();
  });
});

describe('OverrideConsoleView — resulting tx digest (Req 11.7)', () => {
  it('submits the override and displays the resulting verified tx digest', async () => {
    const u = user();
    const client = makeClient(data());
    render(<OverrideConsoleView dataClient={client} wallet={testnetWallet()} />);
    const panel = await screen.findByTestId('override-panel-market-a');

    await u.click(within(panel).getByTestId('override-control-reverse_action'));
    await u.type(within(panel).getByTestId('override-reason-input'), 'Oracle recovered');
    await u.click(within(panel).getByTestId('override-submit-button'));

    const result = await within(panel).findByTestId('override-result');
    expect(result).toBeInTheDocument();
    expect(within(result).getByTestId('tx-digest')).toHaveTextContent('OVERRIDE_DIGEST');
    expect(client.submitOverride).toHaveBeenCalledTimes(1);
  });
});

describe('OverrideConsoleView — network gate (Req 1.5, 2.4)', () => {
  it('disables signing and shows the testnet message on a wrong network', async () => {
    const u = user();
    render(
      <OverrideConsoleView
        dataClient={makeClient(data())}
        wallet={testnetWallet({ canSign: false, network: 'sui:mainnet' })}
      />,
    );
    expect(await screen.findByTestId('override-wrong-network')).toHaveTextContent(
      /switch your wallet to Sui Testnet/i,
    );

    const panel = screen.getByTestId('override-panel-market-a');
    await u.click(within(panel).getByTestId('override-control-reverse_action'));
    await u.type(within(panel).getByTestId('override-reason-input'), 'Oracle recovered');
    expect(within(panel).getByTestId('override-submit-button')).toBeDisabled();
    expect(within(panel).getByTestId('override-cannot-sign')).toBeInTheDocument();
  });
});
