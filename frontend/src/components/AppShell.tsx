import type { ReactNode } from 'react';
import { ConnectButton } from '@mysten/dapp-kit';

import { useSuiWallet } from '../hooks/useSuiWallet';
import { WRONG_NETWORK_MESSAGE } from '../lib/network';
import { SuiProvider } from './SuiProvider';
import { NetworkBadge } from './NetworkBadge';
import { Home } from './Home';
import { DashboardInner } from './dashboard/Dashboard';
import { SimulatorInner } from './simulator/Simulator';
import { OverrideConsoleInner } from './admin/OverrideConsole';
import { PolicyWizardInner } from './wizard/PolicyWizard';
import { IncidentReplay } from './incident/IncidentReplay';
import { MarketDetailInner } from './market/MarketDetail';

/** The pages the shell can render. `home`/`incident`/`market` are public; rest need a wallet. */
export type AppPage = 'home' | 'dashboard' | 'simulator' | 'policy' | 'admin' | 'incident' | 'market';

export interface AppShellProps {
  page: AppPage;
  /** Current path, for active-link highlighting. */
  currentPath?: string;
  /** Incident id, required when page is 'incident'. */
  incidentId?: string;
  /** Market id, required when page is 'market'. */
  marketId?: string;
}

interface PageMeta {
  eyebrow: string;
  title: string;
  lede: string;
  /** Protected pages require a connected, testnet wallet. */
  protected: boolean;
  content: ReactNode;
}

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/simulator', label: 'Simulation Lab' },
  { href: '/policies/new', label: 'New Policy' },
  { href: '/admin', label: 'Override Console' },
];

function pageMeta(page: AppPage, incidentId?: string, marketId?: string): PageMeta {
  switch (page) {
    case 'dashboard':
      return {
        eyebrow: 'Live monitoring',
        title: 'Risk Operations Dashboard',
        lede:
          'Monitor market health, risk scores, and indicators in real time. Live updates stream over the WebSocket as the Risk Engine recomputes scores.',
        protected: true,
        content: <DashboardInner />,
      };
    case 'simulator':
      return {
        eyebrow: 'Scenario testing',
        title: 'Simulation Lab',
        lede:
          'Run one of nine predefined risk scenarios against the Demo Market and watch the Risk Engine respond. Every value is labeled with its data source so simulated inputs are never mistaken for live readings.',
        protected: true,
        content: <SimulatorInner />,
      };
    case 'policy':
      return {
        eyebrow: 'Onboarding',
        title: 'Onboard a market',
        lede:
          'Configure and deploy a bounded Risk Policy for a market. Sentinel requires a connected Sui Testnet wallet before you can sign the deployment.',
        protected: true,
        content: <PolicyWizardInner />,
      };
    case 'admin':
      return {
        eyebrow: 'DAO controls',
        title: 'Human override console',
        lede:
          'Active actions, paused markets, the relevant policy, the risk score at action time, linked Walrus evidence, and the OverrideCap holder — preview the change, record a reason, and sign.',
        protected: true,
        content: <OverrideConsoleInner />,
      };
    case 'incident':
      return {
        eyebrow: 'Audit trail',
        title: 'Incident replay',
        lede:
          'A chronological replay of an incident — risk-score movement, the autonomous and DAO actions, on-chain tx digests, and linked Walrus evidence, with an AI governance report.',
        protected: false,
        content: <IncidentReplay incidentId={incidentId ?? ''} />,
      };
    case 'market':
      return {
        eyebrow: 'Market detail',
        title: 'Market detail',
        lede:
          'Current parameters, the last autonomous action with its on-chain tx digest and Walrus evidence, and the risk-score trend for this market.',
        protected: false,
        content: <MarketDetailInner marketId={marketId} />,
      };
    case 'home':
    default:
      return {
        eyebrow: '',
        title: '',
        lede: '',
        protected: false,
        content: <Home />,
      };
  }
}

