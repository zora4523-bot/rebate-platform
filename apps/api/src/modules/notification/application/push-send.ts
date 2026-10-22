// B1-12o: the push sending core (BR-WATCH-15, BR-WATCH-19 ③, BR-TEXT-09, BR-ID-07 细则「发送前校验」,
// BR-ID-10 细则「推送点击的落点」). Two steps, and only the second ever touches the channel:
//
// record(transaction, input) — on the caller's transaction, no external call (外部写先落单):
//   The inbox notify_logs row (dedupe_key = eventKey, status success) is the dedupe boundary,
//   inserted ON CONFLICT (app_id, dedupe_key) DO NOTHING; a duplicate event writes nothing more.
//   Otherwise the inbox message is always written (BR-WATCH-15), its message_id reusing the inbox
//   log's id (so the message is found again from the event key alone), and the push log
//   (dedupe_key = eventKey + ':push', row_version 0, sent_at empty) is written queued, or
//   suppressed(push_disabled) when the recipient's switch for the category is off right now.
//
// dispatch(db, event) — the one and only function that calls the push channel (first send, retry
// and resume of a recorded event all go through it). It takes the root handle only, refuses a
// transaction handle, and runs two short READ COMMITTED transactions of its own:
//   A. Decide and claim: SELECT the push log FOR UPDATE; anything but queued with row_version 0
//      (attempted, result unknown, or finished) → 'skipped' (结果未知只查询、不重发). Under that row
//      lock the category (notify_templates of app/code/variant, else the caller's registry
//      category) and the recipient's current switch (notification_settings; no row = on) are read
//      again: off → suppressed(push_disabled), no call. On → the recipient's push_tokens rows are
//      locked FOR UPDATE in id order (the token report's order) and checked (not revoked, not
//      frozen at the Clock's now, bound to a session identity reports valid); failing bound rows
//      are unbound with the (user_id, bound_sid) read here (conditional command). No usable row →
//      failed (never suppressed). Otherwise claim: row_version 0 → 1 WHERE status queued AND
//      row_version 0, and commit. A failure before this commit leaves the log untouched (queued,
//      row_version 0) for a later dispatch; a concurrent twin waits on the log lock, then skips.
//   B. Deliver: switch and token rows are locked and re-checked the same way once more (anything
//      committed since A counts: off → suppressed, no usable row → failed); the channel gets only
//      the rows still valid, while their locks are held, with payload exactly
//      { message_id, title, body } (no route, no business parameters). accepted → success +
//      sent_at; rejected → failed. A channel error leaves the log queued, row_version 1 (result
//      unknown, never sent again). The result write runs under a savepoint: if it fails it alone
//      is undone (queued, row_version 1) and the unbinds still commit.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7, type Clock } from '../../platform/index.ts';
import type { PushDeliveryChannel, PushPayload, PushTarget } from '../ports/push-delivery.ts';
import { unbindPushTokensForSession } from './session-bindings.ts';

export type PushCategory = 'service' | 'subscription' | 'marketing';

export interface PushSendInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly code: string;
  readonly variant: string;
  readonly eventKey: string;
  readonly title: string;
  readonly body: string;
  readonly route: Readonly<Record<string, unknown>> | null;
  /** Code registry fallback, used only when this app/code/variant has no template row. */
  readonly category: PushCategory;
}

/** Lookup information only; dispatch reads the committed message for its payload. */
export type PushEvent = Pick<
  PushSendInput,
  'app_id' | 'user_id' | 'code' | 'variant' | 'eventKey' | 'category'
>;

export type PushDispatchOutcome =
  /** No push log to act on: unknown event, already attempted, finished, or a twin claimed it. */
  | 'skipped'
  | 'suppressed'
  | 'success'
  | 'failed'
  /** The channel threw, or its result could not be written: queued, row_version 1, never resent. */
  | 'unknown';

