import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';
import type { RiskStateService, RiskSubject } from './risk-state.ts';

export interface AppealsOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly riskState: RiskStateService;
  readonly config: RateLimitConfigReader;
  readonly logger: Pick<RootLogger, 'warn'>;
}

export type SubmitAppealResult =
  { readonly code: 0; readonly data: Schema<'Appeal'> } | { readonly code: 20001 };

export interface AppealsService {
  /** The caller supplies the platform idempotency claim transaction. */
  submit(
    trx: Transaction<DB>,
    subject: RiskSubject,
    body: Schema<'SubmitAppealRequest'>,
  ): Promise<SubmitAppealResult>;
  list(
    subject: RiskSubject,
    query: { readonly cursor?: string; readonly limit?: number },
  ): Promise<Schema<'AppealListData'>>;
}

// TODO(规划/11 §3.2): 申诉提交写 audit_logs — blocked on audit_logs 只记后台操作人（规格同步任务）
export function createAppealsService(options: AppealsOptions): AppealsService {
  void options;
  throw new Error('NotImplemented: createAppealsService');
}
