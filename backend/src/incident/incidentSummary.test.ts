import { describe, expect, it } from 'vitest';

import { createIncidentSummarizer, renderTemplateSummary, type IncidentSummaryInput } from './incidentSummary.js';

const input: IncidentSummaryInput = {
  marketName: 'SUI Lending Market (Demo)',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:05:00.000Z',
  summary: 'Volatility spike.',
  actions: [
    {
      actionType: 'pause_new_borrows',
      actorType: 'agent',
      oldValue: 'borrows=open',
      newValue: 'borrows=paused',
      riskScore: 92,
      txDigest: 'DIGEST1',
      overrideReason: null,
      timestampMs: 1,
    },
    {
      actionType: 'unpause_market',
      actorType: 'dao',
      oldValue: 'borrows=paused',
      newValue: 'borrows=open',
      riskScore: 38,
      txDigest: 'DIGEST2',
      overrideReason: 'Volatility recovered',
      timestampMs: 2,
    },
  ],
};

describe('renderTemplateSummary', () => {
  it('names the market, counts actions, and stays advisory', () => {
    const text = renderTemplateSummary(input);
    expect(text).toContain('SUI Lending Market (Demo)');
    expect(text).toContain('autonomous agent pause_new_borrows');
    expect(text).toContain('DAO governor unpause_market');
    expect(text.toLowerCase()).toContain('advisory');
  });
});

describe('createIncidentSummarizer', () => {
  it('uses the template when no LLM is configured', async () => {
    const s = createIncidentSummarizer();
    const text = await s.summarize(input);
    expect(text).toContain('SUI Lending Market (Demo)');
  });

  it('delegates to the LLM when present and falls back on failure', async () => {
    const ok = createIncidentSummarizer({ complete: async () => 'LLM report.' });
    expect(await ok.summarize(input)).toBe('LLM report.');

    const bad = createIncidentSummarizer({
      complete: async () => {
        throw new Error('model down');
      },
    });
    expect(await bad.summarize(input)).toContain('SUI Lending Market (Demo)');
  });
});
