import { randomBytes } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql } from 'kysely';
import { QUEUE_CATALOG } from '../queue/catalog.ts';
import type { JobPayload, QueueRuntime } from '../queue/types.ts';
import {
  EVENT_NAMES,
  EVENT_SUBSCRIPTIONS,
  EventError,
  type EventBus,
  type EventBusOptions,
  type EventConsumerOptions,
  type PublishResult,
  type ReceivedEvent,
} from './types.ts';
import * as check from './validation.ts';

export function newEventId(now: Date): string {
  check.instant(now);
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.prototype.getTime.call(now), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Per business transaction: the tail of its publishes (one connection, so publishes on it run one
 * after another) and whether its isolation level has been checked.
 */
interface TransactionState {
  tail: Promise<unknown>;
  checked: boolean;
}

const transactions = new WeakMap<object, TransactionState>();

export function createEventBus(options: EventBusOptions): EventBus {
  if (
    !check.keys(options, ['queue', 'clock', 'subscriptions', 'catalog'], ['queue', 'clock']) ||
    !check.object(options.queue) ||
    typeof options.queue.send !== 'function' ||
    !check.object(options.clock) ||
    typeof options.clock.now !== 'function' ||
    (options.catalog !== undefined && !Array.isArray(options.catalog))
  )
    throw new EventError('invalid_option');
  const routes = check.subscriptions(
    options.subscriptions === undefined ? EVENT_SUBSCRIPTIONS : options.subscriptions,
    options.catalog === undefined ? QUEUE_CATALOG : options.catalog,
  );
  const { queue, clock } = options;
  return {
    async publish(trx, event) {
      if (!check.object(trx) || trx.isTransaction !== true) {
        throw new EventError('invalid_transaction');
      }
      if (
        !check.keys(
          event,
          ['appId', 'name', 'payload', 'version', 'eventId'],
          ['appId', 'name', 'payload'],
        )
      )
        throw new EventError('invalid_event');
      if (!check.appId(event.appId)) throw new EventError('invalid_app_id');
      if (!EVENT_NAMES.includes(event.name)) throw new EventError('unknown_event');
      const given = Object.hasOwn(event, 'version') ? event.version : 1;
      if (!check.version(given)) throw new EventError('invalid_version');
      const version: number = given;
      if (Object.hasOwn(event, 'eventId') && !check.uuid(event.eventId)) {
        throw new EventError('invalid_event_id');
      }
      // Snapshot before the first await: callers cannot alter validated data while waiting on a lock.
      const data = JSON.parse(check.payload(event.payload)) as JobPayload;
      const { appId, name } = event;
      const now = clock.now();
      check.instant(now);
      const eventId = event.eventId ?? newEventId(now);
      const occurredAt = Date.prototype.toISOString.call(now);
      const auditPayload = JSON.stringify({ v: version, data });

      let state = transactions.get(trx);
      if (state === undefined) {
        state = { tail: Promise.resolve(), checked: false };
        transactions.set(trx, state);
      }
      const current = state;
      // The advisory lock below is re-entrant within the session, so two publishes on the same
      // transaction would both pass the lookup before either inserts: run them one after another.
      const run = current.tail.then(() => write());
      current.tail = run.catch(() => undefined);
      return run;

      async function write(): Promise<PublishResult> {
        if (!current.checked) {
          // Under REPEATABLE READ or SERIALIZABLE the lookup reads the transaction's snapshot and
          // misses a row committed by a concurrent publish after the lock was granted.
          const { rows } = await sql<{
            level: string;
          }>`select current_setting('transaction_isolation') as level`.execute(trx);
          if (rows[0]?.level !== 'read committed') throw new EventError('invalid_transaction');
          current.checked = true;
        }

        // event_log is partitioned on occurred_at; its index on event_id is not globally unique.
        // The transaction lock spans every partition and lasts until the business transaction ends.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`platform.events:${eventId}`}, 0))`.execute(
          trx,
        );
        const app = trx.withSchema('app');
        const previous = await app
          .selectFrom('event_log')
          .select((eb) =>
            eb
              .and([
                eb('app_id', '=', appId),
                eb('name', '=', name),
                eb('payload', '=', sql<DB['event_log']['payload']>`${auditPayload}::jsonb`),
              ])
              .as('same'),
          )
          .where('event_id', '=', eventId)
          .executeTakeFirst();
        if (previous !== undefined) {
          if (!previous.same) throw new EventError('event_conflict');
          return Object.freeze({ eventId, duplicate: true });
        }
        await app
          .insertInto('event_log')
          .values({
            app_id: appId,
            event_id: eventId,
            name,
            payload: sql`${auditPayload}::jsonb`,
            occurred_at: occurredAt,
          })
          .execute();
        const envelope = { app_id: appId, v: version, occurred_at: occurredAt, data };
        for (const route of routes) {
          if (route.events.includes(name)) {
            await queue.send(`evt.${route.consumer}`, name, envelope, { trx, id: eventId });
          }
        }
        return Object.freeze({ eventId, duplicate: false });
      }
    },
  };
}

export function registerEventConsumer(
  runtime: Pick<QueueRuntime, 'register'>,
  options: EventConsumerOptions,
): void {
  if (
    !check.object(runtime) ||
    typeof runtime.register !== 'function' ||
    !check.keys(
      options,
      ['consumer', 'db', 'logger', 'handler', 'subscriptions'],
      ['consumer', 'db', 'logger', 'handler'],
    ) ||
    typeof options.consumer !== 'string' ||
    !check.object(options.db) ||
    !check.object(options.logger) ||
    typeof options.logger.info !== 'function' ||
    typeof options.handler !== 'function'
  )
    throw new EventError('invalid_option');
  const routes = check.subscriptions(
    options.subscriptions === undefined ? EVENT_SUBSCRIPTIONS : options.subscriptions,
  );
  const { consumer, db, logger, handler } = options;
  const route = routes.find((item) => item.consumer === consumer);
  if (route === undefined) throw new EventError('unknown_consumer');
  runtime.register(`evt.${consumer}`, async (job) => {
    if (!check.object(job) || !check.uuid(job.id) || !route.events.includes(job.name)) {
      throw new EventError('invalid_event');
    }
    const envelope = job.payload;
    if (
      !check.keys(envelope, ['app_id', 'v', 'occurred_at', 'data']) ||
      !check.appId(envelope.app_id) ||
      !check.version(envelope.v) ||
      !check.occurredAt(envelope.occurred_at) ||
      !check.plain(envelope.data)
    )
      throw new EventError('invalid_event');
    const event: ReceivedEvent = Object.freeze({
      eventId: job.id,
      appId: envelope.app_id,
      name: job.name,
      version: envelope.v,
      occurredAt: envelope.occurred_at,
      payload: envelope.data as JobPayload,
      consumer,
      attempt: job.attempt,
    });
    const duplicate = await db.transaction().execute(async (trx) => {
      const inserted = await trx
        .withSchema('app')
        .insertInto('processed_events')
        .values({ consumer, event_id: event.eventId })
        .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (inserted === undefined) return true;
      await handler(event, trx);
      // A handler that caught a database error and returned leaves an aborted transaction, whose
      // commit would silently roll back. Any statement fails there (25P02): the job then fails and
      // is retried, as if the handler had rejected.
      await sql`select 1`.execute(trx);
      return false;
    });
    if (duplicate) {
      logger.info(
        { consumer, eventId: event.eventId, eventName: event.name, attempt: event.attempt },
        'event_duplicate',
      );
    }
  });
}
