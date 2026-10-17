// PATCH /v1/me (04 §6.1; BR-ID-39; task B1-20d): change the current user's nickname.
//
// Order (§9.3 #5, §9.4): trimmed length 1–16 extended grapheme clusters (else 20001 fields) →
// the same as the current nickname answers 0 with no change → the month's 3 successful changes
// used (+08:00 natural month) answers 30415 without a review → content-safety review (anything
// but 'pass' is 20001 reason=nickname_sensitive) → a conditional update of the user's own row
// (losing the race is 30415). Only the default nickname given at account creation is free; every
// successful change counts (§9.4 D30). A success writes one pino info line
// identity_nickname_changed with the old value masked (§9.4 D31).
import type { DB } from '@couli/db';
import { chinaMonth } from '@couli/domain';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { NicknameReviewPort } from '../ports/nickname-review.ts';

export interface UpdateNicknameCommand {
  readonly appId: string;
  readonly userId: string;
  /** The nickname as submitted (untrimmed). */
  readonly nickname: string;
}

export type UpdateNicknameResult =
  | { readonly code: 0 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 20001; readonly data: { readonly reason: 'nickname_sensitive' } }
  | { readonly code: 30415 };

export interface UpdateNicknameOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn'>;
  readonly review: NicknameReviewPort;
}

export interface UpdateNicknameService {
  update(command: UpdateNicknameCommand): Promise<UpdateNicknameResult>;
}

export function createUpdateNicknameService(options: UpdateNicknameOptions): UpdateNicknameService {
  const { clock, logger, review } = options;
  const db = options.db.withSchema('app');
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  const userQuery = (connection: Kysely<DB>, command: UpdateNicknameCommand) =>
    connection
      .selectFrom('users')
      .select(['nickname', 'nickname_change_month', 'nickname_change_count'])
      .where('app_id', '=', command.appId)
      .where('id', '=', command.userId);

  return {
    async update(command) {
      const nickname = command.nickname.trim();
      // Stop at the first excess cluster instead of allocating an array for an arbitrary body.
      let length = 0;
      for (const cluster of segmenter.segment(nickname)) {
        void cluster;
        if (++length > 16) break;
      }
      if (length < 1 || length > 16) {
        return { code: 20001, data: { fields: ['nickname'] } };
      }

      const current = await userQuery(db, command).executeTakeFirstOrThrow();
      if (nickname === current.nickname) return { code: 0 };
      if (
        current.nickname_change_month === chinaMonth(clock.now()) &&
        current.nickname_change_count >= 3
      ) {
        return { code: 30415 };
      }

      // No transaction or row lock spans the external review. The port owns its timeout.
      let verdict;
      try {
        verdict = await review.review({ appId: command.appId, text: nickname });
      } catch {
        // Review errors may echo the submitted text: never log the error object or message.
        verdict = 'unavailable';
      }
      if (verdict !== 'pass') {
        if (verdict !== 'hit') {
          logger.warn(
            { app_id: command.appId, user_id: command.userId },
            'identity_nickname_review_unavailable',
          );
        }
        return { code: 20001, data: { reason: 'nickname_sensitive' } };
      }

      const saved = await db.transaction().execute(async (trx) => {
        const user = await userQuery(trx, command).forUpdate().executeTakeFirstOrThrow();
        if (nickname === user.nickname) return { code: 0 } as const;
        // Read the clock after acquiring the lock: a review / lock wait can cross midnight.
        const now = clock.now();
        const month = chinaMonth(now);
        if (user.nickname_change_month === month && user.nickname_change_count >= 3) {
          return { code: 30415 } as const;
        }
        // D30: all successful user changes count, including changes to/from a default name.
        const changed = await trx
          .updateTable('users')
          .set((eb) => ({
            nickname,
            nickname_change_month: month,
            nickname_change_count:
              user.nickname_change_month === month ? user.nickname_change_count + 1 : 1,
            updated_at: now,
            row_version: eb('row_version', '+', 1),
          }))
          .where('app_id', '=', command.appId)
          .where('id', '=', command.userId)
          .where((eb) =>
            eb.or([
              eb('nickname_change_month', 'is distinct from', month),
              eb('nickname_change_count', '<', 3),
            ]),
          )
          .returning('id')
          .executeTakeFirst();
        if (changed === undefined) return { code: 30415 } as const;
        const first = segmenter.segment(user.nickname)[Symbol.iterator]().next().value?.segment;
        return {
          code: 0,
          change: {
            app_id: command.appId,
            user_id: command.userId,
            old_nickname: `${first ?? ''}***`,
            new_nickname: nickname,
            counted: true,
            month,
          },
        } as const;
      });
      // Log only committed changes, with the actual previous value read under the row lock.
      if ('change' in saved) logger.info(saved.change, 'identity_nickname_changed');
      return { code: saved.code };
    },
  };
}
