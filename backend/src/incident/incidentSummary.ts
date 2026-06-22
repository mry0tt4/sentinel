/**
 * AI incident summarizer — a governance-grade natural-language report.
 *
 * This is the AI doing more than *explaining a single score*: given a complete
 * incident timeline (the autonomous + DAO actions, the risk scores at each
 * step, the on-chain tx digests, and any override reasons), it produces a
 * concise report a protocol's governance team can read to understand what
 * happened, why the agent acted, and what was done — purely advisory.
 *
 * The deterministic gating path is untouched: this never decides or triggers an
 * action. It reads the already-recorded, real on-chain history and narrates it.
 * Backed by the injected {@link LlmClient} (DeepSeek when configured), with a
 * deterministic template fallback so it always returns a useful report.
 */

import type { LlmClient } from '../risk/aiExplanationService.js';
import { truncateExplanation } from '../risk/aiExplanationService.js';

/** Maximum length of a generated incident report. */
export const MAX_SUMMARY_CHARS = 1200;

/** One action row in an incident timeline (a subset of the actions table). */
export interface IncidentActionInput {
  actionType: string;
  actorType: string;
  oldValue: string | null;
  newValue: string | null;
  riskScore: number | null;
  txDigest: string | null;
  overrideReason: string | null;
  timestampMs: string | number;
}

/** The incident context handed to the summarizer. */
export interface IncidentSummaryInput {
  marketName: string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  actions: IncidentActionInput[];
}

/** Produces a natural-language incident report. */
export interface IncidentSummarizer {
  summarize(input: IncidentSummaryInput): Promise<string>;
}

function describeAction(a: IncidentActionInput): string {
  const who = a.actorType === 'dao' ? 'DAO governor' : a.actorType === 'agent' ? 'autonomous agent' : a.actorType;
  const change =
    a.oldValue !== null && a.newValue !== null ? ` (${a.oldValue} → ${a.newValue})` : '';
  const score = a.riskScore !== null ? `, risk ${a.riskScore}/100` : '';
  const reason = a.overrideReason ? ` — reason: ${a.overrideReason}` : '';
  return `${who} ${a.actionType}${change}${score}${reason}`;
}

/** Deterministic template report; the always-available fallback. */
export function renderTemplateSummary(input: IncidentSummaryInput): string {
  const lines: string[] = [];
  lines.push(`Incident on ${input.marketName}.`);
  if (input.actions.length === 0) {
    lines.push('No autonomous or governance actions were recorded for this incident.');
  } else {
    lines.push(`${input.actions.length} action(s) recorded:`);
    for (const a of input.actions) lines.push(`• ${describeAction(a)}.`);
  }
  if (input.summary) lines.push(input.summary);
  lines.push('This report is advisory and does not change any on-chain state.');
  return truncateExplanation(lines.join(' '), MAX_SUMMARY_CHARS);
}

function buildPrompt(input: IncidentSummaryInput): string {
  const timeline = input.actions
    .map((a, i) => `${i + 1}. ${describeAction(a)}${a.txDigest ? ` [tx ${a.txDigest}]` : ''}`)
    .join('\n');
  return [
    'You are a DeFi risk governance analyst. Write a concise incident report',
    `(at most ${MAX_SUMMARY_CHARS} characters) for a protocol governance team.`,
    'Summarize what happened, why the autonomous risk agent acted, what bounded',
    'on-chain actions were taken, and any DAO override — then give a brief',
    'forward-looking recommendation. Be factual and do not invent data. This is',
    'advisory only; you cannot change any on-chain state.',
    '',
    `Market: ${input.marketName}`,
    `Window: ${input.startedAt} → ${input.endedAt ?? 'ongoing'}`,
    input.summary ? `Context: ${input.summary}` : '',
    'Action timeline:',
    timeline || '(no actions recorded)',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build an incident summarizer. With an {@link LlmClient} it generates a
 * model-authored report (falling back to the template on any error/empty
 * result); without one it always uses the deterministic template.
 */
export function createIncidentSummarizer(llm?: LlmClient): IncidentSummarizer {
  if (!llm) {
    return { summarize: async (input) => renderTemplateSummary(input) };
  }
  return {
    async summarize(input: IncidentSummaryInput): Promise<string> {
      try {
        const raw = await llm.complete(buildPrompt(input));
        const text = truncateExplanation(raw, MAX_SUMMARY_CHARS);
        return text.length > 0 ? text : renderTemplateSummary(input);
      } catch {
        return renderTemplateSummary(input);
      }
    },
  };
}
