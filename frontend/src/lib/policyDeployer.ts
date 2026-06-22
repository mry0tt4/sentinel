// Submits the policy-deployment PTB. On sign, builds a Programmable
// Transaction Block invoking `sentinel_policy::policy::create_policy` and
// executes it through the wallet's `signAndExecute`, returning the resulting tx
// digest. (Req 4.8, 4.10)
//
// The deployer is injected into the wizard as a function so component tests can
// supply a stub and avoid a live wallet/chain.

import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';
import type { SignAndExecuteArgs, SignAndExecuteResult } from '../hooks/useSuiWallet';
import type { PolicyDraftBody } from './policyWizard';

/** Result of a successful policy deployment. (Req 4.10) */
export interface DeployResult {
  digest: string;
}

/**
 * Signs and submits a deployment. Implementations build (or accept) a PTB and
 * pass it to the wallet `signAndExecute`. (Req 4.8)
 */
export type PolicyDeployer = (
  draft: PolicyDraftBody,
  signAndExecute: (args: SignAndExecuteArgs) => Promise<SignAndExecuteResult>,
) => Promise<DeployResult>;

/**
 * Action-type → on-chain u8 code, matching the canonical `sentinel_adapters`
 * `ACTION_*` codes (pause=0, reduce_ltv=2, enter_guarded=4, increase_margin=6).
 */
const ACTION_CODE: Record<string, number> = {
  pause_new_borrows: 0,
  reduce_max_ltv: 2,
  enter_guarded_mode: 4,
  increase_maintenance_margin: 6,
};

/** Market-type → on-chain u8 code (`sentinel_adapters` `MARKET_TYPE_*`). */
const MARKET_TYPE_CODE: Record<string, number> = {
  lending: 0,
  perps: 1,
  stablecoin: 2,
  demo: 3,
};

/** One year, in milliseconds — the demo GuardianCap expiry horizon. */
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Default deployer: composes the `create_policy` PTB from the server-defined
 * package id and the validated draft, then signs + executes it on Sui Testnet.
 * (Req 4.8)
 *
 * `create_policy` is scoped to an on-chain market object (its `ID`). For the
 * hackathon demo only the provisioned Demo_Market object exists, so its id is
 * read from `PUBLIC_DEMO_MARKET_STATE_ID`; deploying a policy for a market
 * without a provisioned on-chain object is refused with a clear error.
 */
export const defaultPolicyDeployer: PolicyDeployer = async (draft, signAndExecute) => {
  const packageId = import.meta.env?.PUBLIC_SENTINEL_POLICY_PACKAGE_ID;
  if (!packageId) {
    throw new Error('Policy package ID is not configured. Set PUBLIC_SENTINEL_POLICY_PACKAGE_ID.');
  }

  const marketObjectId = import.meta.env?.PUBLIC_DEMO_MARKET_STATE_ID;
  if (!marketObjectId) {
    throw new Error(
      'No on-chain market object is configured. Set PUBLIC_DEMO_MARKET_STATE_ID to the ' +
        'provisioned MarketState object id to deploy a policy for the demo market.',
    );
  }

  const marketType = MARKET_TYPE_CODE[draft.marketType] ?? MARKET_TYPE_CODE.demo!;
  const allowedActionCodes = draft.allowedActions.map((action) => ACTION_CODE[action] ?? 0);
  // The agent (GuardianCap holder) and DAO (OverrideCap holder). For the demo
  // the DAO address doubles as the agent; both default to the draft DAO address.
  const agentAddress = draft.daoAddress;
  const daoAddress = draft.daoAddress;
  const guardianExpiresAtMs = Date.now() + ONE_YEAR_MS;
  // Default risk thresholds (warning/guarded/paramAdjust/emergency) as u64s.
  const riskThresholds = [40, 60, 75, 90];

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::policy::create_policy`,
    arguments: [
      tx.pure.id(marketObjectId),
      tx.pure.u8(marketType),
      tx.pure.address(agentAddress),
      tx.pure.address(daoAddress),
      tx.pure.vector('u8', allowedActionCodes),
      tx.pure.vector('id', [marketObjectId]),
      tx.pure.u64(BigInt(draft.maxLtvDeltaBps)),
      tx.pure.u64(BigInt(draft.maxMarginDeltaBps)),
      tx.pure.u64(BigInt(draft.pauseDurationLimitMs)),
      tx.pure.vector(
        'u64',
        riskThresholds.map((t) => BigInt(t)),
      ),
      tx.pure.u64(BigInt(draft.cooldownMs)),
      tx.pure.u64(BigInt(guardianExpiresAtMs)),
      tx.pure.vector('u8', []),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute({ transaction: tx } as SignAndExecuteArgs);
  const digest = (result as { digest?: string }).digest;
  if (!digest) {
    throw new Error('Deployment did not return a transaction digest.');
  }
  return { digest };
};
