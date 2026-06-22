/**
 * Per-market live-source provenance.
 *
 * The dashboard's "Live data sources" strip must reflect the ACTUAL feeds a
 * given market is monitored against — different markets use different Pyth
 * feeds and liquidity venues. This resolver maps an off-chain market id to its
 * real oracle feed, liquidity venue, and whether its impact figures are
 * anchored to a real external lending protocol's reserves.
 *
 * Keeping it in one data-driven place means the REST risk endpoint surfaces the
 * truth per market instead of a single hard-coded (demo) source for all.
 */

import { DEMO_DEEPBOOK_POOL, DEMO_MARKET_ID, DEMO_ORACLE_FEED_ID } from './demoMarket.js';
import { EXTRA_MARKETS_LIVE } from './extraMarkets.js';

export interface MarketSourceInfo {
  oracle: { protocol: string; market: string; feedId: string };
  liquidity: { protocol: string; market: string; pool: string };
  /**
   * Whether this market's impact ("value protected") is anchored to a real
   * external lending protocol's live reserves (Suilend). Only the primary SUI
   * lending demo market is — the others use their own on-chain exposure so we
   * never misattribute another protocol's TVL to them.
   */
  anchorProtocolReserve: boolean;
}

/** The primary demo market: real Pyth SUI/USD + real DeepBook SUI/USDC. */
const DEMO_SOURCES: MarketSourceInfo = {
  oracle: { protocol: 'Pyth', market: 'SUI/USD', feedId: DEMO_ORACLE_FEED_ID },
  liquidity: { protocol: 'DeepBook', market: 'SUI/USDC', pool: DEMO_DEEPBOOK_POOL },
  anchorProtocolReserve: true,
};

/**
 * Resolve the real live sources for a market. Falls back to the demo sources
 * for unknown ids so callers always get a populated, valid block.
 */
export function resolveMarketSources(marketId: string): MarketSourceInfo {
  if (marketId === DEMO_MARKET_ID) {
    return DEMO_SOURCES;
  }
  const extra = EXTRA_MARKETS_LIVE.find((m) => m.marketId === marketId);
  if (extra) {
    return {
      oracle: { protocol: 'Pyth', market: extra.oracleSymbol, feedId: extra.oracleFeedId },
      liquidity: extra.deepBookPool
        ? {
            protocol: 'DeepBook',
            market: extra.deepBookMarket ?? 'SUI/USDC',
            pool: extra.deepBookPool,
          }
        : // No live DeepBook book for this market on testnet — depth is modeled
          // from a stable reserve baseline, labelled honestly (not faked as a
          // live order book).
          { protocol: 'Modeled', market: 'Stable reserve depth', pool: '' },
      // Monitor-only markets are not anchored to Suilend's reserves.
      anchorProtocolReserve: false,
    };
  }
  return DEMO_SOURCES;
}
