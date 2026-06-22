/**
 * Read REAL on-chain demo-market state (utilization + exposure) from the
 * provisioned `sentinel_demo_market::market::MarketState` via a read-only
 * `devInspect` call — no gas, no signing. Feeds genuine on-chain values into
 * the live risk-control loop. (Req 5.2, 6.1)
 */

import { bcs } from '@mysten/sui/bcs';
import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

export interface OnChainMarketReading {
  /** Utilization in basis points (borrow/collateral * 10_000). */
  utilizationBps: number;
  /** Outstanding borrowed amount (exposure) in simulated quote units. */
  exposure: number;
}

/**
 * devInspect `get_utilization` + `get_exposure` on the on-chain MarketState and
 * decode the two u64 return values. Returns `null` on any failure so the caller
 * falls back to its configured baseline.
 */
export async function readOnChainMarket(
  client: Pick<SuiClient, 'devInspectTransactionBlock'>,
  packageId: string,
  marketStateId: string,
  sender: string,
): Promise<OnChainMarketReading | null> {
  try {
    const tx = new Transaction();
    tx.moveCall({ target: `${packageId}::market::get_utilization`, arguments: [tx.object(marketStateId)] });
    tx.moveCall({ target: `${packageId}::market::get_exposure`, arguments: [tx.object(marketStateId)] });

    const res = await client.devInspectTransactionBlock({
      sender,
      transactionBlock: tx as unknown as Transaction,
    });
    const results = res.results ?? [];
    const util = results[0]?.returnValues?.[0]?.[0];
    const expo = results[1]?.returnValues?.[0]?.[0];
    if (!util || !expo) {
      return null;
    }
    const utilizationBps = Number(bcs.u64().parse(Uint8Array.from(util)));
    const exposure = Number(bcs.u64().parse(Uint8Array.from(expo)));
    if (!Number.isFinite(utilizationBps) || !Number.isFinite(exposure)) {
      return null;
    }
    return { utilizationBps, exposure };
  } catch {
    return null;
  }
}
