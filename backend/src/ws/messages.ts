/**
 * WebSocket message types (task 13.4).
 *
 * These discriminated unions mirror the design's "WebSocket Message Types"
 * section exactly. The backend pushes {@link ServerMessage}s to subscribed
 * dashboards; clients send {@link ClientMessage}s to manage their per-market
 * subscriptions.
 *
 * Payload shapes (`RiskSnapshot`, `ActionRecord`) intentionally match the
 * camelCase DTOs the REST read routes already emit (`readRoutes.ts`), so the
 * dashboard consumes the same shape whether it arrives over HTTP or the socket.
 *
 *   risk_update       — Risk Engine pushed a fresh evaluation. (Req 3.7)
 *   action_executed   — an autonomous/bounded action landed on-chain (carries
 *                       txDigest + blobId via the ActionRecord). (Req 3.7)
 *   guardian_revoked  — the DAO revoked the guardian; the dashboard must show
 *                       "Revoked" within 5s. (Req 12.2)
 *   override_applied  — the DAO overrode/reversed an action.
 *   stale_data        — oracle data for a market exceeded its freshness
 *                       threshold. (Req 3.9, 17.5)
 *   env_check_failed  — a network/environment check failed; broadcast to all
 *                       connections (not scoped to a single market).
 */

/**
 * Risk snapshot payload carried by a `risk_update` message. Matches the
 * camelCase risk DTO emitted by `GET /api/markets/:id/risk`.
 */
export interface RiskSnapshot {
  marketId: string;
  riskScore: number;
  band: string;
  classes: string[];
  confidence: number;
  recommendedAction: string | null;
  refusalReason?: string | null;
  featureVector: unknown;
  ruleOutputs?: unknown;
  modelVersion: string;
  promptConfigVersion: string;
  explanation?: string | null;
  dataSource: 'live' | 'simulated';
  isSimulated: boolean;
  createdAt: string;
}

/**
 * Action record payload carried by `action_executed` / `override_applied`
 * messages. Matches the camelCase action DTO emitted by the read routes and
 * includes `txDigest` and `walrusEvidenceBlobId`.
 */
export interface ActionRecord {
  id: string;
  policyId: string;
  marketId: string;
  actor: string;
  actorType: 'agent' | 'dao' | 'admin';
  riskScore: number | null;
  actionType: string;
  oldValue: string | null;
  newValue: string | null;
  walrusEvidenceBlobId: string | null;
  evidenceHash: string | null;
  txDigest: string | null;
  isReversed: boolean;
  reversedBy?: string | null;
  reversalTxDigest?: string | null;
  overrideReason?: string | null;
  timestampMs: string;
  createdAt?: string;
}

/** Messages the server pushes to subscribed dashboards. */
export type ServerMessage =
  | { type: 'risk_update'; marketId: string; snapshot: RiskSnapshot }
  | { type: 'action_executed'; marketId: string; action: ActionRecord }
  | { type: 'guardian_revoked'; marketId: string; at: string }
  | { type: 'override_applied'; marketId: string; action: ActionRecord }
  | { type: 'stale_data'; marketId: string }
  | { type: 'env_check_failed'; checkType: string; detail: string };

/** The discriminant strings of every {@link ServerMessage} variant. */
export type ServerMessageType = ServerMessage['type'];

/** Messages a client sends to manage its per-market subscriptions. */
export type ClientMessage =
  | { type: 'subscribe'; marketId: string }
  | { type: 'unsubscribe'; marketId: string };

/**
 * The market a {@link ServerMessage} targets, or `null` when the message is a
 * broadcast (currently only `env_check_failed`). Centralising this keeps the
 * routing logic in {@link SubscriptionRegistry} from re-listing the variants.
 */
export function targetMarketId(message: ServerMessage): string | null {
  return message.type === 'env_check_failed' ? null : message.marketId;
}

/**
 * Narrow an unknown value (e.g. a parsed JSON frame from a socket) to a valid
 * {@link ClientMessage}. Returns `null` for anything that is not a well-formed
 * subscribe/unsubscribe with a non-empty string `marketId`, so the transport
 * can ignore malformed frames without throwing.
 */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { type?: unknown; marketId?: unknown };
  if (candidate.type !== 'subscribe' && candidate.type !== 'unsubscribe') {
    return null;
  }
  if (typeof candidate.marketId !== 'string' || candidate.marketId.trim() === '') {
    return null;
  }
  return { type: candidate.type, marketId: candidate.marketId };
}
