// Live WebSocket client abstraction for the dashboard. (Req 3.7)
//
// The client is an interface so component tests can inject a fake that pushes
// messages synchronously, without a live socket server. The real
// implementation ({@link WebSocketRiskClient}) wraps the browser `WebSocket`,
// queues subscribe/unsubscribe frames until the socket opens, and dispatches
// decoded `ServerMessage`s to registered listeners.

import { useEffect } from 'react';

import type { ClientMessage, ServerMessage } from './dashboardTypes';
import { resolveWsUrl } from './backendConfig';

/** A listener invoked for every decoded server message. */
export type RiskSocketListener = (message: ServerMessage) => void;

/**
 * The socket surface the dashboard depends on. {@link WebSocketRiskClient}
 * implements it for production; tests provide a {@link FakeRiskSocketClient}.
 */
export interface RiskSocketClient {
  /** Subscribe to live updates for a market. (Req 3.7) */
  subscribe(marketId: string): void;
  /** Stop receiving updates for a market. */
  unsubscribe(marketId: string): void;
  /** Register a message listener; returns an unsubscribe function. */
  addListener(listener: RiskSocketListener): () => void;
  /** Close the underlying connection (no-op for fakes). */
  close(): void;
}

/** The browser `WebSocket` surface this client relies on (subset). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((this: unknown, ev: unknown) => unknown) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null;
  onclose: ((this: unknown, ev: unknown) => unknown) | null;
}

/** Factory that opens a {@link WebSocketLike} for a URL. Injectable for tests. */
export type WebSocketFactory = (url: string) => WebSocketLike;

const OPEN = 1;

/**
 * Production socket client. Buffers outbound subscribe/unsubscribe frames until
 * the connection is open, parses inbound JSON into {@link ServerMessage}s, and
 * fans them out to listeners. Malformed frames are ignored rather than thrown.
 */
export class WebSocketRiskClient implements RiskSocketClient {
  private socket: WebSocketLike | null = null;
  private readonly listeners = new Set<RiskSocketListener>();
  private readonly outbox: ClientMessage[] = [];
  private readonly subscriptions = new Set<string>();
  private closed = false;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly factory: WebSocketFactory = (u) =>
      new WebSocket(u) as unknown as WebSocketLike,
  ) {}

  private ensureSocket(): WebSocketLike {
    if (this.socket) return this.socket;
    const socket = this.factory(this.url);
    socket.onopen = () => {
      this.reconnectDelay = 1000; // reset backoff on a healthy connection
      // (Re)subscribe to every active market — covers both the first connect
      // and any reconnection after the socket dropped.
      for (const marketId of this.subscriptions) {
        socket.send(JSON.stringify({ type: 'subscribe', marketId }));
      }
      // Flush any other frames queued before the socket opened.
      for (const frame of this.outbox.splice(0)) {
        socket.send(JSON.stringify(frame));
      }
    };
    socket.onmessage = (ev: { data: unknown }) => {
      const message = decodeServerMessage(ev.data);
      if (message) {
        for (const listener of this.listeners) listener(message);
      }
    };
    socket.onclose = () => this.scheduleReconnect();
    socket.onerror = () => this.scheduleReconnect();
    this.socket = socket;
    return socket;
  }

  /** Reconnect with capped exponential backoff after an unexpected drop. */
  private scheduleReconnect(): void {
    this.socket = null;
    if (this.closed || this.reconnectTimer || this.subscriptions.size === 0) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.ensureSocket();
    }, delay);
  }

  private send(frame: ClientMessage): void {
    const socket = this.ensureSocket();
    if (socket.readyState === OPEN) {
      socket.send(JSON.stringify(frame));
    } else {
      this.outbox.push(frame);
    }
  }

  subscribe(marketId: string): void {
    this.closed = false;
    if (this.subscriptions.has(marketId)) {
      this.ensureSocket();
      return;
    }
    this.subscriptions.add(marketId);
    this.send({ type: 'subscribe', marketId });
  }

  unsubscribe(marketId: string): void {
    if (!this.subscriptions.has(marketId)) return;
    this.subscriptions.delete(marketId);
    this.send({ type: 'unsubscribe', marketId });
  }

  addListener(listener: RiskSocketListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.listeners.clear();
    this.outbox.length = 0;
    this.subscriptions.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

/** Decode an inbound socket frame into a {@link ServerMessage}, or null. */
export function decodeServerMessage(data: unknown): ServerMessage | null {
  let raw: unknown = data;
  if (typeof data === 'string') {
    try {
      raw = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as { type?: unknown };
  switch (candidate.type) {
    case 'risk_update':
    case 'action_executed':
    case 'guardian_revoked':
    case 'override_applied':
    case 'stale_data':
    case 'env_check_failed':
      return raw as ServerMessage;
    default:
      return null;
  }
}

/** Resolve the dashboard WebSocket URL from env, with a sensible default. */
export function defaultRiskSocketUrl(): string {
  return resolveWsUrl();
}

/**
 * Subscribe a component to live updates for a single market. Subscribes on
 * mount / when `marketId` changes, registers the listener, and cleans both up
 * on unmount. The `client` is injectable so tests can drive messages. (Req 3.7)
 */
export function useRiskSocket(
  client: RiskSocketClient | null,
  marketId: string | null,
  onMessage: RiskSocketListener,
): void {
  useEffect(() => {
    if (!client) return;
    const removeListener = client.addListener(onMessage);
    return () => removeListener();
  }, [client, onMessage]);

  useEffect(() => {
    if (!client || !marketId) return;
    client.subscribe(marketId);
    return () => client.unsubscribe(marketId);
  }, [client, marketId]);
}
