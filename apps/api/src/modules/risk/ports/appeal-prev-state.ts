// Risk's read port for the withdrawal rules (task B2-05c; BR-WDR-05 / BR-ID-36: an appealing
// member takes the effect of the state before the appeal): prev_risk_state of the member's
// PROCESSING account appeal (target_type account; order and blocked-request appeals carry none),
// the latest when several. On the caller's handle (READ ONLY transactions included): one SELECT,
// no writes, no logging; no such appeal (or another app) → null.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface AppealPrevStateReader {
  read(
    handle: Kysely<DB>,
    subject: { appId: string; userId: string },
  ): Promise<'banned' | 'frozen' | null>;
}

export function createAppealPrevStateReader(): AppealPrevStateReader {
  return {
    async read(handle, subject) {
      const row = await handle
        .withSchema('app')
        .selectFrom('appeals')
        .select('prev_risk_state')
        .where('app_id', '=', subject.appId)
        .where('user_id', '=', subject.userId)
        .where('target_type', '=', 'account')
        .where('status', '=', 'processing')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      const prev = row?.prev_risk_state ?? null;
      if (prev === null) return null;
      // appeals_prev_risk_state_check keeps an account appeal's value to these two.
      if (prev !== 'banned' && prev !== 'frozen') throw new Error('risk: unknown prev_risk_state');
      return prev;
    },
  };
}
