/**
 * Production {@link SuiEventSource} backed by `SuiClient.queryEvents`.
 *
 * Reads the `sentinel_policy` (and optionally `sentinel_demo_market`) module
 * events with cursor-based pagination in ascending order. When more than one
 * module is configured the filters are combined with `Any`. The concrete
 * `SuiClient` from `@mysten/sui/client` is structurally assignable to the
 * narrow {@link SuiQueryEventsClient} port below, so tests can still inject a
 * lightweight fake. (Req 3.7, 17.6)
 */

import type {
  EventId,
  PaginatedEvents,
  SuiEventFilter,
} from '@mysten/sui/client';

import type {
  EventCursor,
  EventPage,
  EventQuery,
  RawIndexedEvent,
  SuiEventSource,
} from './types.js';

/** Minimal subset of `SuiClient` used to read events. */
export interface SuiQueryEventsClient {
  queryEvents(input: {
    query: SuiEventFilter;
    cursor?: EventId | null;
    limit?: number | null;
    order?: 'ascending' | 'descending' | null;
  }): Promise<PaginatedEvents>;
}

/** Identifies a Move module whose events should be indexed. */
export interface ModuleRef {
  package: string;
  module: string;
}

/** Configuration for the on-chain event source. */
export interface SuiEventSourceConfig {
  /** Modules to subscribe to (e.g. policy + demo market). */
  modules: ModuleRef[];
}

/** Build the `queryEvents` filter from the configured modules. */
function buildFilter(modules: ModuleRef[]): SuiEventFilter {
  const filters: SuiEventFilter[] = modules.map((m) => ({
    MoveModule: { package: m.package, module: m.module },
  }));
  if (filters.length === 1) {
    return filters[0] as SuiEventFilter;
  }
  return { Any: filters };
}

export class SuiClientEventSource implements SuiEventSource {
  private readonly filter: SuiEventFilter;

  constructor(
    private readonly client: SuiQueryEventsClient,
    config: SuiEventSourceConfig,
  ) {
    if (config.modules.length === 0) {
      throw new Error('SuiClientEventSource requires at least one module to subscribe to');
    }
    this.filter = buildFilter(config.modules);
  }

  async queryEvents(query: EventQuery): Promise<EventPage> {
    const page = await this.client.queryEvents({
      query: this.filter,
      cursor: query.cursor ?? null,
      limit: query.limit ?? null,
      order: 'ascending',
    });

    const data: RawIndexedEvent[] = page.data.map((e) => ({
      id: { txDigest: e.id.txDigest, eventSeq: e.id.eventSeq },
      type: e.type,
      parsedJson: (e.parsedJson ?? {}) as Record<string, unknown>,
      sender: e.sender,
      timestampMs: e.timestampMs ?? null,
    }));

    const nextCursor: EventCursor | null =
      page.nextCursor === null || page.nextCursor === undefined
        ? null
        : { txDigest: page.nextCursor.txDigest, eventSeq: page.nextCursor.eventSeq };

    return { data, nextCursor, hasNextPage: page.hasNextPage };
  }
}
