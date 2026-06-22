import { useMemo } from 'react';

import { useSuiWallet } from '../../hooks/useSuiWallet';
import {
  createDefaultSimulatorApiClient,
  type SimulatorApi,
} from '../../lib/simulatorApi';
import {
  defaultRiskSocketUrl,
  WebSocketRiskClient,
  type RiskSocketClient,
} from '../../lib/riskSocket';
import type { LiveOracleReading } from '../../lib/simulatorTypes';
import { SuiProvider } from '../SuiProvider';
import { SimulatorView, type OverrideContextConfig } from './SimulatorView';

export interface SimulatorProps {
  /** Injectable backend client; defaults to the global-fetch client. */
  api?: SimulatorApi;
  /** Injectable socket client; defaults to a browser WebSocket client. */
  socketClient?: RiskSocketClient;
  /** Demo_Market id to subscribe for live updates + override record context. */
  demoMarketId?: string;
  /** Context used to build override requests; absent disables overrides. */
  overrideContext?: OverrideContextConfig;
  /** Optional genuinely-live oracle reading (labeled `live oracle data`). */
  liveOracle?: LiveOracleReading | null;
}

/** Read a PUBLIC_ env var with a fallback (all values here are public ids). */
function env(key: string, fallback: string): string {
  const v = typeof import.meta !== 'undefined' ? import.meta.env?.[key] : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v : fallback;
}

/**
 * The demo market/policy off-chain ids + on-chain object ids the Simulation
 * Lab override console targets. Every value is public (object ids + public
 * addresses) and overridable via PUBLIC_ env vars; the override itself is
 * signed server-side by the agent key that holds the demo OverrideCap.
 */
function demoOverrideContext(): OverrideContextConfig {
  const dao = env(
    'PUBLIC_DEMO_DAO_ADDRESS',
    '0xa054daa9e6db27e623f377f17b0702222f2b54b9ef76d16ca02cf3dec189d4b4',
  );
  return {
    policyId: env('PUBLIC_DEMO_POLICY_ID', '22222222-2222-4222-8222-222222222222'),
    marketId: env('PUBLIC_DEMO_MARKET_ID', '11111111-1111-4111-8111-111111111111'),
    daoAddress: dao,
    agentSigner: dao,
    overrideCapObjectId: env(
      'PUBLIC_DEMO_OVERRIDE_CAP_ID',
      '0x72b45229d9481a87f5e82049b2a789b52dda4fcbb6cc4396e99cfb715cc2bf39',
    ),
    policyObjectId: env(
      'PUBLIC_DEMO_POLICY_OBJECT_ID',
      '0x81591e148e9a257bd175b696339eba97008fa0762b9132b6320dc1876dba8387',
    ),
    guardianCapObjectId: env(
      'PUBLIC_DEMO_GUARDIAN_CAP_ID',
      '0x21e7bf5b5989422f9a37c766735619a6c389cfbed879a795cc9ba91617ab4706',
    ),
    marketStateObjectId: env(
      'PUBLIC_DEMO_MARKET_STATE_ID',
      '0x95120424738ae3f9f159bfeafea4e6a11e462463b2b831255d1284e5c3606d12',
    ),
  };
}

export function SimulatorInner({
  api,
  socketClient,
  demoMarketId,
  overrideContext,
  liveOracle,
}: SimulatorProps) {
  const wallet = useSuiWallet();
  const client = useMemo<SimulatorApi>(() => api ?? createDefaultSimulatorApiClient(), [api]);
  const socket = useMemo<RiskSocketClient>(
    () => socketClient ?? new WebSocketRiskClient(defaultRiskSocketUrl()),
    [socketClient],
  );
  // Default the override context + subscribed market from public env so the
  // Override Console is live without callers having to thread ids through.
  const ctx = useMemo<OverrideContextConfig>(
    () => overrideContext ?? demoOverrideContext(),
    [overrideContext],
  );
  const marketId = demoMarketId ?? ctx.marketId;

  return (
    <SimulatorView
      api={client}
      socketClient={socket}
      walletNetwork={wallet.network}
      canSign={wallet.canSign}
      demoMarketId={marketId}
      overrideContext={ctx}
      liveOracle={liveOracle}
    />
  );
}

/**
 * Client-only island hosting the Simulation Lab. Wrapped in {@link SuiProvider}
 * so the wallet hook resolves for the network badge + override signing gate.
 * (Req 14.2, 14.4, 14.6, 14.7)
 */
export function Simulator(props: SimulatorProps) {
  return (
    <SuiProvider>
      <SimulatorInner {...props} />
    </SuiProvider>
  );
}