export interface PushSendOptions {
  readonly clock: Clock;
  readonly channel: PushDeliveryChannel;
  /** Structural read port; app composition supplies identity's public reader. */
  readonly sessionValidity: (
    executor: Kysely<DB> | Transaction<DB>,
    query: { readonly app_id: string; readonly user_id: string; readonly sids: readonly string[] },
  ) => Promise<ReadonlySet<string>>;
}

export interface PushSendCore {
  /**
   * Caller transaction: dedupe by (app_id,eventKey), insert inbox + successful inbox log and
   * push log (eventKey + ':push', queued, row_version=0; disabled => suppressed(push_disabled)).
   * Never calls the channel. All three writes commit or roll back together.
   */
  record(transaction: Transaction<DB>, input: PushSendInput): Promise<void>;
  /**
   * Root handle only, after record commits; rejects transaction handles. The only path to the
   * channel: call it after record()'s transaction has committed, and again on any retry.
   */
  dispatch(db: Kysely<DB>, event: PushEvent): Promise<PushDispatchOutcome>;
}

const SWITCH_OF = {
  service: 'service_push',
  subscription: 'subscription_push',
  marketing: 'marketing_push',
} as const satisfies Record<PushCategory, string>;

function isCategory(value: string): value is PushCategory {
  return Object.hasOwn(SWITCH_OF, value);
}

const pushKeyOf = (event: Pick<PushEvent, 'eventKey'>) => `${event.eventKey}:push`;

