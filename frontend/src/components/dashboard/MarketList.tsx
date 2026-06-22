import type { MarketStatus, MarketSummary } from '../../lib/dashboardTypes';

export interface MarketListProps {
  markets: MarketSummary[];
  selectedId: string | null;
  onSelect: (marketId: string) => void;
}

/** CSS modifier suffix for each market status. */
const STATUS_CLASS: Record<MarketStatus, string> = {
  Normal: 'normal',
  Warning: 'warning',
  Guarded: 'guarded',
  Paused: 'paused',
  Revoked: 'revoked',
};

/**
 * Lists monitored markets with each market's current status from the set
 * {Normal, Warning, Guarded, Paused, Revoked} and lets the operator select one.
 * (Req 3.2)
 */
export function MarketList({ markets, selectedId, onSelect }: MarketListProps) {
  if (markets.length === 0) {
    return (
      <p className="market-list__empty" data-testid="market-list-empty">
        No monitored markets yet.
      </p>
    );
  }

  return (
    <ul className="market-list" data-testid="market-list">
      {markets.map((market) => {
        const selected = market.id === selectedId;
        return (
          <li key={market.id}>
            <button
              type="button"
              className={`market-list__item${selected ? ' market-list__item--selected' : ''}`}
              aria-pressed={selected}
              data-testid={`market-item-${market.id}`}
              onClick={() => onSelect(market.id)}
            >
              <span className="market-list__name">{market.name}</span>
              <span
                className={`status-pill status-pill--${STATUS_CLASS[market.status]}`}
                data-testid={`market-status-${market.id}`}
              >
                {market.status}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
