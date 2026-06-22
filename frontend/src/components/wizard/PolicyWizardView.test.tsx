import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PolicyWizardView, type WizardWallet } from './PolicyWizardView';
import type { DraftResult, PolicyApi } from '../../lib/policyApi';
import type { PolicyDeployer } from '../../lib/policyDeployer';

// ---------------------------------------------------------------------------
// Test doubles — wallet, backend client, and deployer are all injected, so the
// wizard runs without a live wallet or backend.
// ---------------------------------------------------------------------------

function testnetWallet(overrides: Partial<WizardWallet> = {}): WizardWallet {
  return {
    connected: true,
    canSign: true,
    network: 'sui:testnet',
    signAndExecute: vi.fn().mockResolvedValue({ digest: '0xDIGEST' }),
    ...overrides,
  };
}

function okApi(): PolicyApi {
  return {
    draft: vi.fn(
      async (body): Promise<DraftResult> => ({
        ok: true,
        draft: body as unknown as Record<string, unknown>,
      }),
    ),
    persist: vi.fn(async () => ({ ok: true, status: 200 })),
  };
}

function okDeployer(): PolicyDeployer {
  return vi.fn(async (_draft, sign) => {
    const res = await sign({} as never);
    return { digest: (res as { digest: string }).digest };
  });
}

function renderWizard(opts: {
  wallet?: WizardWallet;
  api?: PolicyApi;
  deployer?: PolicyDeployer;
} = {}) {
  const wallet = opts.wallet ?? testnetWallet();
  const api = opts.api ?? okApi();
  const deployer = opts.deployer ?? okDeployer();
  render(<PolicyWizardView wallet={wallet} apiClient={api} deployer={deployer} />);
  return { wallet, api, deployer };
}

const user = () => userEvent.setup();

/** Advance through every step with valid values, stopping before sign. */
async function fillToReview(u: ReturnType<typeof userEvent.setup>) {
  // Step 1 — market type.
  await u.click(screen.getByRole('radio', { name: 'demo' }));
  await u.click(screen.getByTestId('wizard-next'));

  // Step 2 — demo market (select mode, no preset markets → text id input).
  await u.type(screen.getByLabelText('Existing demo market ID'), 'market-1');
  await u.click(screen.getByTestId('wizard-next'));

  // Step 3 — feed mapping.
  await u.type(screen.getByLabelText('Asset 1'), 'SUI');
  await u.type(screen.getByLabelText('Price feed 1'), '0xfeed');
  await u.click(screen.getByTestId('wizard-next'));

  // Step 4 — allowed actions + bounds.
  await u.click(screen.getByRole('checkbox', { name: 'pause_new_borrows' }));
  await u.type(screen.getByLabelText('Max LTV delta bps'), '500');
  await u.type(screen.getByLabelText('Max margin delta bps'), '300');
  await u.type(screen.getByLabelText('Pause duration limit ms'), '60000');
  await u.type(screen.getByLabelText('Cooldown ms'), '30000');
  await u.click(screen.getByTestId('wizard-next'));

  // Step 5 — DAO override address.
  await u.type(screen.getByLabelText('DAO override address'), '0xda0');
  await u.click(screen.getByTestId('wizard-next'));
}

describe('PolicyWizardView — wallet gating (Req 4.1)', () => {
  it('blocks the wizard when no wallet is connected', () => {
    renderWizard({ wallet: testnetWallet({ connected: false, canSign: false, network: null }) });
    expect(screen.getByTestId('wizard-gate-disconnected')).toBeInTheDocument();
    expect(screen.queryByTestId('policy-wizard')).not.toBeInTheDocument();
  });

  it('blocks the wizard and shows the wrong-network message off testnet', () => {
    renderWizard({
      wallet: testnetWallet({ connected: true, canSign: false, network: 'sui:mainnet' }),
    });
    expect(screen.getByTestId('wizard-gate-wrong-network')).toBeInTheDocument();
    expect(screen.getByTestId('wrong-network-message')).toHaveTextContent(
      /switch your wallet to Sui Testnet/i,
    );
  });
});

