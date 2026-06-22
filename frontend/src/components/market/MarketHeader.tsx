import type { MarketStatus, MarketSummary } from '../../lib/dashboardTypes';

export interface MarketHeaderProps {
  market: MarketSummary;
}

/** CSS modifier suffix for each market status (mirrors MarketList). */
const STATUS_CLASS: Record<MarketStatus, string> = {
  Normal: 'normal',
  Warning: 'warning',
  Guarded: 'guarded',
  Paused: 'paused',
  Revoked: 'revoked',
};

/**
 * Single-market detail header: the market name and its current status from the
 * set {Normal, Warning, Guarded, Paused, Revoked}. (Req 3.6)
 */
export function MarketHeader({ market }: MarketHeaderProps) {
  const statusClass = STATUS_CLASS[market.status] ?? 'normal';
  return (
    <header className="market-detail__header" data-testid="market-header">
      <div className="market-detail__title-row">
        <h2 className="market-detail__name" data-testid="market-header-name">
          {market.name}
        </h2>
        <span
          className={`status-pill status-pill--${statusClass}`}
          data-testid="market-header-status"
        >
          {market.status}
        </span>
      </div>
      {market.marketType ? (
        <p className="market-detail__subtitle" data-testid="market-header-type">
          {market.marketType}
        </p>
      ) : null}
    </header>
  );
}
