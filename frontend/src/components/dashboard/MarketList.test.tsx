import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MARKET_STATUSES, type MarketSummary } from '../../lib/dashboardTypes';
import { MarketList } from './MarketList';

const markets: MarketSummary[] = MARKET_STATUSES.map((status, i) => ({
  id: `m${i}`,
  name: `${status} Market`,
  status,
}));

describe('MarketList', () => {
  it('renders each market with its status from the full status set (Req 3.2)', () => {
    render(<MarketList markets={markets} selectedId={null} onSelect={() => {}} />);

    // All five statuses {Normal, Warning, Guarded, Paused, Revoked} render.
    MARKET_STATUSES.forEach((status, i) => {
      expect(screen.getByTestId(`market-status-m${i}`)).toHaveTextContent(status);
    });
  });

  it('marks the selected market as pressed', () => {
    render(<MarketList markets={markets} selectedId="m2" onSelect={() => {}} />);
    expect(screen.getByTestId('market-item-m2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('market-item-m0')).toHaveAttribute('aria-pressed', 'false');
  });

  it('invokes onSelect with the market id when clicked', async () => {
    const onSelect = vi.fn();
    render(<MarketList markets={markets} selectedId={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByTestId('market-item-m3'));
    expect(onSelect).toHaveBeenCalledWith('m3');
  });

  it('shows an empty state when there are no markets', () => {
    render(<MarketList markets={[]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByTestId('market-list-empty')).toBeInTheDocument();
  });
});
