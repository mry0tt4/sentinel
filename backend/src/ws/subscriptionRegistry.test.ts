/**
 * Unit tests for the WebSocket subscription core (task 13.4).
 *
 * These exercise {@link SubscriptionRegistry} directly with fake connections —
 * no real socket or `ws` server is required. A fake connection records every
 * payload it is sent so we can assert exactly who received what.
 *
 * Coverage:
 *  - subscribe then publish delivers a market-scoped message to the subscriber
 *    only; non-subscribers receive nothing,
 *  - unsubscribe stops delivery,
 *  - guardian_revoked / action_executed / override_applied / stale_data reach a
 *    market's subscribers,
 *  - env_check_failed broadcasts to all connections,
 *  - delivered message shapes match the ServerMessage union,
 *  - removeConnection cleans up so closed sockets stop receiving.
 *
 * Requirements: 3.7 (push risk updates to subscribed dashboards),
 * 12.2 (guardian_revoked reaches the dashboard), 17.5 (stale_data push).
 */

import { describe, expect, it } from 'vitest';

import type {
  ActionRecord,
  RiskSnapshot,
  ServerMessage,
} from './messages.js';
import { SubscriptionRegistry, type WsConnection } from './subscriptionRegistry.js';

/** Fake connection that captures everything sent to it as parsed messages. */
class FakeConnection implements WsConnection {
  readonly raw: string[] = [];

  send(data: string): void {
    this.raw.push(data);
  }

  /** Decoded messages this connection received, in order. */
  get received(): ServerMessage[] {
    return this.raw.map((d) => JSON.parse(d) as ServerMessage);
  }
}

const MARKET_A = 'market-a';
const MARKET_B = 'market-b';

