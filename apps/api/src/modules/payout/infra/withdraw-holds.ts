// B2-05c: the member's withdraw_holds rows as stored (reason, released_at, hold_until), on the
// caller's handle; whether a hold is in effect is the application's judgement on its Clock
// (holdActive, BR-WDR-05). Read only, this app and this user only, no logging.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type {
  WithdrawActor,
  WithdrawHold,
  WithdrawRulesOptions,
} from '../application/withdraw-rules.ts';

export function createWithdrawHoldsReader(): WithdrawRulesOptions['holds'] {
  return {
    async read(handle: Kysely<DB>, subject: WithdrawActor): Promise<readonly WithdrawHold[]> {
      const rows = await handle
        .withSchema('app')
        .selectFrom('withdraw_holds')
        .select(['reason', 'released_at', 'hold_until'])
        .where('app_id', '=', subject.appId)
        .where('user_id', '=', subject.userId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map((row) => ({
        reason: row.reason as WithdrawHold['reason'],
        released_at: row.released_at,
        hold_until: row.hold_until,
      }));
    },
  };
}
