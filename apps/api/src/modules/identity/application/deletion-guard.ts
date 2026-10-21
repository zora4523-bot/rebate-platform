// Stage ⑥ (10007, account deletion cooling / processing) of the request decision order (规划/08
// BR-ID-01 判定顺序, BR-ID-27; task B1-15e, orchestrator rulings §9.2). Rule-test skeleton only:
// the implementation, the Nest token, identity.module's provider and app.module's wiring (first in
// RiskModule's beforeRateLimitGuards / beforeRateLimit lists) belong to the implementation round.
//
// Agreed shape (test/spec/identity/deletion-guard/**):
// - deletionStageRefusal(stage): none → null; cooling → { code: 10007, stage: 'cooling' };
//   processing and done → { code: 10007, stage: 'processing' }.
// - createDeletionStageChecks({ db }) → { guard, postMiss }: the guard judges non-idempotent
//   operations on the pooled db, the post-miss check judges idempotent ones on the claim's
//   transaction; both read the stage through createDeletionStageReader, uncached, and refuse with
//   HTTP 403 { code: 10007, msg: '账号注销处理中', data: { stage }, trace_id }.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { IdempotencyPostMissCheck } from '../../platform/index.ts';
import type { MinimumVersionRequest } from '../../risk/index.ts';
import type { DeletionStage } from '../ports/deletion-stage.ts';

export interface DeletionStageChecksOptions {
  /** The pooled database of the guard; null when the process has none (judged routes → 50001). */
  readonly db: Kysely<DB> | null;
}

export interface DeletionStageRefusal {
  readonly code: 10007;
  readonly stage: 'cooling' | 'processing';
}

export interface DeletionStageChecks {
  readonly guard: {
    canActivate(context: {
      switchToHttp(): { getRequest(): MinimumVersionRequest };
    }): Promise<boolean>;
  };
  readonly postMiss: IdempotencyPostMissCheck;
}

/** BR-ID-27: the refusal of one deletion stage, or null when the request goes on. */
export function deletionStageRefusal(stage: DeletionStage): DeletionStageRefusal | null {
  void stage;
  throw new Error('NotImplemented: deletionStageRefusal');
}

/** Contract-driven ⑥; app.module supplies both parts to risk's ordered lists. */
export function createDeletionStageChecks(
  options: DeletionStageChecksOptions,
): DeletionStageChecks {
  void options;
  throw new Error('NotImplemented: createDeletionStageChecks');
}
