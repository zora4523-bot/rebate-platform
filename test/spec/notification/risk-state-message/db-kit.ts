import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { PostgresQueryCompiler, type Insertable, type Kysely } from 'kysely';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createRiskStateMessageHandler,
  type RiskStateMessagePayload,
} from '../../../../apps/api/src/modules/notification/application/risk-state-message.ts';
import type { ReceivedEvent } from '../../../../apps/api/src/modules/platform/index.ts';
import { event, NOW, payload } from './fixtures.ts';

// Structural type instead of importing @couli/db/testing: only *.int.test.ts may import it
// (.dependency-cruiser.cjs testcontainers-only-in-int-tests); the int test passes its factory.
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export async function openSuite(createTestDatabase: () => Promise<TestDatabase>) {
  const database = await createTestDatabase();
  const queries: string[] = [];
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  // Observe table access without replacing the real PostgreSQL transaction or constraints.
  const observed = db.withPlugin({
    transformQuery(args) {
      queries.push(JSON.stringify(args.node));
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return {
    db: observed,
    queries,
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

export async function fixture(suite: Suite) {
  const appId = `risk-message-${randomUUID()}`;
  const userId = randomUUID();
  await suite.db
    .insertInto('users')
    .values({
      id: userId,
      app_id: appId,
      nickname: 'fixture',
      avatar: 'fixture',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
    })
    .execute();
  const clock = new FixedClock(NOW);
  return {
    db: suite.db,
    appId,
    userId,
    clock,
    event(extra: Partial<RiskStateMessagePayload> = {}) {
      return event(payload({ app_id: appId, user_id: userId, ...extra }));
    },
    // Create the SUT in the test body, not a setup hook: every case fails on the skeleton.
    async deliver(received: ReceivedEvent) {
      const handler = createRiskStateMessageHandler({ clock });
      await suite.db.transaction().execute((trx) => handler(received, trx));
    },
    async rows(db: Kysely<DB> = suite.db) {
      const inbox = await db
        .selectFrom('inbox_messages')
        .selectAll()
        .where('app_id', '=', appId)
        .execute();
      const logs = await db
        .selectFrom('notify_logs')
        .selectAll()
        .where('app_id', '=', appId)
        .execute();
      return { inbox, logs };
    },
    async template(variant: string, overrides: Partial<Insertable<DB['notify_templates']>> = {}) {
      await suite.db
        .insertInto('notify_templates')
        .values({
          app_id: appId,
          code: 'RISK_STATE_CHANGED',
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
    async log(received: ReceivedEvent) {
      await suite.db
        .insertInto('notify_logs')
        .values({
          id: randomUUID(),
          app_id: appId,
          user_id: userId,
          code: 'RISK_STATE_CHANGED',
          channel: 'inbox',
          dedupe_key: `risk.state_changed:${received.eventId}`,
          planned_at: clock.now(),
          sent_at: clock.now(),
          status: 'success',
        })
        .execute();
    },
  };
}

/** Real database error on either insert, with no DDL or privileged connection. */
export function failInsert(table: 'inbox_messages' | 'notify_logs') {
  let fired = false;
  // Kysely forbids a plugin from changing the node kind (an InsertQueryNode cannot become a
  // RawNode), so the matching insert runs and its result is replaced by PostgreSQL's
  // division-by-zero error (22012): the caller's transaction still fails and rolls back.
  const matched = new Set<unknown>();
  return {
    fired: () => fired,
    plugin: {
      transformQuery(args: Parameters<import('kysely').KyselyPlugin['transformQuery']>[0]) {
        const statement = new PostgresQueryCompiler().compileQuery(args.node, args.queryId).sql;
        // Cover both Kysely inserts and raw SQL/CTE inserts without depending on insert order.
        if (
          new RegExp(`\\binsert\\s+into\\s+(?:"?app"?\\.)?"?${table}"?\\b`, 'i').test(statement)
        ) {
          matched.add(args.queryId);
        }
        return args.node;
      },
      async transformResult(args: Parameters<import('kysely').KyselyPlugin['transformResult']>[0]) {
        if (matched.delete(args.queryId)) {
          fired = true;
          throw Object.assign(new Error('division by zero'), { code: '22012' });
        }
        return args.result;
      },
    },
  };
}
