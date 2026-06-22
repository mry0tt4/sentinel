/**
 * SubscriptionRegistry — the transport-agnostic core of the WebSocket server
 * (task 13.4).
 *
 * This class holds ALL the subscription/routing logic and depends on nothing
 * but a minimal {@link WsConnection} interface (`{ send(data): void }`). It
 * never imports `ws` or touches a real socket, so it is fully unit-testable
 * with fake connections. The `ws`-based transport (`wsServer.ts`) is a thin
 * wrapper that feeds raw frames and connection lifecycle events into this core.
 *
 * Responsibilities:
 *  - track connections and their per-market subscriptions,
 *  - apply subscribe/unsubscribe {@link ClientMessage}s,
 *  - route a {@link ServerMessage} to exactly the connections subscribed to its
 *    `marketId` (and broadcast `env_check_failed` to every connection).
 *
 * A reverse index (`marketId -> set of connections`) keeps {@link publish} O(k)
 * in the number of subscribers rather than O(n) in total connections.
 */

import {
  parseClientMessage,
  targetMarketId,
  type ClientMessage,
  type ServerMessage,
} from './messages.js';

/**
 * The minimal surface the core needs to deliver a message to a client. A real
 * `ws.WebSocket` satisfies this (its `send` accepts a string); tests pass a
 * fake that records what it received.
 */
export interface WsConnection {
  send(data: string): void;
}

/** A publisher other backend services depend on to push server messages. */
export interface MessagePublisher {
  publish(message: ServerMessage): void;
}

export class SubscriptionRegistry implements MessagePublisher {
  /** Forward index: each connection → the set of marketIds it subscribes to. */
  private readonly subscriptions = new Map<WsConnection, Set<string>>();

  /** Reverse index: each marketId → the set of connections subscribed to it. */
  private readonly marketSubscribers = new Map<string, Set<WsConnection>>();

  /** Register a connection. Idempotent. Call when a socket connects. */
  addConnection(conn: WsConnection): void {
    if (!this.subscriptions.has(conn)) {
      this.subscriptions.set(conn, new Set());
    }
  }

  /**
   * Remove a connection and all of its subscriptions, cleaning up the reverse
   * index. Idempotent. Call when a socket closes or errors.
   */
  removeConnection(conn: WsConnection): void {
    const markets = this.subscriptions.get(conn);
    if (markets !== undefined) {
      for (const marketId of markets) {
        this.detachFromMarket(conn, marketId);
      }
    }
    this.subscriptions.delete(conn);
  }

  /**
   * Subscribe a connection to a market's updates. Implicitly registers the
   * connection if it was not already tracked, so callers can subscribe without
   * a separate {@link addConnection} call. Idempotent per (conn, marketId).
   */
  subscribe(conn: WsConnection, marketId: string): void {
    let markets = this.subscriptions.get(conn);
    if (markets === undefined) {
      markets = new Set();
      this.subscriptions.set(conn, markets);
    }
    markets.add(marketId);

    let subscribers = this.marketSubscribers.get(marketId);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.marketSubscribers.set(marketId, subscribers);
    }
    subscribers.add(conn);
  }

  /**
   * Unsubscribe a connection from a market's updates. No-op if the connection
   * was not subscribed to that market.
   */
  unsubscribe(conn: WsConnection, marketId: string): void {
    const markets = this.subscriptions.get(conn);
    if (markets !== undefined) {
      markets.delete(marketId);
    }
    this.detachFromMarket(conn, marketId);
  }

  /**
   * Apply a parsed {@link ClientMessage} to a connection. Returns `true` when
   * the message was handled.
   */
  handleClientMessage(conn: WsConnection, message: ClientMessage): boolean {
    switch (message.type) {
      case 'subscribe':
        this.subscribe(conn, message.marketId);
        return true;
      case 'unsubscribe':
        this.unsubscribe(conn, message.marketId);
        return true;
      default:
        return false;
    }
  }

  /**
   * Parse a raw frame (a JSON string or already-decoded value) into a
   * {@link ClientMessage} and apply it. Malformed frames are ignored and
   * return `false`, so the transport never throws on bad client input.
   */
  handleRawClientMessage(conn: WsConnection, raw: string | unknown): boolean {
    let value: unknown = raw;
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw);
      } catch {
        return false;
      }
    }
    const message = parseClientMessage(value);
    if (message === null) {
      return false;
    }
    return this.handleClientMessage(conn, message);
  }

  /**
   * Route a {@link ServerMessage} to the connections that should receive it:
   *  - `env_check_failed` is broadcast to every connection,
   *  - every other message is delivered only to connections subscribed to its
   *    `marketId`.
   *
   * The payload is serialized once and reused for all recipients.
   */
  publish(message: ServerMessage): void {
    const data = JSON.stringify(message);
    const marketId = targetMarketId(message);

    if (marketId === null) {
      // Broadcast (env_check_failed) — reaches every connection.
      for (const conn of this.subscriptions.keys()) {
        conn.send(data);
      }
      return;
    }

    const subscribers = this.marketSubscribers.get(marketId);
    if (subscribers === undefined) {
      return;
    }
    for (const conn of subscribers) {
      conn.send(data);
    }
  }

  /** Number of tracked connections. Exposed for tests/observability. */
  get connectionCount(): number {
    return this.subscriptions.size;
  }

  /** Number of connections subscribed to a market. Exposed for tests. */
  subscriberCount(marketId: string): number {
    return this.marketSubscribers.get(marketId)?.size ?? 0;
  }

  /** Detach a connection from a market's reverse-index entry, pruning empties. */
  private detachFromMarket(conn: WsConnection, marketId: string): void {
    const subscribers = this.marketSubscribers.get(marketId);
    if (subscribers === undefined) {
      return;
    }
    subscribers.delete(conn);
    if (subscribers.size === 0) {
      this.marketSubscribers.delete(marketId);
    }
  }
}
