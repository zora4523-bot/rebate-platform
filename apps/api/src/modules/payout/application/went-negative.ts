import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ReceivedEvent } from '../../platform/index.ts';
import type { WithdrawalCommandsOptions } from './withdrawal-commands.ts';

export interface WentNegativeOptions extends WithdrawalCommandsOptions {
  db: Kysely<DB>;
  logger: { warn(fields: Record<string, unknown>, message: string): void };
}
export interface WentNegativeConsumer {
  /** Own transaction; processed_events claim and business effects commit together. */
  consume(event: ReceivedEvent): Promise<void>;
  /** W9's follow-up job uses the same locked recheck, without event-id deduplication. */
  run(input: { appId: string; userId: string }): Promise<void>;
}
export function createWentNegativeConsumer(options: WentNegativeOptions): WentNegativeConsumer {
  void options;
  throw new Error('NotImplemented: createWentNegativeConsumer');
}
