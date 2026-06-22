export interface StaleBadgeProps {
  /** Whether the latest risk data is older than the freshness threshold. */
  stale: boolean;
}

/**
 * Renders a "Stale data" badge when the most recent risk data for a market is
 * older than its configured freshness threshold; renders nothing otherwise.
 * (Req 3.9)
 */
export function StaleBadge({ stale }: StaleBadgeProps) {
  if (!stale) return null;
  return (
    <span className="stale-badge" data-testid="stale-badge" role="status">
      Stale data
    </span>
  );
}
