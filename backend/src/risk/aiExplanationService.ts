/**
 * AI Explanation Service (task 7.5).
 *
 * Turns the *already-computed* deterministic outputs (score, band, classes,
 * rule outputs) into a short, human-readable narrative. This service authors
 * the `RiskEvaluation.explanation` only — it has **no authority** over the
 * score, band, classes, recommended action, or confidence, and exposes no API
 * to change them. Its single output is a plain-language string that is
 * hard-guaranteed to be at most {@link MAX_EXPLANATION_CHARS} characters.
 * (Req 6.5, 6.13)
 *
 * Design notes:
 *   - The LLM is wrapped behind an injectable {@link LlmClient} port so no real
 *     network call or API key is needed in tests, and so the LLM can be swapped
 *     or disabled without touching the gating path.
 *   - A deterministic, template-based {@link TemplateExplanationService} is the
 *     default fallback used when no LLM is configured. It keeps the system fully
 *     functional (and the tests reproducible) without any model dependency.
 *   - {@link LlmExplanationService} delegates the narrative to the injected
 *     client but still passes the result through the same hard truncation, so a
 *     misbehaving or verbose model can never breach the 1000-char bound.
 *   - {@link attachExplanation} returns a *new* {@link RiskEvaluation} with the
 *     explanation filled in, copying — never mutating — the deterministic
 *     gating fields.
 */

import type { DeterministicRuleOutput, RiskClass, RiskEvaluation } from './types.js';

/** Maximum number of characters allowed in any explanation. (Req 6.5) */
export const MAX_EXPLANATION_CHARS = 1000;

/**
 * The structured, read-only inputs an explanation is derived from. These mirror
 * the deterministic outputs of the scoring engine. The service receives them by
 * value and cannot feed anything back that would alter a decision. (Req 6.13)
 */
export interface ExplanationInput {
  score: number;
  band: string;
  classes: RiskClass[];
  ruleOutputs: DeterministicRuleOutput[];
}

/**
 * The AI Explanation Service contract (design "Backend Services and
 * Interfaces"). Returns a plain-language explanation of at most
 * {@link MAX_EXPLANATION_CHARS} characters. It deliberately exposes no method to
 * change the score or trigger an action. (Req 6.5, 6.13)
 */
export interface AiExplanationService {
  explain(input: ExplanationInput): Promise<string>;
}

/**
 * Injectable LLM port. A concrete adapter (e.g. an OpenAI/Bedrock client) wraps
 * the real model; tests inject a stub. The port intentionally only knows how to
 * turn a prompt into text — it has no access to the evaluation or any action
 * surface. (Req 6.13)
 */
export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

/**
 * Hard-truncate `text` to at most {@link MAX_EXPLANATION_CHARS} characters,
 * appending a single-character ellipsis (…) when truncation occurs. The result
 * is GUARANTEED to satisfy `result.length <= MAX_EXPLANATION_CHARS` for any
 * input — including non-string, empty, or pathologically long values. (Req 6.5)
 */
export function truncateExplanation(text: unknown, max: number = MAX_EXPLANATION_CHARS): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  // Normalize whitespace so a model returning multi-line output stays compact.
  const normalized = s.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  if (max <= 0) return '';
  if (max === 1) return '…';
  // Reserve one character for the ellipsis.
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

/** Format the list of risk classes into readable prose. */
function describeClasses(classes: RiskClass[]): string {
  const unique = classes.filter((c, i) => classes.indexOf(c) === i);
  if (unique.length === 0) return 'no specific risk class';
  if (unique.length === 1) return unique.join('');
  const last = unique[unique.length - 1] ?? '';
  const head = unique.slice(0, -1);
  if (unique.length === 2) return `${head.join('')} and ${last}`;
  return `${head.join(', ')}, and ${last}`;
}

/** A plain-language summary of which deterministic rules fired. */
function describeFiredRules(ruleOutputs: DeterministicRuleOutput[]): string {
  const fired = ruleOutputs.filter((r) => r.fired);
  if (fired.length === 0) return 'No deterministic rules fired.';
  const parts = fired.map((r) => `${r.rule} (${r.value})`);
  return `Triggered rules: ${parts.join('; ')}.`;
}

/**
 * Default, deterministic explanation service. Builds the narrative from a fixed
 * template over the deterministic outputs — no LLM involved. Produces a stable,
 * non-empty, <=1000-char string for any input. Used as the fallback when no LLM
 * is configured so the system stays functional and tests stay reproducible.
 */
