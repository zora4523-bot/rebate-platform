import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  ReceivedEvent,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createClaimResultMessageHandler,
  type ClaimResultMessagePayload,
} from '../../../../apps/api/src/modules/notification/application/claim-result-message.ts';
import { seedAmounts, seedClaim, seedItem, seedOrder, seedUser } from '../trade-read-ports/kit.ts';
import { failInsert } from '../risk-state-message/db-kit.ts';

export { failInsert };

// Only *.int.test.ts imports the database factory and passes it into this kit.
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export async function openSuite(createTestDatabase: () => Promise<TestDatabase>) {
  const database = await createTestDatabase();
  // Keep bigint fixture values intact; this suite does not need query-node JSON recording.
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  return {
    db,
    async close() {
      try {
        await destroyDb(db);
      } finally {
        await database.drop();
      }
    },
  };
}
export type Suite = Awaited<ReturnType<typeof openSuite>>;

export const NOW = '2026-10-23T15:04:05.006Z';
export const CONSUMER = 'notification-claim-result';
export const QUEUE = 'evt.notification-claim-result';

export function job(event: ReceivedEvent): ReceivedJob {
  return {
    id: event.eventId,
    queue: QUEUE,
    name: event.name,
    attempt: event.attempt,
    payload: {
      app_id: event.appId,
      v: event.version,
      occurred_at: event.occurredAt,
      data: event.payload,
    },
  };
}

export async function fixture(suite: Suite, status = 'approved') {
  const db = suite.db;
  const appId = `claim-message-${randomUUID()}`;
  const claim = await seedClaim(db, appId, { status });
  const clock = new FixedClock(NOW);
  const otherUser = await seedUser(db, appId);
  return {
    db,
    appId,
    claim,
    clock,
    otherUser,
    userId: claim.user_id,
    event(extra: Partial<ClaimResultMessagePayload> = {}): ReceivedEvent {
      return {
        eventId: randomUUID(),
        appId,
        name: 'claim.resolved',
        version: 1,
        occurredAt: '2026-10-20T03:04:05.000Z',
        consumer: CONSUMER,
        attempt: 1,
        payload: { app_id: appId, claim_id: claim.id, user_id: claim.user_id, status, ...extra },
      };
    },
    // SUT construction belongs in each test body so NotImplemented is an individual red result.
    async deliver(event: ReceivedEvent, connection: Kysely<DB> = db) {
      const handler = createClaimResultMessageHandler({ clock });
      await connection.transaction().execute((trx) => handler(event, trx));
    },
    async item(
      amount: bigint,
      decision: 'approved' | 'rejected' | 'cancelled' | null = 'approved',
      reason = 'NO_EVIDENCE',
    ) {
      const order = await seedOrder(db, appId, {
        user_id: otherUser,
        buy_type: 'self',
        commission_version: 2,
      });
      const item = await seedItem(db, claim, {
        order_id: order.order_id,
        sub_order_id: order.sub_order_id,
        decision,
        reject_reason: decision === 'rejected' ? reason : null,
        decided_at: decision === null ? null : clock.now(),
      });
      await seedAmounts(db, order, 1, [
        { user_id: claim.user_id, role: 'self', amount_fen: 999999n },
      ]);
      await seedAmounts(db, order, 2, [
        { user_id: claim.user_id, role: 'self', amount_fen: amount },
        { user_id: otherUser, role: 'direct', amount_fen: 888888n },
      ]);
      return { order, item };
    },
    async rows() {
      return {
        inbox: await db
          .selectFrom('inbox_messages')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('message_id')
          .execute(),
        logs: await db
          .selectFrom('notify_logs')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
      };
    },
    async template(variant: string, overrides: Partial<Insertable<DB['notify_templates']>> = {}) {
      await db
        .insertInto('notify_templates')
        .values({
          app_id: appId,
          code: 'CLAIM_RESULT',
          variant,
          category: 'service',
          channels: ['inbox'],
          route: null,
          title_override: null,
          body_override: null,
          ...overrides,
        })
        .execute();
    },
    async log(event: ReceivedEvent) {
      await db
        .insertInto('notify_logs')
        .values({
          id: randomUUID(),
          app_id: appId,
          user_id: claim.user_id,
          code: 'CLAIM_RESULT',
          channel: 'inbox',
          dedupe_key: `claim.resolved:${event.eventId}`,
          status: 'success',
          planned_at: clock.now(),
          sent_at: clock.now(),
        })
        .execute();
    },
  };
}
