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

it('[AC-B2-05e#43] 真 AppModule 仅在 worker 注册一个负余额消费者，装配不查库不发消息', async () => {
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
  try {
    for (const entry of ['api', 'stream', 'admin', 'payout', 'worker']) {
      const app = await assembled(entry, db, new FixedClock('2026-10-23T02:00:00.000Z'));
      try {
        const registrations = app.registrations.filter(
          (registration) => registration.name === 'evt.payout-went-negative',
        );
        expect(registrations).toHaveLength(entry === 'worker' ? 1 : 0);
        for (const registration of registrations) {
          expect(registration.handler).toBeTypeOf('function');
        }
        expect(app.sends).not.toHaveBeenCalled();
        expect(queries).toEqual([]);
      } finally {
        await app.close();
      }
    }
  } finally {
    await db.destroy();
  }
});