export class TemplateExplanationService implements AiExplanationService {
  async explain(input: ExplanationInput): Promise<string> {
    return truncateExplanation(this.render(input));
  }

  /** Synchronous renderer; exposed for direct testing. */
  render(input: ExplanationInput): string {
    const { score, band, classes, ruleOutputs } = input;
    const classText = describeClasses(classes);
    const rulesText = describeFiredRules(ruleOutputs);
    return (
      `Risk score ${score}/100 places this market in the ${band} band. ` +
      `The assessment identified ${classText}. ` +
      `${rulesText} ` +
      `This explanation is informational only and does not change the computed score or any recommended action.`
    );
  }
}

/**
 * LLM-backed explanation service. Delegates narrative generation to the injected
 * {@link LlmClient}, then passes the result through {@link truncateExplanation}
 * so the 1000-char bound holds regardless of model behaviour. If the client
 * fails or returns an empty/blank string, it falls back to the deterministic
 * template so an explanation is always available. The LLM never sees an action
 * surface and cannot affect the score. (Req 6.5, 6.13)
 */
export class LlmExplanationService implements AiExplanationService {
  private readonly llm: LlmClient;
  private readonly fallback: TemplateExplanationService;

  constructor(llm: LlmClient, fallback: TemplateExplanationService = new TemplateExplanationService()) {
    this.llm = llm;
    this.fallback = fallback;
  }

  async explain(input: ExplanationInput): Promise<string> {
    let raw: string;
    try {
      raw = await this.llm.complete(this.buildPrompt(input));
    } catch {
      // A failing model must never break an evaluation: fall back to template.
      return this.fallback.explain(input);
    }
    const text = truncateExplanation(raw);
    if (text.length === 0) return this.fallback.explain(input);
    return text;
  }

  /** Construct the model prompt from the deterministic outputs. */
  buildPrompt(input: ExplanationInput): string {
    const { score, band, classes, ruleOutputs } = input;
    const firedRules = ruleOutputs
      .filter((r) => r.fired)
      .map((r) => `- ${r.rule}: ${r.value}`)
      .join('\n');
    return [
      'You are a DeFi risk analyst. Write a concise, plain-language explanation',
      `of a market risk assessment in at most ${MAX_EXPLANATION_CHARS} characters.`,
      'Explain only — do not recommend or take any action; the score and action are',
      'already decided by deterministic rules and you cannot change them.',
      '',
      `Risk score: ${score}/100`,
      `Band: ${band}`,
      `Risk classes: ${classes.join(', ') || 'none'}`,
      'Fired deterministic rules:',
      firedRules || '- none',
    ].join('\n');
  }
}

/**
 * Factory selecting the appropriate service. When an {@link LlmClient} is
 * provided, returns an {@link LlmExplanationService}; otherwise returns the
 * deterministic {@link TemplateExplanationService} fallback. (Req 6.5)
 */
export function createAiExplanationService(options: { llm?: LlmClient } = {}): AiExplanationService {
  if (options.llm) return new LlmExplanationService(options.llm);
  return new TemplateExplanationService();
}

/**
 * Return a NEW {@link RiskEvaluation} with `explanation` set to a guaranteed
 * <=1000-char string. All deterministic gating fields (riskScore, band, classes,
 * recommendedAction, refusalReason, confidence) are copied unchanged — this
 * helper never mutates the input and has no path to alter a decision. (Req 6.13)
 */
export function attachExplanation(evaluation: RiskEvaluation, explanation: string): RiskEvaluation {
  return {
    ...evaluation,
    // Defensive copies of array fields so the returned object is independent.
    classes: [...evaluation.classes],
    ruleOutputs: evaluation.ruleOutputs.map((r) => ({ ...r })),
    explanation: truncateExplanation(explanation),
  };
}

/**
 * Convenience: compute and attach an explanation for an evaluation in one step,
 * deriving the explanation input directly from the evaluation's deterministic
 * outputs. Returns a new evaluation; the original is left untouched. (Req 6.5)
 */
export async function explainEvaluation(
  service: AiExplanationService,
  evaluation: RiskEvaluation,
): Promise<RiskEvaluation> {
  const explanation = await service.explain({
    score: evaluation.riskScore,
    band: evaluation.band,
    classes: evaluation.classes,
    ruleOutputs: evaluation.ruleOutputs,
  });
  return attachExplanation(evaluation, explanation);
}
