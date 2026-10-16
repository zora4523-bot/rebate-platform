// One-time tip read states (B1-02s; 规划/04 §6.1 GET /v1/me/tips, POST /v1/me/tips/{tip_key}/read,
// DELETE /v1/me/tips/{tip_key}; BR-ATTR-21, BR-INV-03 细则, AC-S1-17). The subject is always the
// token's app_id and user (never a request field); guests never reach here (x-auth login).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { NO_PLATFORM, checkJumpTipBody, tipsData, type TipKey } from '../domain/tips.ts';
import { deleteTipReads, insertTipRead, userTipReads } from '../infra/user-tip-reads.ts';
import type { Schema } from '@couli/contracts-ts';

export interface TipSubject {
  readonly app_id: string;
  readonly user_id: string;
}

export type MarkTipReadResult =
  | { readonly code: 0 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } };

export interface TipsService {
  /** The read states of the subject's tips. */
  read(subject: TipSubject): Promise<Schema<'TipsData'>>;
  /**
   * Marks a tip as read at the Clock instant. jump_tip needs a MarkTipReadRequest body (else
   * 20001 with the failing fields); inviter_before_buy ignores any body and is stored with the
   * empty platform. An existing record keeps its read_at.
   */
  markRead(subject: TipSubject, tipKey: TipKey, body: unknown): Promise<MarkTipReadResult>;
  /** Clears the subject's jump_tip records on every platform («重新显示下单须知»). */
  resetJumpTip(subject: TipSubject): Promise<void>;
}

export function createTipsService(deps: {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}): TipsService {
  const { db, clock } = deps;
  return {
    async read(subject) {
      return tipsData(await userTipReads(db, subject.app_id, subject.user_id));
    },
    async markRead(subject, tipKey, body) {
      let platform: string = NO_PLATFORM;
      if (tipKey === 'jump_tip') {
        const checked = checkJumpTipBody(body);
        if (!checked.ok) return { code: 20001, data: { fields: checked.fields } };
        platform = checked.platform;
      }
      await insertTipRead(db, {
        app_id: subject.app_id,
        user_id: subject.user_id,
        tip_key: tipKey,
        platform,
        at: clock.now(),
      });
      return { code: 0 };
    },
    async resetJumpTip(subject) {
      await deleteTipReads(db, subject.app_id, subject.user_id, 'jump_tip');
    },
  };
}
