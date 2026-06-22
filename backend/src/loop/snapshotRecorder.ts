/**
 * Durable risk-snapshot recorder for the live {@link RiskControlLoop}.
 *
 * Maps a {@link GuardedRiskEvaluation} to a `risk_snapshots` row and persists it
 * via the repository, so the dashboard's "latest snapshot" read (gauge,
 * indicators, why-panel) reflects live evaluations and a history accumulates for
 * the trend. Implements the loop's {@link RiskSnapshotRecorder} port. (Req 3.3)
 */

import type { RiskSnapshotsRepository } from '../db/repositories/riskSnapshots.js';
import type { Json } from '../db/types.js';
import type { GuardedRiskEvaluation } from '../risk/failClosedRiskEngine.js';

import type { RiskSnapshotRecorder } from './riskControlLoop.js';

/** Build a {@link RiskSnapshotRecorder} backed by the snapshots repository. */
export function createRepositorySnapshotRecorder(
  repo: Pick<RiskSnapshotsRepository, 'create'>,
): RiskSnapshotRecorder {
  return {
    async record(evaluation: GuardedRiskEvaluation, dataSource: 'live' | 'simulated'): Promise<void> {
      await repo.create({
        market_id: evaluation.marketId,
        risk_score: evaluation.riskScore,
        band: evaluation.band,
        classes: [...evaluation.classes],
        confidence: evaluation.confidence,
        // jsonb columns: stringify so node-postgres sends JSON text (it would
        // otherwise serialize a JS array as a Postgres array literal and corrupt
        // the jsonb insert). `classes` above is a real TEXT[] and is left as-is.
        feature_vector: JSON.stringify(evaluation.featureVector) as unknown as Json,
        rule_outputs: JSON.stringify(evaluation.ruleOutputs) as unknown as Json,
        recommended_action: evaluation.recommendedAction,
        refusal_reason: evaluation.refusalReason ?? null,
        model_version: evaluation.modelVersion,
        prompt_config_version: evaluation.promptConfigVersion,
        explanation: evaluation.explanation || null,
        is_simulated: dataSource === 'simulated',
        data_source: dataSource,
      });
    },
  };
}