function ShellInner({ page, currentPath, incidentId, marketId }: AppShellProps) {
  const wallet = useSuiWallet();
  const meta = pageMeta(page, incidentId, marketId);
  const path = (currentPath ?? '').replace(/\/+$/, '') || '/';
  const isActive = (href: string) => path === href || path.startsWith(`${href}/`);

  const gated = meta.protected && !wallet.connected;
  const wrongNetwork = meta.protected && wallet.connected && !wallet.canSign;

  return (
    <div className="app-shell">
      <header className="app-nav">
        <div className="app-nav__inner">
          <a className="app-brand" href="/">
            <span className="app-brand__mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                <path
                  d="M12 2.5 4 5.5v6c0 4.5 3.2 8 8 10 4.8-2 8-5.5 8-10v-6L12 2.5Z"
                  fill="url(#shieldg)"
                />
                <path
                  d="M8.5 12.2l2.4 2.4 4.6-5"
                  stroke="#fff"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <defs>
                  <linearGradient id="shieldg" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#8474ff" />
                    <stop offset="1" stopColor="#4f3fd6" />
                  </linearGradient>
                </defs>
              </svg>
            </span>
            <span className="app-brand__text">Sentinel</span>
          </a>

          <nav className="app-nav__links" aria-label="Primary">
            {wallet.connected
              ? NAV_ITEMS.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className={`app-nav__link${isActive(item.href) ? ' app-nav__link--active' : ''}`}
                    aria-current={isActive(item.href) ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                ))
              : null}
          </nav>

          <div className="app-nav__actions wallet-menu" data-connected={wallet.connected ? 'true' : 'false'}>
            <NetworkBadge network={wallet.network} />
            <ConnectButton connectText="Connect Wallet" />
          </div>
        </div>
      </header>

      <main className={`app-main${page === 'home' ? ' app-main--home' : ''}`}>
        {meta.title ? (
          <header className="page-head">
            {meta.eyebrow ? <span className="eyebrow">{meta.eyebrow}</span> : null}
            <h1>{meta.title}</h1>
            <p>{meta.lede}</p>
          </header>
        ) : null}

        {gated ? (
          <section className="connect-gate" data-testid="connect-gate">
            <div className="connect-gate__icon" aria-hidden="true">🔐</div>
            <h2 className="connect-gate__title">Connect your wallet to continue</h2>
            <p className="connect-gate__lede">
              Sentinel is a Sui Testnet application. Connect a wallet to access the {meta.title}.
            </p>
            <div className="connect-gate__action">
              <ConnectButton connectText="Connect Wallet" />
            </div>
          </section>
        ) : wrongNetwork ? (
          <section className="connect-gate" data-testid="connect-gate-wrong-network">
            <div className="connect-gate__icon" aria-hidden="true">⚠️</div>
            <h2 className="connect-gate__title">Wrong network</h2>
            <p className="connect-gate__lede" role="alert">
              {WRONG_NETWORK_MESSAGE}
            </p>
            <div className="connect-gate__action">
              <NetworkBadge network={wallet.network} />
            </div>
          </section>
        ) : (
          meta.content
        )}
      </main>

      {page !== 'home' ? (
        <footer className="app-footer">
          <div className="app-footer__inner">
            <span className="app-footer__dot" aria-hidden="true" />
            Running on <strong>Sui Testnet</strong> for the hackathon demo · Mainnet disabled · Evidence on{' '}
            <strong>Walrus</strong>
          </div>
        </footer>
      ) : null}
    </div>
  );
}

/**
 * The single client-only React root for a page. One {@link SuiProvider} wraps
 * BOTH the nav wallet controls AND the page content, so wallet state is shared
 * across the entire page (fixing the previous split-island desync). Protected
 * pages are gated behind a connected Sui Testnet wallet.
 */
export function AppShell(props: AppShellProps) {
  return (
    <SuiProvider>
      <ShellInner {...props} />
    </SuiProvider>
  );
}
