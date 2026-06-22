/**
 * Unit tests for guardian-revocation messaging (Req 12.3, 12.4).
 *
 * These pin the EXACT user-facing string the frontend must display when an
 * autonomous action is rejected due to revocation, and verify the rejection is
 * detected from each backend signal (a revoked guardian authorization, a
 * fail-closed refusal reason, and an on-chain `EGuardianRevoked` abort).
 */

import { describe, expect, it } from 'vitest';

import {
  GUARDIAN_REVOKED_MESSAGE,
  isRevocationRejection,
  revocationRejectionMessage,
} from './guardianRevocation';

describe('GUARDIAN_REVOKED_MESSAGE', () => {
  it('is the exact required string, verbatim (Req 12.4)', () => {
    expect(GUARDIAN_REVOKED_MESSAGE).toBe('Guardian capability has been revoked.');
  });
});

describe('isRevocationRejection (Req 12.3, 12.4)', () => {
  it('is true when the guardian authorization reports the cap as revoked', () => {
    expect(isRevocationRejection({ blocked: true, guardianRevoked: true })).toBe(true);
  });

  it('is true for the Simulation Lab blockedReason text', () => {
    expect(
      isRevocationRejection({
        blocked: true,
        reason: 'GuardianCap for the Demo_Market is revoked; the guardian is not authorized',
      }),
    ).toBe(true);
  });

  it('is true for the fail-closed refusal reason', () => {
    expect(
      isRevocationRejection({
        reason: 'GuardianCap for the market is revoked; refusing to recommend an autonomous action',
      }),
    ).toBe(true);
  });

  it('is true for an on-chain EGuardianRevoked abort', () => {
    expect(isRevocationRejection({ reason: 'MoveAbort: EGuardianRevoked' })).toBe(true);
  });

  it('is false for an unrelated rejection reason', () => {
    expect(
      isRevocationRejection({ blocked: true, reason: 'simulation reported status "failure"' }),
    ).toBe(false);
  });

  it('is false when there is no revocation signal at all', () => {
    expect(isRevocationRejection({})).toBe(false);
    expect(isRevocationRejection({ blocked: false, guardianRevoked: false, reason: null })).toBe(
      false,
    );
  });
});

describe('revocationRejectionMessage (Req 12.4)', () => {
  it('returns the exact message for a revocation rejection', () => {
    expect(revocationRejectionMessage({ guardianRevoked: true })).toBe(
      'Guardian capability has been revoked.',
    );
    expect(revocationRejectionMessage({ reason: 'MoveAbort: EGuardianRevoked' })).toBe(
      GUARDIAN_REVOKED_MESSAGE,
    );
  });

  it('returns null when the rejection was not caused by revocation', () => {
    expect(revocationRejectionMessage({ blocked: true, reason: 'network error' })).toBeNull();
    expect(revocationRejectionMessage({})).toBeNull();
  });
});
