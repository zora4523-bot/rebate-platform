import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, EventBus, RedisHandle, RootLogger } from '../../platform/index.ts';
import type { RiskStateService } from './risk-state.ts';

export interface AdminRiskStateCommand {
  readonly appId: string;
  readonly userId: string;
  readonly adminId: string;
  readonly adminUsername: string;
  readonly ip: string | null;
  readonly body: Schema<'AdminUserRiskStateUpdateRequest'>;
}

/** Ports are wired by app.module; risk must not import identity or linking. */
export interface AdminRiskStateOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly events: EventBus;
  readonly riskState: RiskStateService;
  readonly redis?: RedisHandle;
  readonly logger: Pick<RootLogger, 'warn'>;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly revokeSessions: (
    trx: Transaction<DB>,
    input: { readonly app_id: string; readonly user_id: string; readonly reason: 'banned' },
  ) => Promise<readonly string[]>;
  readonly blockForBan: (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userId: string; readonly clock: Clock },
  ) => Promise<void>;
  readonly restoreAfterUnban: AdminRiskStateOptions['blockForBan'];
}

export class AdminRiskState {
  // TODO(规划/11 §4.5): 由通知线订阅 risk.state_changed 发送 RISK_STATE_CHANGED — blocked on 通知线订阅跟进任务
  constructor(options: AdminRiskStateOptions) {
    void options;
    throw new Error('NotImplemented: AdminRiskState');
  }

  apply(command: AdminRiskStateCommand): Promise<Schema<'AdminUserRiskState'>> {
    void command;
    throw new Error('NotImplemented: AdminRiskState.apply');
  }
}
