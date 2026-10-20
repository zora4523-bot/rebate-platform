import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';

/** F1-02zk: only BR-FUND-19's automatic safe-direction write is exposed. */
export interface SystemSwitchInput {
  readonly appId: string;
  readonly key: 'settle.auto.enabled';
  readonly source: string;
  readonly reason: string;
}

export interface SystemSwitchResult {
  readonly key: 'settle.auto.enabled';
  readonly changed: boolean;
  readonly version: number;
  /** Stored JSON before the change; null when no row existed. */
  readonly fromValue: DB['config_items']['value'];
}

export interface SystemSwitchWriter {
  /** Uses the caller's transaction, including the history insert; never alerts here. */
  turnOff(trx: Transaction<DB>, input: SystemSwitchInput): Promise<SystemSwitchResult>;
  /** Caller invokes this only after its transaction commits; unchanged results stay silent. */
  alertCommitted(input: SystemSwitchInput, result: SystemSwitchResult): void;
}

export interface SystemSwitchWriterOptions {
  readonly clock: Clock;
  readonly logger: Pick<Logger, 'warn'>;
}

export function createSystemSwitchWriter(options: SystemSwitchWriterOptions): SystemSwitchWriter {
  void options;
  throw new Error('NotImplemented: createSystemSwitchWriter');
}