function riskSnapshot(marketId: string): RiskSnapshot {
  return {
    marketId,
    riskScore: 82,
    band: 'ParamAdjust',
    classes: ['volatility'],
    confidence: 90,
    recommendedAction: 'reduce_ltv',
    featureVector: { volatility: 0.7 },
    modelVersion: 'v1',
    promptConfigVersion: 'v1',
    dataSource: 'live',
    isSimulated: false,
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

function actionRecord(marketId: string): ActionRecord {
  return {
    id: 'action-1',
    policyId: 'policy-1',
    marketId,
    actor: '0xagent',
    actorType: 'agent',
    riskScore: 82,
    actionType: 'pause_new_borrows',
    oldValue: null,
    newValue: 'paused',
    walrusEvidenceBlobId: 'blob-1',
    evidenceHash: '0xhash',
    txDigest: '0xdigest',
    isReversed: false,
    timestampMs: '1700000000000',
  };
}

describe('SubscriptionRegistry', () => {
  it('delivers a risk_update to a subscriber only (Req 3.7)', () => {
    const registry = new SubscriptionRegistry();
    const subscriber = new FakeConnection();
    const other = new FakeConnection();

    registry.subscribe(subscriber, MARKET_A);
    registry.addConnection(other); // connected but not subscribed to MARKET_A

    const message: ServerMessage = {
      type: 'risk_update',
      marketId: MARKET_A,
      snapshot: riskSnapshot(MARKET_A),
    };
    registry.publish(message);

    expect(subscriber.received).toEqual([message]);
    expect(other.received).toEqual([]);
  });

  it('does not deliver market-scoped messages to non-subscribers', () => {
    const registry = new SubscriptionRegistry();
    const subA = new FakeConnection();
    const subB = new FakeConnection();

    registry.subscribe(subA, MARKET_A);
    registry.subscribe(subB, MARKET_B);

    registry.publish({
      type: 'risk_update',
      marketId: MARKET_A,
      snapshot: riskSnapshot(MARKET_A),
    });

    expect(subA.received).toHaveLength(1);
    expect(subB.received).toEqual([]);
  });

  it('stops delivery after unsubscribe', () => {
    const registry = new SubscriptionRegistry();
    const conn = new FakeConnection();

    registry.subscribe(conn, MARKET_A);
    registry.unsubscribe(conn, MARKET_A);

    registry.publish({
      type: 'stale_data',
      marketId: MARKET_A,
    });

    expect(conn.received).toEqual([]);
    expect(registry.subscriberCount(MARKET_A)).toBe(0);
  });

  it('delivers guardian_revoked to the market subscribers (Req 12.2)', () => {
    const registry = new SubscriptionRegistry();
    const conn = new FakeConnection();
    registry.subscribe(conn, MARKET_A);

    const message: ServerMessage = {
      type: 'guardian_revoked',
      marketId: MARKET_A,
      at: '2024-01-01T00:00:00.000Z',
    };
    registry.publish(message);

    expect(conn.received).toEqual([message]);
  });

  it('delivers action_executed (with txDigest + blobId) to subscribers', () => {
    const registry = new SubscriptionRegistry();
    const conn = new FakeConnection();
    registry.subscribe(conn, MARKET_A);

    const message: ServerMessage = {
      type: 'action_executed',
      marketId: MARKET_A,
      action: actionRecord(MARKET_A),
    };
    registry.publish(message);

    const [received] = conn.received;
    expect(received).toEqual(message);
    expect(received.type).toBe('action_executed');
    if (received.type === 'action_executed') {
      expect(received.action.txDigest).toBe('0xdigest');
      expect(received.action.walrusEvidenceBlobId).toBe('blob-1');
    }
  });

  it('delivers override_applied to subscribers', () => {
    const registry = new SubscriptionRegistry();
    const conn = new FakeConnection();
    registry.subscribe(conn, MARKET_A);

    const message: ServerMessage = {
      type: 'override_applied',
      marketId: MARKET_A,
      action: { ...actionRecord(MARKET_A), actorType: 'dao', overrideReason: 'manual' },
    };
    registry.publish(message);

    expect(conn.received).toEqual([message]);
  });

  it('delivers stale_data to subscribers (Req 17.5)', () => {
    const registry = new SubscriptionRegistry();
    const conn = new FakeConnection();
    registry.subscribe(conn, MARKET_A);

    const message: ServerMessage = { type: 'stale_data', marketId: MARKET_A };
    registry.publish(message);

    expect(conn.received).toEqual([message]);
  });

  it('broadcasts env_check_failed to all connections regardless of subscription', () => {
    const registry = new SubscriptionRegistry();
    const subscribed = new FakeConnection();
    const bareConnected = new FakeConnection();

    registry.subscribe(subscribed, MARKET_A);
    registry.addConnection(bareConnected);

    const message: ServerMessage = {
      type: 'env_check_failed',
      checkType: 'rpc_chain_id',
      detail: 'chain id mismatch',
    };
    registry.publish(message);

    expect(subscribed.received).toEqual([message]);
    expect(bareConnected.received).toEqual([message]);
  });

  it('delivers to multiple subscribers of the same market', () => {
    const registry = new SubscriptionRegistry();
    const a = new FakeConnection();
    const b = new FakeConnection();
    registry.subscribe(a, MARKET_A);
    registry.subscribe(b, MARKET_A);

    registry.publish({ type: 'stale_data', marketId: MARKET_A });

    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
  });

  it('removeConnection stops further delivery and prunes subscriptions', () => {
    const registry = new SubscriptionRegistry();
    const conn = new FakeConnection();
    registry.subscribe(conn, MARKET_A);
    expect(registry.connectionCount).toBe(1);

    registry.removeConnection(conn);
    expect(registry.connectionCount).toBe(0);
    expect(registry.subscriberCount(MARKET_A)).toBe(0);

    registry.publish({ type: 'stale_data', marketId: MARKET_A });
    expect(conn.received).toEqual([]);
  });

  it('handles raw subscribe/unsubscribe client frames and ignores malformed ones', () => {
    const registry = new SubscriptionRegistry();
    const conn = new FakeConnection();
    registry.addConnection(conn);

    expect(registry.handleRawClientMessage(conn, JSON.stringify({ type: 'subscribe', marketId: MARKET_A }))).toBe(true);
    expect(registry.subscriberCount(MARKET_A)).toBe(1);

    // Malformed frames are ignored without throwing.
    expect(registry.handleRawClientMessage(conn, 'not-json')).toBe(false);
    expect(registry.handleRawClientMessage(conn, JSON.stringify({ type: 'bogus' }))).toBe(false);
    expect(registry.handleRawClientMessage(conn, JSON.stringify({ type: 'subscribe' }))).toBe(false);

    expect(registry.handleRawClientMessage(conn, JSON.stringify({ type: 'unsubscribe', marketId: MARKET_A }))).toBe(true);
    expect(registry.subscriberCount(MARKET_A)).toBe(0);
  });

  it('subscribe is idempotent per (connection, market)', () => {
    const registry = new SubscriptionRegistry();
    const conn = new FakeConnection();
    registry.subscribe(conn, MARKET_A);
    registry.subscribe(conn, MARKET_A);

    expect(registry.subscriberCount(MARKET_A)).toBe(1);

    registry.publish({ type: 'stale_data', marketId: MARKET_A });
    expect(conn.received).toHaveLength(1);
  });
});
