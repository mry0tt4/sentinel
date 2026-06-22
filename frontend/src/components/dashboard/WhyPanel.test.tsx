import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { DeterministicRuleOutput } from '../../lib/dashboardTypes';
import { WhyPanel } from './WhyPanel';

const RULES: DeterministicRuleOutput[] = [
  { rule: 'volatility_spike', fired: true, value: '22%' },
  { rule: 'oracle_staleness', fired: false, value: '120 ms' },
];

/**
 * Component tests for the "Why did this happen?" panel content: the most recent
 * AI explanation plus the deterministic rule outputs. (Req 3.8)
 */
describe('WhyPanel', () => {
  it('keeps the body collapsed until opened', () => {
    render(
      <WhyPanel
        open={false}
        onToggle={() => {}}
        explanation="Volatility is rising."
        ruleOutputs={RULES}
      />,
    );

    expect(screen.getByTestId('why-panel-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('why-panel-body')).not.toBeInTheDocument();
  });

  it('shows the AI explanation and deterministic rule outputs when open (Req 3.8)', () => {
    render(
      <WhyPanel
        open
        onToggle={() => {}}
        explanation="Volatility is rising on the SUI feed."
        ruleOutputs={RULES}
      />,
    );

    expect(screen.getByTestId('why-panel-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('why-panel-explanation')).toHaveTextContent(
      'Volatility is rising on the SUI feed.',
    );

    // Both rule outputs render with their name, fired status, and value.
    const fired = screen.getByTestId('why-panel-rule-volatility_spike');
    expect(fired).toHaveTextContent('volatility_spike');
    expect(fired).toHaveTextContent('FIRED');
    expect(fired).toHaveTextContent('22%');

    const ok = screen.getByTestId('why-panel-rule-oracle_staleness');
    expect(ok).toHaveTextContent('oracle_staleness');
    expect(ok).toHaveTextContent('ok');
    expect(ok).toHaveTextContent('120 ms');
  });

  it('falls back to placeholder copy when no explanation is provided', () => {
    render(<WhyPanel open onToggle={() => {}} explanation={null} ruleOutputs={RULES} />);
    expect(screen.getByTestId('why-panel-explanation')).toHaveTextContent(
      'No explanation available yet.',
    );
  });

  it('shows an empty state when there are no rule outputs', () => {
    render(<WhyPanel open onToggle={() => {}} explanation="Quiet market." ruleOutputs={[]} />);
    expect(screen.getByTestId('why-panel-rules-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('why-panel-rules')).not.toBeInTheDocument();
  });

  it('invokes onToggle when the disclosure button is clicked', async () => {
    const onToggle = vi.fn();
    render(<WhyPanel open={false} onToggle={onToggle} explanation="x" ruleOutputs={RULES} />);

    await userEvent.click(screen.getByTestId('why-panel-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
