// BR-WDR-30 自动判定 worker（领域事件 withdrawal.created 消费者）: the real AppModule registers the
// consumer's queue evt.payout-auto-payout on the worker entry only (as B2-05e's went-negative
// consumer, AC-B2-05e#43); assembling runs no statement and sends nothing. Unit test: a Kysely
// handle on Kysely's DummyDriver, no database, no port.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { assembled } from '../../notification/risk-state-message/worker-kit.ts';

it('[AC-B2-11c#80] 真 AppModule 仅在 worker 入口注册一个 evt.payout-auto-payout 处理器，装配不查库、不发消息', async () => {
  const queries: string[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(query) {
      queries.push(query.query.sql);
    },
  });
  const seen: Record<string, number> = {};
  try {
    for (const entry of ['api', 'stream', 'admin', 'payout', 'worker']) {
      const app = await assembled(entry, db, new FixedClock('2026-10-19T02:00:00.000Z'));
      try {
        const registrations = app.registrations.filter(
          (registration) => registration.name === 'evt.payout-auto-payout',
        );
        seen[entry] = registrations.length;
        for (const registration of registrations) {
          expect(registration.handler).toBeTypeOf('function');
        }
        expect(app.sends).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  } finally {
    await db.destroy();
  }
  expect(seen).toEqual({ api: 0, stream: 0, admin: 0, payout: 0, worker: 1 });
  expect(queries).toEqual([]);
});
