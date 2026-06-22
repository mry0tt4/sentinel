/**
 * Light integration test for the `ws`-based transport (task 13.4).
 *
 * Opens a real HTTP server, attaches the WebSocket transport, connects a real
 * `ws` client, subscribes over the wire, and asserts that a published
 * market-scoped message is delivered to the subscriber while a non-subscriber
 * client does not receive it. This validates the thin transport wiring around
 * the already-unit-tested {@link SubscriptionRegistry}.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerMessage } from './messages.js';
import { attachWebSocketServer, type WebSocketHandle } from './wsServer.js';

let httpServer: HttpServer;
let handle: WebSocketHandle;
let baseUrl: string;

beforeEach(async () => {
  httpServer = createServer();
  handle = attachWebSocketServer({ server: httpServer, path: '/ws' });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}/ws`;
});

afterEach(async () => {
  await handle.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** Open a client and wait until it is connected. */
function openClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(baseUrl);
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
}

/** Wait for the next message on a client, decoded as a ServerMessage. */
function nextMessage(client: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    client.once('message', (data) => resolve(JSON.parse(data.toString()) as ServerMessage));
  });
}

describe('attachWebSocketServer (integration)', () => {
  it('delivers a published message to a subscribed client over a real socket', async () => {
    const subscriber = await openClient();
    const message: ServerMessage = { type: 'stale_data', marketId: 'market-a' };

    const delivered = nextMessage(subscriber);
    subscriber.send(JSON.stringify({ type: 'subscribe', marketId: 'market-a' }));

    // Give the server a moment to register the subscription before publishing.
    await new Promise((r) => setTimeout(r, 50));
    handle.publish(message);

    expect(await delivered).toEqual(message);
    subscriber.close();
  });

  it('does not deliver a market-scoped message to a non-subscriber', async () => {
    const other = await openClient();
    await new Promise((r) => setTimeout(r, 50));

    let received = false;
    other.on('message', () => {
      received = true;
    });

    handle.publish({ type: 'stale_data', marketId: 'market-a' });
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toBe(false);
    other.close();
  });

  it('broadcasts env_check_failed to all connected clients', async () => {
    const client = await openClient();
    await new Promise((r) => setTimeout(r, 50));

    const delivered = nextMessage(client);
    handle.publish({ type: 'env_check_failed', checkType: 'rpc_chain_id', detail: 'mismatch' });

    expect(await delivered).toEqual({
      type: 'env_check_failed',
      checkType: 'rpc_chain_id',
      detail: 'mismatch',
    });
    client.close();
  });
});
