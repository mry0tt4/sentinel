/**
 * Action priority ordering (task 11.6).
 *
 * When more than one autonomous mitigation is recommended for a single market,
 * the Action_Engine must act on the *single* most severe action first. This
 * module defines the canonical priority ordering and the pure selection /
 * ordering helpers the engine uses to pick that action.
 *
 * The ordering is fixed and deliberate (Req 7.1, 7.2, 7.10):
 *
 *  - `pause_new_borrows`            → priority **0** (most severe, priority zero)
 *  - `reduce_max_ltv`              → priority 1
 *  - `enter_guarded_mode`          → priority 2
 *  - `increase_maintenance_margin` → priority 3
 *
 * Lower number = higher priority. The mapping is intentionally identical to the
 * risk module's {@link ACTION_PRIORITY} (re-used here, not duplicated) so the
 * recommendation side and the execution side agree on a single source of truth.
 */

import { ACTION_PRIORITY, type ActionType } from '../risk/types.js';

/**
 * Canonical action-priority mapping. Lower = higher priority;
 * `pause_new_borrows` is priority zero. Re-exported from the risk module so the
 * action engine and risk engine share one ordering. (Req 7.10)
 */
export const ACTION_PRIORITY_ORDER: Readonly<Record<ActionType, number>> = ACTION_PRIORITY;

/** The largest defined priority value (used to sort unknown actions last). */
const MAX_KNOWN_PRIORITY = Math.max(...Object.values(ACTION_PRIORITY_ORDER));

/**
 * The priority of an action — lower means higher priority. Known actions map to
 * their canonical priority; any unrecognized value sorts *after* all known
 * actions so it can never displace a real mitigation. (Req 7.10)
 */
export function actionPriority(action: ActionType): number {
  const priority = ACTION_PRIORITY_ORDER[action];
  return typeof priority === 'number' ? priority : MAX_KNOWN_PRIORITY + 1;
}

/**
 * Select the single highest-priority action from a list of recommended actions
 * for one market.
 *
 * Returns the action with the lowest priority number (`pause_new_borrows` wins
 * over everything). Handles the empty list (returns `null`), duplicates, and
 * unknown/extra values gracefully — a known action always wins over an unknown
 * one, and ties resolve to the first occurrence. (Req 7.1, 7.2, 7.10)
 */
export function selectHighestPriorityAction(actions: readonly ActionType[]): ActionType | null {
  if (!Array.isArray(actions) || actions.length === 0) {
    return null;
  }

  let best: ActionType | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;
  for (const action of actions) {
    const priority = actionPriority(action);
    if (priority < bestPriority) {
      best = action;
      bestPriority = priority;
    }
  }
  return best;
}

/**
 * Return a new list of the given actions ordered from highest priority
 * (`pause_new_borrows`) to lowest. Duplicates are preserved; unknown values are
 * placed last. The input array is not mutated. Ordering is stable: equal-priority
 * actions keep their original relative order. (Req 7.10)
 */
export function orderActionsByPriority(actions: readonly ActionType[]): ActionType[] {
  return actions
    .map((action, index) => ({ action, index, priority: actionPriority(action) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.action);
}
