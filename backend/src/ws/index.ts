/**
 * WebSocket module barrel (task 13.4).
 *
 * Re-exports the message types, the transport-agnostic subscription core, and
 * the `ws`-based transport so consumers can import from a single entrypoint.
 */

export {
  parseClientMessage,
  targetMarketId,
  type ActionRecord,
  type ClientMessage,
  type RiskSnapshot,
  type ServerMessage,
  type ServerMessageType,
} from './messages.js';

export {
  SubscriptionRegistry,
  type MessagePublisher,
  type WsConnection,
} from './subscriptionRegistry.js';

export {
  attachWebSocketServer,
  type AttachWebSocketOptions,
  type WebSocketHandle,
} from './wsServer.js';
