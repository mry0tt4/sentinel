/**
 * Decode + classify a raw on-chain event into a typed {@link IndexedEvent}.
 *
 * Events are classified by the suffix of their fully-qualified Move type
 * (e.g. `…::sentinel_policy::GuardianRevoked`), so the indexer is agnostic to
 * the concrete package id. Move field encodings are normalized defensively:
 * `ID`/`address` arrive as `0x…` strings; `vector<u8>` may arrive as a UTF-8
 * string, a byte array, or a base64 string depending on the RPC, so the blob
 * id is decoded to text and the evidence hash to a `0x`-prefixed hex string.
 */

import type {
  EventCursor,
  IndexedEvent,
  RawIndexedEvent,
} from './types.js';

/** Extract the trailing struct name from a fully-qualified Move event type. */
function structName(type: string): string {
  const parts = type.split('::');
  return parts[parts.length - 1] ?? type;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return fallback;
}

/** Coerce a `vector<u8>` field to a byte array, when it is expressed as one. */
function toBytes(value: unknown): number[] | null {
  if (Array.isArray(value) && value.every((b) => typeof b === 'number')) {
    return value as number[];
  }
  return null;
}

/**
 * Decode a `vector<u8>` field to UTF-8 text. Accepts an already-decoded string,
 * a numeric byte array, or returns the empty string for absent values. Used for
 * the Walrus blob id, which is itself textual. (Req 9 linkage)
 */
function decodeUtf8(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const bytes = toBytes(value);
  if (bytes !== null) {
    return Buffer.from(bytes).toString('utf8');
  }
  return '';
}

/**
 * Decode a `vector<u8>` field to a `0x`-prefixed lowercase hex string. Accepts
 * a numeric byte array or passes through an existing string. Used for the
 * evidence hash recorded on-chain.
 */
function decodeHex(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const bytes = toBytes(value);
  if (bytes !== null) {
    return `0x${Buffer.from(bytes).toString('hex')}`;
  }
  return '';
}

/**
 * Classify and decode a raw event. Unknown event types map to an `Unknown`
 * record so the caller can advance the checkpoint without persisting anything.
 */
export function parseEvent(raw: RawIndexedEvent): IndexedEvent {
  const cursor: EventCursor = { txDigest: raw.id.txDigest, eventSeq: raw.id.eventSeq };
  const txDigest = raw.id.txDigest;
  const timestampMs = raw.timestampMs ?? null;
  const json = raw.parsedJson ?? {};

  switch (structName(raw.type)) {
    case 'RiskActionExecuted':
      return {
        kind: 'RiskActionExecuted',
        cursor,
        txDigest,
        timestampMs,
        policyId: asString(json.policy_id),
        marketId: asString(json.market_id),
        actionType: asNumber(json.action_type),
        riskScore: asNumber(json.risk_score),
        oldValue: asString(json.old_value, '0'),
        newValue: asString(json.new_value, '0'),
        evidenceBlobId: decodeUtf8(json.evidence_blob_id),
        evidenceHash: decodeHex(json.evidence_hash),
      };

    case 'RiskActionOverridden':
      return {
        kind: 'RiskActionOverridden',
        cursor,
        txDigest,
        timestampMs,
        policyId: asString(json.policy_id),
        originalActionId: asString(json.original_action_id),
        daoAddress: asString(json.dao_address),
        reason: decodeUtf8(json.reason),
      };

    case 'GuardianRevoked':
      return {
        kind: 'GuardianRevoked',
        cursor,
        txDigest,
        timestampMs,
        policyId: asString(json.policy_id),
        guardianCapId: asString(json.guardian_cap_id),
        daoAddress: asString(json.dao_address),
      };

    case 'PolicyUpdated':
      return {
        kind: 'PolicyUpdated',
        cursor,
        txDigest,
        timestampMs,
        policyId: asString(json.policy_id),
        version: asNumber(json.version),
      };

    default:
      return { kind: 'Unknown', cursor, txDigest, timestampMs, type: raw.type };
  }
}
