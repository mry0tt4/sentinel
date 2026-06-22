// Feature: sentinel-risk-guardian, Property 23: Simulated data is never labeled as live
//
// Validates: Requirements 14.6, 14.7
//
// Property 23 — Simulated data is never labeled as live: for ANY data element
// the Simulation_Lab produces / renders, the element SHALL carry EXACTLY ONE
// label drawn from the fixed four-element set {live oracle data, simulated
// scenario data, real testnet transaction, Walrus evidence} (Req 14.6), AND
// simulated scenario data SHALL NEVER be labeled as live oracle data (Req 14.7).
//
// The property is asserted against the pure label-builder model in
// `simulatorTypes.ts` (the single source of every rendered datum's label), and
// — for a representative sample of the generated data — also against the
// rendered DOM via the `data-source` attribute exposed by `LabeledDatumRow`.

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  DATA_SOURCE_LABELS,
  buildActionOutcomeData,
  buildLabeledData,
  buildLiveOracleData,
  buildSimulatedStepData,
  isDataSourceLabel,
  type LabeledDatum,
  type LiveOracleReading,
  type SimActionOutcome,
  type SimStepOutcome,
} from '../../lib/simulatorTypes';
import { LabeledDatumRow } from './DataSourceBadge';

const NUM_RUNS = 200;

/** The four allowed labels, as a fast set for one-of-four membership checks. */
const ALLOWED_LABELS = new Set<string>(DATA_SOURCE_LABELS);

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Generators for the Simulation_Lab data space.
// ---------------------------------------------------------------------------

/** A finite numeric value (no NaN/Infinity) the formatters render cleanly. */
const finiteNumberArb = fc.double({
  min: -1_000_000,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A short non-empty token used for digests / blob ids / hashes. */
const tokenArb = fc
  .string({ minLength: 1, maxLength: 24 })
  .map((s) => s.replace(/\s/g, '_'))
  .filter((s) => s.length > 0);

/**
 * A simulated feature vector. Includes the recognised simulated feature keys
 * (so `buildSimulatedStepData` actually emits feature data) plus arbitrary
 * extra keys to exercise the "unknown field" path.
 */
const featuresArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    oraclePrice: fc.option(finiteNumberArb, { nil: undefined }),
    oracleConfidence: fc.option(finiteNumberArb, { nil: undefined }),
    realizedVolatilityPct: fc.option(finiteNumberArb, { nil: undefined }),
    liquidityDepth: fc.option(finiteNumberArb, { nil: undefined }),
    spreadBps: fc.option(finiteNumberArb, { nil: undefined }),
    utilization: fc.option(finiteNumberArb, { nil: undefined }),
    exposure: fc.option(finiteNumberArb, { nil: undefined }),
    // An arbitrary unrelated field, never surfaced as its own datum.
    unrelated: fc.option(finiteNumberArb, { nil: undefined }),
  },
  { requiredKeys: [] },
);

/** A simulated scenario step — every datum it yields must be `simulated`. */
const stepArb: fc.Arbitrary<SimStepOutcome> = fc.record({
  scenarioId: tokenArb,
  stepIndex: fc.nat({ max: 20 }),
  stepLabel: tokenArb,
  totalSteps: fc.integer({ min: 1, max: 20 }),
  features: featuresArb,
  risk: fc.record({
    riskScore: fc.integer({ min: 0, max: 100 }),
    band: fc.constantFrom('Normal', 'Warning', 'Guarded', 'ParameterAdjustment', 'EmergencyPause'),
    recommendedAction: fc.option(tokenArb, { nil: null }),
    classes: fc.array(tokenArb, { maxLength: 3 }),
    confidence: fc.integer({ min: 0, max: 100 }),
  }),
  thresholdCrossed: fc.boolean(),
});

/** A genuinely-live oracle reading — the ONLY source of the `live` label. */
const liveOracleArb: fc.Arbitrary<LiveOracleReading> = fc.record({
  price: finiteNumberArb,
  confidence: finiteNumberArb,
  timestampMs: fc.nat(),
});

/** A real-testnet action outcome carrying a tx digest and/or Walrus evidence. */
const actionArb: fc.Arbitrary<SimActionOutcome> = fc.record({
  attempted: fc.boolean(),
  blocked: fc.boolean(),
  success: fc.boolean(),
  txDigest: fc.option(tokenArb, { nil: null }),
  blobId: fc.option(tokenArb, { nil: null }),
  evidenceHash: fc.option(tokenArb, { nil: null }),
});

