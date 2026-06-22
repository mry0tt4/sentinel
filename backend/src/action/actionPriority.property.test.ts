// Feature: sentinel-risk-guardian, Property 15: Action priority ordering
//
// *For any* non-empty list of recommended actions for a single market, the
// Action_Engine SHALL select the single highest-priority action first (the one
// with the lowest ACTION_PRIORITY value), and `pause_new_borrows` — priority
// zero — SHALL always win when present.
//
// Validates: Requirements 7.10, 7.1, 7.2
//
// Strategy: generate arbitrary non-empty multisets (duplicates allowed, order
// randomized) drawn from the four canonical ActionTypes. Across every run we
// assert:
//
//  (a) selectHighestPriorityAction returns an action whose priority equals the
//      minimum priority present in the list (highest-priority-first). [7.10]
//  (b) If the list contains 'pause_new_borrows', the result is ALWAYS
//      'pause_new_borrows' (priority zero wins). [7.1, 7.2]
//  (c) orderActionsByPriority yields a non-decreasing priority sequence and is
//      a permutation of the input (same multiset of actions). [7.10]
//  (d) For an empty list, selectHighestPriorityAction returns null. [7.10]

import fc from 'fast-check';

import { describe, expect, it } from 'vitest';

import {
  actionPriority,
  selectHighestPriorityAction,
  orderActionsByPriority,
} from './actionPriority.js';
import type { ActionType } from '../risk/types.js';

const ALL_ACTIONS: readonly ActionType[] = [
  'pause_new_borrows',
  'reduce_max_ltv',
  'enter_guarded_mode',
  'increase_maintenance_margin',
];

/** Arbitrary non-empty list (multiset, order randomized) of ActionTypes. */
const actionListArb: fc.Arbitrary<ActionType[]> = fc.array(
  fc.constantFrom(...ALL_ACTIONS),
  { minLength: 1, maxLength: 12 },
);

/** Count occurrences of each action so we can compare two lists as multisets. */
function multiset(actions: readonly ActionType[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of actions) {
    counts[action] = (counts[action] ?? 0) + 1;
  }
  return counts;
}

describe('Property 15: Action priority ordering (Req 7.10, 7.1, 7.2)', () => {
  it('selects the minimum-priority action, with pause_new_borrows always winning when present', () => {
    fc.assert(
      fc.property(actionListArb, (actions) => {
        const selected = selectHighestPriorityAction(actions);

        // (a) A non-empty list always selects some action.
        expect(selected).not.toBeNull();

        // (a) The selected action's priority equals the minimum present.
        const minPriority = Math.min(...actions.map(actionPriority));
        expect(actionPriority(selected as ActionType)).toBe(minPriority);

        // (b) pause_new_borrows (priority zero) wins whenever present.
        if (actions.includes('pause_new_borrows')) {
          expect(selected).toBe('pause_new_borrows');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('orders actions into a non-decreasing priority sequence that is a permutation of the input', () => {
    fc.assert(
      fc.property(actionListArb, (actions) => {
        const ordered = orderActionsByPriority(actions);

        // (c) Same length and same multiset of actions (a permutation).
        expect(ordered).toHaveLength(actions.length);
        expect(multiset(ordered)).toEqual(multiset(actions));

        // (c) Priorities are non-decreasing across the ordered list.
        const priorities = ordered.map(actionPriority);
        for (let i = 1; i < priorities.length; i += 1) {
          expect(priorities[i]).toBeGreaterThanOrEqual(priorities[i - 1]);
        }

        // The first ordered element is exactly the highest-priority selection.
        expect(ordered[0]).toBe(selectHighestPriorityAction(actions));
      }),
      { numRuns: 200 },
    );
  });

  it('returns null for an empty list', () => {
    expect(selectHighestPriorityAction([])).toBeNull();
  });
});
