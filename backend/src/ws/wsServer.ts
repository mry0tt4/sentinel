/**
 * WebSocket transport (task 13.4).
 *
 * A thin wrapper around the `ws` library that binds real sockets to the
 * transport-agnostic {@link SubscriptionRegistry}. All subscription/routing
 * logic lives in the registry; this module only:
 *  - attaches a {@link WebSocketServer} to an existing `http.Server` (so it
 *    shares the Express server's port),
 *  - registers/cleans up connections on connect/close/error,
 *  - feeds incoming frames to {@link SubscriptionRegistry.handleRawClientMessage},
 *  - exposes {@link SubscriptionRegistry.publish} so backend services can push
 *    {@link ServerMessage}s.
 *
 * Keeping this layer minimal means the core is exercised by fast, socket-free
 * unit tests, while this wrapper is small enough to cover with one optional
 * integration test.
 */

import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import type { ServerMessage } from './messages.js';
import { SubscriptionRegistry, type MessagePublisher } from './subscriptionRegistry.js';

export interface AttachWebSocketOptions {
  /** Existing HTTP server to share a port with (e.g. the Express server). */
  server: HttpServer;
  /**
   * Path the WebSocket endpoint listens on. Defaults to `/ws`. Requests to
   * other paths are not upgraded.
   */
  path?: string;
  /**
   * Reuse an existing registry (e.g. one already shared with other services).
   * A fresh {@link SubscriptionRegistry} is created when omitted.
   */
  registry?: SubscriptionRegistry;
}

/** Handle returned by {@link attachWebSocketServer} for publishing + teardown. */
export interface WebSocketHandle extends MessagePublisher {
  /** The underlying `ws` server, for advanced callers/tests. */
  readonly wss: WebSocketServer;
  /** The subscription core, shared with backend services that publish. */
  readonly registry: SubscriptionRegistry;
  /** Push a {@link ServerMessage} to the relevant subscribers. */
  publish(message: ServerMessage): void;
  /** Close the WebSocket server (does not close the underlying HTTP server). */
  close(): Promise<void>;
}

const DEFAULT_PATH = '/ws';

/**
 * Attach a WebSocket server to an existing HTTP server and wire its sockets to
 * a {@link SubscriptionRegistry}. Returns a {@link WebSocketHandle} exposing
 * `publish` for the rest of the backend.
 */
export function attachWebSocketServer(options: AttachWebSocketOptions): WebSocketHandle {
  const registry = options.registry ?? new SubscriptionRegistry();
  const wss = new WebSocketServer({
    server: options.server,
    path: options.path ?? DEFAULT_PATH,
  });

  wss.on('connection', (socket: WebSocket) => {
    // Adapt the `ws` socket to the registry's minimal connection interface.
    const conn = { send: (data: string) => socket.send(data) };
    registry.addConnection(conn);

    socket.on('message', (raw: unknown) => {
      // `ws` delivers Buffer/ArrayBuffer/string; normalise to a string the
      // registry can JSON-parse. Malformed frames are ignored by the core.
      registry.handleRawClientMessage(conn, frameToString(raw));
    });

    const cleanup = (): void => {
      registry.removeConnection(conn);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  return {
    wss,
    registry,
    publish: (message: ServerMessage) => registry.publish(message),
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Normalise a raw `ws` frame (Buffer/ArrayBuffer/array/string) to a string. */
function frameToString(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString('utf8');
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf8');
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw as Buffer[]).toString('utf8');
  }
  return String(raw);
}