// ---------------------------------------------------------------------------
// Shared assertions.
// ---------------------------------------------------------------------------

/** Assert a single datum carries exactly one valid, one-of-four label. */
function expectExactlyOneValidLabel(datum: LabeledDatum): void {
  // `source` is a single scalar field — structurally there can be at most one.
  // It must be present and a member of the four-element label set. (Req 14.6)
  expect(isDataSourceLabel(datum.source)).toBe(true);
  expect(ALLOWED_LABELS.has(datum.source)).toBe(true);
}

// ---------------------------------------------------------------------------
// Property 23.
// ---------------------------------------------------------------------------

describe('Property 23: Simulated data is never labeled as live (Req 14.6, 14.7)', () => {
  it('labels every produced datum with exactly one of the four data-source labels', () => {
    fc.assert(
      fc.property(
        fc.option(liveOracleArb, { nil: null }),
        fc.option(stepArb, { nil: null }),
        fc.option(actionArb, { nil: null }),
        (liveOracle, latestStep, action) => {
          const data = buildLabeledData({ liveOracle, latestStep, action });
          for (const datum of data) {
            expectExactlyOneValidLabel(datum);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never labels simulated scenario data as live oracle data', () => {
    fc.assert(
      fc.property(stepArb, (step) => {
        const data = buildSimulatedStepData(step);
        for (const datum of data) {
          // Every simulated datum is labeled `simulated scenario data`...
          expect(datum.source).toBe('simulated scenario data');
          // ...and is therefore never `live oracle data`. (Req 14.7)
          expect(datum.source).not.toBe('live oracle data');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('only ever emits the live label from a genuinely-live oracle reading', () => {
    fc.assert(
      fc.property(
        fc.option(liveOracleArb, { nil: null }),
        stepArb,
        actionArb,
        (liveOracle, step, action) => {
          const stepData = buildSimulatedStepData(step);
          const actionData = buildActionOutcomeData(action);
          const liveData = buildLiveOracleData(liveOracle);

          // No `live oracle data` label originates from simulated or action data.
          expect(stepData.some((d) => d.source === 'live oracle data')).toBe(false);
          expect(actionData.some((d) => d.source === 'live oracle data')).toBe(false);

          // Live data — when present — is the sole bearer of the live label.
          for (const datum of liveData) {
            expect(datum.source).toBe('live oracle data');
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('renders each datum with exactly one one-of-four data-source label in the DOM', () => {
    fc.assert(
      fc.property(
        fc.option(liveOracleArb, { nil: null }),
        fc.option(stepArb, { nil: null }),
        fc.option(actionArb, { nil: null }),
        (liveOracle, latestStep, action) => {
          const data = buildLabeledData({ liveOracle, latestStep, action });

          const { container, unmount } = render(
            <>
              {data.map((datum) => (
                <LabeledDatumRow key={datum.key} datum={datum} />
              ))}
            </>,
          );

          try {
            const rendered = container.querySelectorAll('[data-source]');
            // Every element exposing a label exposes a single, valid one.
            rendered.forEach((el) => {
              const label = el.getAttribute('data-source') ?? '';
              expect(ALLOWED_LABELS.has(label)).toBe(true);
            });

            // Per rendered row, the data-source labels collapse to exactly one
            // distinct value (the row + its badge agree — no dual labeling).
            const rows = container.querySelectorAll('.labeled-datum');
            expect(rows.length).toBe(data.length);
            rows.forEach((row, i) => {
              const labels = new Set(
                Array.from(row.querySelectorAll('[data-source]')).map(
                  (el) => el.getAttribute('data-source') ?? '',
                ),
              );
              expect(labels.size).toBe(1);
              expect([...labels][0]).toBe(data[i]!.source);
            });

            // A simulated feature datum is never rendered as live. (Req 14.7)
            const simRows = container.querySelectorAll(
              '.labeled-datum[data-source="simulated scenario data"]',
            );
            simRows.forEach((row) => {
              expect(row.getAttribute('data-source')).not.toBe('live oracle data');
            });
          } finally {
            unmount();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
