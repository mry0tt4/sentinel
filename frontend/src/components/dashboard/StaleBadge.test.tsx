import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StaleBadge } from './StaleBadge';

/**
 * Component tests for the stale-data badge that surfaces when a market's most
 * recent risk data is older than its freshness threshold. (Req 3.9)
 */
describe('StaleBadge', () => {
  it('renders a "Stale data" status badge when data is stale (Req 3.9)', () => {
    render(<StaleBadge stale />);

    const badge = screen.getByTestId('stale-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/stale data/i);
    // Announced to assistive tech as a status update.
    expect(badge).toHaveAttribute('role', 'status');
  });

  it('renders nothing when data is fresh', () => {
    const { container } = render(<StaleBadge stale={false} />);

    expect(screen.queryByTestId('stale-badge')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
