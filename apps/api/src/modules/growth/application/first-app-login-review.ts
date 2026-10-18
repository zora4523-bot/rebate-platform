// BR-INV-09 landing-bind same-device review at the first App login (task B1-11f; orchestrator
// rulings §9, E23, E24). Structurally implements identity's FirstAppLoginReview port: identity
// decides that this login is the account's first App login (no login_logs before it, App platform,
// parent_bind_source landing) and calls review(trx, …) in the login's own transaction, right after
// inserting that first login_logs row. app.module assembles it so identity never imports growth.
//
// review(trx, { app_id, user_id, device_id_hash }), all on the caller's transaction:
//   1. reads the invitee's parent_id / parent_bind_source (a plain read, no row lock): not landing
//      or no parent → nothing (defence in depth; identity already filters);
//   2. reads the inviter's retained login device hashes (identity's port); the invitee's set is
//      this login's device_id_hash alone (BR-INV-09) → no shared device → nothing is written;
//   3. hit: takes the app's relation write lock (lockRelationWrites, held to the end of the
//      caller's transaction), then one conditional UPDATE of users WHERE parent_id is still the
//      parent read in 1 and the source still landing: parent_id, parent_bind_source and
//      parent_bound_at become null (E24), self_bind_used is left as it is (true: no second
//      chance), updated_at = the Clock instant, row_version + 1. 0 rows (a concurrent review or
//      another relation write got there first) → nothing more is written;
//   4. 1 row → appendRelationChange(from = old parent, to = null, source risk_same_device,
//      operator system, at = the same instant) and risk's hit writer (rule inv_09_same_device,
//      dimension device_id_hash, value = this login's device_id_hash), both in the same
//      transaction. Any failure rejects and the caller rolls the whole login back.
// The login itself still succeeds on a hit. Nobody is notified and no job is enqueued (BR-INV-09).
// Nothing is logged here: no device hash or phone ever leaves through a log line.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { appendRelationChange } from '../infra/change-logs.ts';
import { lockRelationWrites } from '../infra/relation-lock.ts';

export interface LandingLoginReviewInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly device_id_hash: string;
}

/** Structurally implements identity's FirstAppLoginReview; identity selects the first App login. */
export interface LandingLoginReview {
  review(trx: Transaction<DB>, input: LandingLoginReviewInput): Promise<void>;
}

/** The app assembler supplies identity's reader and risk's transactional hit writer. */
export interface FirstAppLoginReviewDeps {
  readonly clock: Clock;
  readonly loginDevices: {
    read(
      trx: Transaction<DB>,
      subject: { readonly app_id: string; readonly user_id: string },
    ): Promise<readonly string[]>;
  };
  readonly hitWriter: {
    record(
      trx: Transaction<DB>,
      input: {
        readonly app_id: string;
        readonly user_id: string;
        readonly rule_id: 'inv_09_same_device';
        readonly dimension: 'device_id_hash';
        readonly value_hmac: string;
      },
    ): Promise<void>;
  };
}

/** parent_bind_source of a landing-page binding (BR-INV-09 applies to it only). */
const LANDING = 'landing';
const RULE_ID = 'inv_09_same_device';

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function checkInput(input: LandingLoginReviewInput): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !nonEmpty(input.app_id) ||
    !nonEmpty(input.user_id) ||
    !nonEmpty(input.device_id_hash)
  ) {
    throw new TypeError('growth: malformed first App login review input');
  }
}

export function createFirstAppLoginReview(deps: FirstAppLoginReviewDeps): LandingLoginReview {
  const { clock, loginDevices, hitWriter } = deps;
  return {
    async review(trx, input) {
      checkInput(input);
      const { app_id: appId, user_id: userId, device_id_hash: deviceIdHash } = input;
      const invitee = await trx
        .withSchema('app')
        .selectFrom('users')
        .select(['parent_id', 'parent_bind_source'])
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .executeTakeFirst();
      if (invitee === undefined)
        throw new Error('growth: first App login review subject not found');
      const parentId = invitee.parent_id;
      if (parentId === null || invitee.parent_bind_source !== LANDING) return;

      // BR-INV-08 ③ with the invitee's set = this login's device only (BR-INV-09).
      const inviterHashes = await loginDevices.read(trx, { app_id: appId, user_id: parentId });
      if (!inviterHashes.includes(deviceIdHash)) return;

      const at = clock.now();
      // The app's relation write lock first, as every parent_id write (B1-11d); under READ
      // COMMITTED the conditional update below then sees whatever the previous holder committed.
      await lockRelationWrites(trx, appId);
      const updated = await trx
        .withSchema('app')
        .updateTable('users')
        .set({
          parent_id: null,
          parent_bind_source: null,
          parent_bound_at: null,
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .where('parent_id', '=', parentId)
        .where('parent_bind_source', '=', LANDING)
        .executeTakeFirst();
      // The relation already changed since the read (a concurrent review, a re-parenting): the
      // stale hit decides nothing and leaves no trace.
      if (updated.numUpdatedRows === 0n) return;
      await appendRelationChange(trx, {
        app_id: appId,
        user_id: userId,
        from_parent_id: parentId,
        to_parent_id: null,
        source: 'risk_same_device',
        operator: 'system',
        reason: null,
        at,
      });
      await hitWriter.record(trx, {
        app_id: appId,
        user_id: userId,
        rule_id: RULE_ID,
        dimension: 'device_id_hash',
        value_hmac: deviceIdHash,
      });
    },
  };
}
