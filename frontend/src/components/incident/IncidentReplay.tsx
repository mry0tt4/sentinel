import { useEffect, useState } from 'react';

import { createDefaultIncidentClient, type IncidentDataClient } from '../../lib/incidentApi';
import type { IncidentTimeline as IncidentTimelineData } from '../../lib/incidentTypes';
import { IncidentTimeline } from './IncidentTimeline';

export interface IncidentReplayProps {
  /** Incident id to replay (from the `/incidents/:id` route). */
  incidentId: string;
  /** Injectable backend client; defaults to the global-fetch client. */
  dataClient?: IncidentDataClient;
  /** Optionally seed the timeline (skips the initial fetch; used in tests). */
  initialTimeline?: IncidentTimelineData;
}

/**
 * Client island for the Incident Replay page. Loads the assembled timeline for
 * `incidentId` through the injectable {@link IncidentDataClient} and renders the
 * {@link IncidentTimeline}. The data client is injectable so the island can be
 * tested without a live backend. (Req 13)
 */
export function IncidentReplay({ incidentId, dataClient, initialTimeline }: IncidentReplayProps) {
  const [timeline, setTimeline] = useState<IncidentTimelineData | null>(initialTimeline ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(initialTimeline === undefined);

  useEffect(() => {
    if (initialTimeline) {
      setTimeline(initialTimeline);
      setLoading(false);
      return;
    }
    const client = dataClient ?? createDefaultIncidentClient();
    let cancelled = false;
    setLoading(true);
    client
      .getTimeline(incidentId)
      .then((t) => {
        if (cancelled) return;
        setTimeline(t);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load incident');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [incidentId, dataClient, initialTimeline]);

  if (error) {
    return (
      <p className="incident__error" role="alert" data-testid="incident-error">
        {error}
      </p>
    );
  }

  if (loading || timeline === null) {
    return (
      <p className="incident__loading" data-testid="incident-loading">
        Loading incident…
      </p>
    );
  }

  return <IncidentTimeline timeline={timeline} />;
}
