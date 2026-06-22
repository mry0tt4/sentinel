import { describe, expect, it, vi } from 'vitest';

import {
  buildOverrideExecuteBody,
  buildOverridePreview,
  OverrideApiClient,
  OverrideReasonRequiredError,
  type OverrideConsoleMarket,
  type OverrideSubmission,
} from './overrideApi';
import type { BackendResponse } from './dashboardApi';
import type { MarketDetailView, MarketSummary } from './dashboardTypes';

const MARKET: MarketSummary = {
  id: 'market-a',
  onChainId: '0xmarket',
  name: 'SUI Lending',
  status: 'Paused',
  marketType: 'lending',
};

function entry(overrides: Partial<OverrideConsoleMarket> = {}): OverrideConsoleMarket {
  return {
    market: MARKET,
    policy: {
      id: 'policy-a',
      onChainPolicyId: '0xpolicy',
      ownerAddress: '0xowner',
      daoAddress: '0xdaoHolder',
      allowedActions: ['pause_new_borrows', 'reduce_max_ltv'],
      maxLtvDeltaBps: 500,
      maxMarginDeltaBps: 250,
      pauseDurationLimitMs: 3_600_000,
      cooldownMs: 60_000,
      isRevoked: false,
      isPaused: true,
    },
    activeAction: {
      id: 'action-1',
      policyId: 'policy-a',
      marketId: 'market-a',
      actor: '0xagent',
      actorType: 'agent',
      riskScore: 88,
      actionType: 'reduce_max_ltv',
      oldValue: '7000',
      newValue: '6500',
      walrusEvidenceBlobId: 'blob-evidence-1',
      evidenceHash: '0xhash',
      txDigest: 'DIGEST_LATEST',
      isReversed: false,
    },
    riskScoreAtAction: 88,
    evidenceBlobId: 'blob-evidence-1',
    isPaused: true,
    daoOverrideStatus: 'none',
    lastTxDigest: 'DIGEST_LATEST',
    lastTxDigestVerifiedTestnet: true,
    overrideCapHolder: '0xdaoHolder',
    ...overrides,
  };
}

function baseSubmission(): OverrideSubmission {
  return {
    operation: 'reverse_action',
    reason: 'Oracle recovered; reversing the emergency LTV reduction.',
    policyId: 'policy-a',
    marketId: 'market-a',
    daoAddress: '0xdaoHolder',
    actionLogId: 'action-1',
    riskScore: 88,
    originalActionId: 'action-1',
    onChain: {
      policyObjectId: '0xpolicy',
      overrideCapObjectId: '0xcap',
      marketStateObjectId: '0xmarket',
      actionLogObjectId: 'action-1',
    },
  };
}

describe('buildOverridePreview (Req 11.3)', () => {
  it('previews a reversal as inverting the action value', () => {
    const preview = buildOverridePreview('reverse_action', entry());
    expect(preview.label).toBe('Reverse action');
    expect(preview.changes[0]).toMatchObject({ before: '6500', after: '7000' });
    expect(preview.changes.some((c) => c.after === 'Reversed by DAO')).toBe(true);
  });

  it('previews an unpause as restoring borrows', () => {
    const preview = buildOverridePreview('unpause_market', entry());
    expect(preview.changes[0]).toMatchObject({ before: 'Paused', after: 'Active' });
  });

  it('previews update_thresholds with before/after bounds', () => {
    const preview = buildOverridePreview('update_thresholds', entry(), {
      newMaxLtvDeltaBps: 800,
      newMaxMarginDeltaBps: 250,
      newPauseDurationLimitMs: 3_600_000,
      newCooldownMs: 60_000,
      newRiskThresholds: [],
    });
    expect(preview.changes[0]).toMatchObject({ before: '500', after: '800' });
  });
});

describe('buildOverrideExecuteBody (Req 11.6)', () => {
  it('throws when the override reason is empty', () => {
    const submission = { ...baseSubmission(), reason: '   ' };
    expect(() => buildOverrideExecuteBody(submission)).toThrow(OverrideReasonRequiredError);
  });

  it('weaves the reason into the request, record, and action context', () => {
    const body = buildOverrideExecuteBody(baseSubmission());
    expect(body.request.operation).toBe('reverse_action');
    expect(body.request.reason).toContain('Oracle recovered');
    expect(body.record).toMatchObject({
      policyId: 'policy-a',
      marketId: 'market-a',
      daoAddress: '0xdaoHolder',
      originalActionId: 'action-1',
    });
    expect((body.actionContext as { overrideReason: string }).overrideReason).toContain(
      'Oracle recovered',
    );
  });

  it('includes the new bounds for an update_thresholds operation', () => {
    const body = buildOverrideExecuteBody({
      ...baseSubmission(),
      operation: 'update_thresholds',
      thresholds: {
        newMaxLtvDeltaBps: 800,
        newMaxMarginDeltaBps: 250,
        newPauseDurationLimitMs: 3_600_000,
        newCooldownMs: 60_000,
        newRiskThresholds: [40, 60, 75, 90],
      },
    });
    expect(body.request.newMaxLtvDeltaBps).toBe(800);
    expect(body.request.newRiskThresholds).toEqual([40, 60, 75, 90]);
  });
});

describe('OverrideApiClient', () => {
  function jsonResponse(payload: unknown): BackendResponse {
    return { ok: true, status: 200, json: async () => payload };
  }

  it('loadConsole composes the market list + detail reads (Req 11.1, 11.2)', async () => {
    const detail: MarketDetailView = {
      market: MARKET,
      params: entry().policy,
      lastAction: entry().activeAction,
      lastTxDigest: 'DIGEST_LATEST',
      lastTxDigestVerifiedTestnet: true,
      lastWalrusBlobId: 'blob-evidence-1',
      daoOverrideStatus: 'none',
    };
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/api/markets')) return jsonResponse({ markets: [MARKET] });
      return jsonResponse(detail);
    });

    const client = new OverrideApiClient(fetchFn, '');
    const data = await client.loadConsole();

    expect(data.markets).toHaveLength(1);
    const m = data.markets[0]!;
    expect(m.overrideCapHolder).toBe('0xdaoHolder');
    expect(m.riskScoreAtAction).toBe(88);
    expect(m.evidenceBlobId).toBe('blob-evidence-1');
    expect(m.isPaused).toBe(true);
  });

  it('submitOverride posts to /api/actions/override and normalizes the result (Req 11.7)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ result: { success: true, txDigest: 'OVR_DIGEST', blobId: 'blob-2' } }),
    );
    const client = new OverrideApiClient(fetchFn, '');
    const result = await client.submitOverride(baseSubmission());

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/actions/override',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.success).toBe(true);
    expect(result.txDigest).toBe('OVR_DIGEST');
    expect(result.txDigestVerifiedTestnet).toBe(true);
  });
});
