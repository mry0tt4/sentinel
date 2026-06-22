/**
 * Unit tests for action priority ordering (task 11.6). Example-based; the
 * dedicated property test is task 11.7 (design Property 15).
 *
 * Covers Req 7.1, 7.2, 7.10: pause-new-borrows is priority zero and wins over
 * all others; the ordering is reduce_max_ltv > enter_guarded_mode >
 * increase_maintenance_margin; empty input yields null; single input returns
 * itself; duplicates are handled; and sorting produces priority order.
 */

import { describe, it, expect } from 'vitest';

import {
  ACTION_PRIORITY_ORDER,
  actionPriority,
  selectHighestPriorityAction,
  orderActionsByPriority,
} from './actionPriority.js';
import { ACTION_PRIORITY, type ActionType } from '../risk/types.js';

const ALL_ACTIONS: ActionType[] = [
  'pause_new_borrows',
  'reduce_max_ltv',
  'enter_guarded_mode',
  'increase_maintenance_margin',
];

describe('ACTION_PRIORITY_ORDER', () => {
  it('places pause_new_borrows at priority zero', () => {
    expect(ACTION_PRIORITY_ORDER.pause_new_borrows).toBe(0);
  });

  it('orders the remaining actions reduce_max_ltv < enter_guarded_mode < increase_maintenance_margin', () => {
    expect(ACTION_PRIORITY_ORDER.reduce_max_ltv).toBe(1);
    expect(ACTION_PRIORITY_ORDER.enter_guarded_mode).toBe(2);
    expect(ACTION_PRIORITY_ORDER.increase_maintenance_margin).toBe(3);
  });

  it('reuses the risk module ACTION_PRIORITY as the single source of truth', () => {
    expect(ACTION_PRIORITY_ORDER).toBe(ACTION_PRIORITY);
  });
});

describe('actionPriority', () => {
  it('returns the canonical priority for each known action', () => {
    expect(actionPriority('pause_new_borrows')).toBe(0);
    expect(actionPriority('reduce_max_ltv')).toBe(1);
    expect(actionPriority('enter_guarded_mode')).toBe(2);
    expect(actionPriority('increase_maintenance_margin')).toBe(3);
  });

  it('sorts an unknown action after all known actions', () => {
    const unknown = 'totally_unknown_action' as unknown as ActionType;
    for (const known of ALL_ACTIONS) {
      expect(actionPriority(known)).toBeLessThan(actionPriority(unknown));
    }
  });
});

describe('selectHighestPriorityAction', () => {
  it('returns null for an empty list', () => {
    expect(selectHighestPriorityAction([])).toBeNull();
  });

  it('returns the single action when only one is recommended', () => {
    for (const action of ALL_ACTIONS) {
      expect(selectHighestPriorityAction([action])).toBe(action);
    }
  });

  it('selects pause_new_borrows over every other action', () => {
    expect(
      selectHighestPriorityAction([
        'increase_maintenance_margin',
        'enter_guarded_mode',
        'reduce_max_ltv',
        'pause_new_borrows',
      ]),
    ).toBe('pause_new_borrows');
  });

  it('selects reduce_max_ltv over guarded mode and margin increase', () => {
    expect(
      selectHighestPriorityAction([
        'increase_maintenance_margin',
        'enter_guarded_mode',
        'reduce_max_ltv',
      ]),
    ).toBe('reduce_max_ltv');
  });

  it('selects enter_guarded_mode over increase_maintenance_margin', () => {
    expect(
      selectHighestPriorityAction(['increase_maintenance_margin', 'enter_guarded_mode']),
    ).toBe('enter_guarded_mode');
  });

  it('handles duplicates and still returns the highest priority', () => {
    expect(
      selectHighestPriorityAction([
        'enter_guarded_mode',
        'enter_guarded_mode',
        'reduce_max_ltv',
        'reduce_max_ltv',
      ]),
    ).toBe('reduce_max_ltv');
  });

  it('ignores unknown actions in favor of a known one', () => {
    const unknown = 'mystery' as unknown as ActionType;
    expect(selectHighestPriorityAction([unknown, 'enter_guarded_mode'])).toBe('enter_guarded_mode');
  });
});

describe('orderActionsByPriority', () => {
  it('orders a full, shuffled set from highest to lowest priority', () => {
    expect(
      orderActionsByPriority([
        'increase_maintenance_margin',
        'reduce_max_ltv',
        'pause_new_borrows',
        'enter_guarded_mode',
      ]),
    ).toEqual([
      'pause_new_borrows',
      'reduce_max_ltv',
      'enter_guarded_mode',
      'increase_maintenance_margin',
    ]);
  });

  it('preserves duplicates and does not mutate the input', () => {
    const input: ActionType[] = ['enter_guarded_mode', 'pause_new_borrows', 'enter_guarded_mode'];
    const result = orderActionsByPriority(input);
    expect(result).toEqual(['pause_new_borrows', 'enter_guarded_mode', 'enter_guarded_mode']);
    expect(input).toEqual(['enter_guarded_mode', 'pause_new_borrows', 'enter_guarded_mode']);
  });

  it('returns an empty array for empty input', () => {
    expect(orderActionsByPriority([])).toEqual([]);
  });

  it('places unknown actions last', () => {
    const unknown = 'mystery' as unknown as ActionType;
    expect(orderActionsByPriority([unknown, 'pause_new_borrows'])).toEqual([
      'pause_new_borrows',
      unknown,
    ]);
  });
});