describe('PolicyWizardView — stepping through (Req 4.2–4.7)', () => {
  it('walks every step and reaches the review with the configured values', async () => {
    const u = user();
    renderWizard();
    await fillToReview(u);

    const review = screen.getByTestId('step-review');
    expect(within(review).getByTestId('review-marketType')).toHaveTextContent('demo');
    expect(within(review).getByTestId('review-market')).toHaveTextContent('market-1');
    expect(within(review).getByTestId('review-feeds')).toHaveTextContent('SUI → 0xfeed');
    expect(within(review).getByTestId('review-allowedActions')).toHaveTextContent(
      'pause_new_borrows',
    );
    expect(within(review).getByTestId('review-maxLtvDeltaBps')).toHaveTextContent('500');
    expect(within(review).getByTestId('review-daoAddress')).toHaveTextContent('0xda0');
  });
});

describe('PolicyWizardView — validation blocks submission (Req 4.9)', () => {
  it('blocks advancing and names a missing required value (market type)', async () => {
    const u = user();
    renderWizard();
    // Attempt to advance without choosing a market type.
    await u.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('error-marketType')).toBeInTheDocument();
    // Still on step 1.
    expect(screen.getByTestId('step-market-type')).toBeInTheDocument();
    expect(screen.queryByTestId('step-market-select')).not.toBeInTheDocument();
  });

  it('blocks advancing and identifies an out-of-range bound', async () => {
    const u = user();
    renderWizard();

    await u.click(screen.getByRole('radio', { name: 'demo' }));
    await u.click(screen.getByTestId('wizard-next'));
    await u.type(screen.getByLabelText('Existing demo market ID'), 'market-1');
    await u.click(screen.getByTestId('wizard-next'));
    await u.type(screen.getByLabelText('Asset 1'), 'SUI');
    await u.type(screen.getByLabelText('Price feed 1'), '0xfeed');
    await u.click(screen.getByTestId('wizard-next'));

    // Out-of-range max LTV delta (> 10000).
    await u.click(screen.getByRole('checkbox', { name: 'pause_new_borrows' }));
    await u.type(screen.getByLabelText('Max LTV delta bps'), '20000');
    await u.type(screen.getByLabelText('Max margin delta bps'), '300');
    await u.type(screen.getByLabelText('Pause duration limit ms'), '60000');
    await u.type(screen.getByLabelText('Cooldown ms'), '30000');
    await u.click(screen.getByTestId('wizard-next'));

    // Submission blocked: still on the thresholds step with the offending field named.
    expect(screen.getByTestId('error-maxLtvDeltaBps')).toHaveTextContent(/between 0 and 10000/i);
    expect(screen.getByTestId('step-thresholds-bounds')).toBeInTheDocument();
    expect(screen.queryByTestId('step-review')).not.toBeInTheDocument();
  });
});

describe('PolicyWizardView — sign + deploy (Req 4.8, 4.10)', () => {
  it('signs, persists, and displays the resulting tx digest on success', async () => {
    const u = user();
    const { wallet, api, deployer } = renderWizard();
    await fillToReview(u);

    // Review → sign-deploy.
    await u.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('step-sign-deploy')).toBeInTheDocument();

    const signBtn = screen.getByTestId('sign-deploy-button');
    expect(signBtn).toBeEnabled();
    await u.click(signBtn);

    expect(await screen.findByTestId('tx-digest')).toHaveTextContent('0xDIGEST');
    expect(api.draft).toHaveBeenCalledTimes(1);
    expect(deployer).toHaveBeenCalledTimes(1);
    expect(wallet.signAndExecute).toHaveBeenCalledTimes(1);
    expect(api.persist).toHaveBeenCalledTimes(1);
  });

  it('surfaces a backend validation rejection and does not deploy', async () => {
    const u = user();
    const api: PolicyApi = {
      draft: vi.fn(
        async (): Promise<DraftResult> => ({
          ok: false,
          field: 'cooldownMs',
          message: '"cooldownMs" must be between 0 and 2592000000, got 999999999999',
        }),
      ),
      persist: vi.fn(async () => ({ ok: true, status: 200 })),
    };
    const deployer = okDeployer();
    const { wallet } = renderWizard({ api, deployer });
    await fillToReview(u);
    await u.click(screen.getByTestId('wizard-next'));
    await u.click(screen.getByTestId('sign-deploy-button'));

    expect(await screen.findByTestId('server-error')).toHaveTextContent('cooldownMs');
    expect(deployer).not.toHaveBeenCalled();
    expect(wallet.signAndExecute).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tx-digest')).not.toBeInTheDocument();
  });
});