export function createPushSendCore(options: PushSendOptions): PushSendCore {
  const { clock, channel, sessionValidity } = options;

  /** The recipient's current switch for the event's category; no settings row means on. */
  async function pushEnabled(transaction: Transaction<DB>, event: PushEvent): Promise<boolean> {
    const db = transaction.withSchema('app');
    const template = await db
      .selectFrom('notify_templates')
      .select('category')
      .where('app_id', '=', event.app_id)
      .where('code', '=', event.code)
      .where('variant', '=', event.variant)
      .executeTakeFirst();
    const category =
      template !== undefined && isCategory(template.category) ? template.category : event.category;
    const settings = await db
      .selectFrom('notification_settings')
      .select(['service_push', 'subscription_push', 'marketing_push'])
      .where('app_id', '=', event.app_id)
      .where('user_id', '=', event.user_id)
      .executeTakeFirst();
    return settings === undefined ? true : settings[SWITCH_OF[category]];
  }

  async function record(transaction: Transaction<DB>, input: PushSendInput): Promise<void> {
    const db = transaction.withSchema('app');
    const now = clock.now();
    const logged = await db
      .insertInto('notify_logs')
      .values({
        id: newUuidV7(now),
        app_id: input.app_id,
        user_id: input.user_id,
        code: input.code,
        channel: 'inbox',
        dedupe_key: input.eventKey,
        planned_at: now,
        sent_at: now,
        status: 'success',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(['app_id', 'dedupe_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (logged === undefined) return;

    await db
      .insertInto('inbox_messages')
      .values({
        message_id: logged.id,
        app_id: input.app_id,
        user_id: input.user_id,
        code: input.code,
        title: input.title,
        body: input.body,
        // pg would send a JS object as text anyway; jsonb gets its JSON text explicitly.
        route: input.route === null ? null : JSON.stringify(input.route),
        created_at: now,
        updated_at: now,
      })
      .execute();

    const enabled = await pushEnabled(transaction, input);
    await db
      .insertInto('notify_logs')
      .values({
        id: newUuidV7(now),
        app_id: input.app_id,
        user_id: input.user_id,
        code: input.code,
        channel: 'push',
        dedupe_key: pushKeyOf(input),
        planned_at: now,
        sent_at: null,
        status: enabled ? 'queued' : 'suppressed',
        suppress_reason: enabled ? null : 'push_disabled',
        row_version: 0,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(['app_id', 'dedupe_key']).doNothing())
      .execute();
  }

  /** queued (row_version as given) → suppressed(push_disabled); the channel is not called. */
  async function suppress(
    transaction: Transaction<DB>,
    event: PushEvent,
    logId: string,
    rowVersion: number,
  ): Promise<void> {
    const now = clock.now();
    await transaction
      .withSchema('app')
      .updateTable('notify_logs')
      .set((eb) => ({
        status: 'suppressed',
        suppress_reason: 'push_disabled',
        sent_at: null,
        row_version: eb('row_version', '+', 1),
        updated_at: now,
      }))
      .where('app_id', '=', event.app_id)
      .where('id', '=', logId)
      .where('status', '=', 'queued')
      .where('row_version', '=', rowVersion)
      .execute();
  }

  /** queued (row_version as given) → success / failed; sent_at only on success. */
  async function finish(
    transaction: Transaction<DB>,
    event: PushEvent,
    logId: string,
    rowVersion: number,
    status: 'success' | 'failed',
  ): Promise<void> {
    const done = clock.now();
    await transaction
      .withSchema('app')
      .updateTable('notify_logs')
      .set((eb) => ({
        status,
        sent_at: status === 'success' ? done : null,
        row_version: eb('row_version', '+', 1),
        updated_at: done,
      }))
      .where('app_id', '=', event.app_id)
      .where('id', '=', logId)
      .where('status', '=', 'queued')
      .where('row_version', '=', rowVersion)
      .execute();
  }

  type Decision =
    | { readonly kind: 'skipped' | 'suppressed' | 'failed' }
    | { readonly kind: 'claimed'; readonly logId: string; readonly payload: PushPayload };

  /** Step A: lock the push log, re-check switch and tokens, then suppress, fail or claim it. */
  async function decide(transaction: Transaction<DB>, event: PushEvent): Promise<Decision> {
    const db = transaction.withSchema('app');
    const log = await db
      .selectFrom('notify_logs')
      .select(['id', 'status', 'row_version'])
      .where('app_id', '=', event.app_id)
      .where('dedupe_key', '=', pushKeyOf(event))
      .where('channel', '=', 'push')
      .forUpdate()
      .executeTakeFirst();
    if (log === undefined || log.status !== 'queued' || log.row_version !== 0) {
      return { kind: 'skipped' };
    }
    if (!(await pushEnabled(transaction, event))) {
      await suppress(transaction, event, log.id, 0);
      return { kind: 'suppressed' };
    }
    const message = await db
      .selectFrom('inbox_messages as m')
      .innerJoin('notify_logs as l', (join) =>
        join.onRef('l.id', '=', 'm.message_id').onRef('l.app_id', '=', 'm.app_id'),
      )
      .select(['m.message_id', 'm.title', 'm.body'])
      .where('m.app_id', '=', event.app_id)
      .where('l.dedupe_key', '=', event.eventKey)
      .where('l.channel', '=', 'inbox')
      .executeTakeFirst();
    if (message === undefined) return { kind: 'skipped' };
    const targets = await lockAndSelectTargets(transaction, event, clock, sessionValidity);
    if (targets.length === 0) {
      await finish(transaction, event, log.id, 0, 'failed');
      return { kind: 'failed' };
    }
    const claimedAt = clock.now();
    const claimed = await db
      .updateTable('notify_logs')
      .set((eb) => ({ row_version: eb('row_version', '+', 1), updated_at: claimedAt }))
      .where('app_id', '=', event.app_id)
      .where('id', '=', log.id)
      .where('status', '=', 'queued')
      .where('row_version', '=', 0)
      .returning('id')
      .executeTakeFirst();
    if (claimed === undefined) return { kind: 'skipped' };
    return {
      kind: 'claimed',
      logId: log.id,
      payload: { message_id: message.message_id, title: message.title, body: message.body },
    };
  }

  /** Step B: under the token row locks, re-check and call the channel once; write the result. */
  async function deliver(
    transaction: Transaction<DB>,
    event: PushEvent,
    logId: string,
    payload: PushPayload,
  ): Promise<PushDispatchOutcome> {
    if (!(await pushEnabled(transaction, event))) {
      await suppress(transaction, event, logId, 1);
      return 'suppressed';
    }
    const targets = await lockAndSelectTargets(transaction, event, clock, sessionValidity);
    let status: 'success' | 'failed' = 'failed';
    if (targets.length > 0) {
      try {
        const answer = await channel.send(targets, payload, new AbortController().signal);
        status = answer.status === 'accepted' ? 'success' : 'failed';
      } catch {
        // Result unknown: queued, row_version 1, never sent again; the unbinds still commit.
        return 'unknown';
      }
    }
    await sql`SAVEPOINT push_send_result`.execute(transaction);
    try {
      await finish(transaction, event, logId, 1, status);
    } catch {
      // Undo only the result write: the unbinds commit, the log stays queued, row_version 1.
      await sql`ROLLBACK TO SAVEPOINT push_send_result`.execute(transaction);
      return 'unknown';
    }
    await sql`RELEASE SAVEPOINT push_send_result`.execute(transaction);
    return status;
  }

  async function dispatch(db: Kysely<DB>, event: PushEvent): Promise<PushDispatchOutcome> {
    if (db.isTransaction) {
      throw new Error('push dispatch manages its own transactions: pass the root handle');
    }
    const run = <T>(fn: (transaction: Transaction<DB>) => Promise<T>) =>
      db.transaction().setIsolationLevel('read committed').execute(fn);
    const decision = await run((transaction) => decide(transaction, event));
    if (decision.kind !== 'claimed') return decision.kind;
    return run((transaction) => deliver(transaction, event, decision.logId, decision.payload));
  }

  return { record, dispatch };
}

/**
 * BR-ID-07「发送前校验」, under the row locks: the recipient's rows (locked FOR UPDATE in id order)
 * that are not revoked, not frozen at now and bound to a session identity still reports valid.
 * Every other bound row is unbound with the (user_id, bound_sid) read here, unless the same
 * session also carries a row being sent to. The locks are held until the transaction ends.
 */
async function lockAndSelectTargets(
  transaction: Transaction<DB>,
  event: PushEvent,
  clock: Clock,
  sessionValidity: PushSendOptions['sessionValidity'],
): Promise<PushTarget[]> {
  const now = clock.now();
  const rows = await transaction
    .withSchema('app')
    .selectFrom('push_tokens')
    .select(['id', 'user_id', 'bound_sid', 'provider', 'token', 'frozen_until', 'revoked_at'])
    .where('app_id', '=', event.app_id)
    .where('user_id', '=', event.user_id)
    .orderBy('id')
    .forUpdate()
    .execute();
  const candidates = rows.filter(
    (row) =>
      row.bound_sid !== null &&
      row.revoked_at === null &&
      (row.frozen_until === null || row.frozen_until.getTime() <= now.getTime()),
  );
  const candidateSids = [...new Set(candidates.map((row) => row.bound_sid as string))];
  const valid =
    candidateSids.length === 0
      ? new Set<string>()
      : await sessionValidity(transaction, {
          app_id: event.app_id,
          user_id: event.user_id,
          sids: candidateSids,
        });
  const sendable = candidates.filter((row) => valid.has(row.bound_sid as string));
  const keptSids = new Set(sendable.map((row) => row.bound_sid as string));
  const staleSids = new Set<string>();
  for (const row of rows) {
    if (row.bound_sid !== null && !keptSids.has(row.bound_sid)) staleSids.add(row.bound_sid);
  }
  for (const sid of staleSids) {
    await unbindPushTokensForSession(
      transaction,
      { app_id: event.app_id, user_id: event.user_id, sid },
      clock,
    );
  }
  return sendable.map((row) => ({ provider: row.provider, token: row.token }));
}
