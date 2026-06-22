/**
 * Risk Engine public surface.
 *
 * Re-exports the deterministic scoring engine and its types so other backend
 * modules import from a single entry point. The AI Explanation Service (task
 * 7.5), fail-closed layer (task 7.7), and version registry (task 7.10) will be
 * added here as they land.
 */

export * from './types.js';
export * from './scoringEngine.js';
export * from './aiExplanationService.js';
export * from './deepseekClient.js';
export * from './failClosedRiskEngine.js';
export * from './versionRegistry.js';
