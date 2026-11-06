// B2-12g unit tests (no database): the marker's one statement on the caller's transaction, compiled
// by a dummy PostgreSQL driver. The rule tests (test/spec/risk/bad-debt-linked/**) run it for real.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createBadDebtLinkedMarker } from './bad-debt-linked.ts';

const AT = '2027-02-19T02:30:00.000Z';
const INPUT = {
  appId: 'app_unit',
  sourceUserId: '01900000-0000-7000-8000-00000000000c',
  sourceRef: '01900000-0000-7000-8000-00000000000a',
};

async function capture(): Promise<CompiledQuery[]> {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') queries.push(event.query);
    },
  });
  const marker = createBadDebtLinkedMarker({ clock: new FixedClock(AT) });
  await db.transaction().execute((trx) => marker.mark(trx, INPUT));
  await db.destroy();
  return queries;
}

it('[AC-B2-12g#6] 一条 INSERT … SELECT 写 app.risk_linked_marks，ON CONFLICT (app_id, source_ref, user_id, dimension) DO NOTHING', async () => {
  const queries = await capture();
  const inserts = queries.filter((query) => /insert\s+into/i.test(query.sql));
  expect(inserts).toHaveLength(1);
  const text = inserts[0]!.sql.replace(/\s+/g, ' ');
  expect(text).toMatch(/INSERT INTO app\.risk_linked_marks/);
  expect(text).toMatch(/ON CONFLICT \(app_id, source_ref, user_id, dimension\) DO NOTHING/);
  expect(text).not.toMatch(/devices/);
});

it('[AC-B2-12g#1] 三个维度都按同 app、排除本人取关联账户：同实名 verified、全部会话的设备（不读 devices.user_id）、当前收款账号 HMAC', async () => {
  const [insert] = (await capture()).filter((query) => /insert\s+into/i.test(query.sql));
  const text = insert!.sql.replace(/\s+/g, ' ');
  for (const dimension of ['id_no', 'device', 'payout_account']) {
    expect(text).toContain(`'${dimension}'::text`);
  }
  expect(text).toMatch(/mine\.status = 'verified' AND other\.status = 'verified'/);
  expect(text).toMatch(/FROM app\.sessions mine JOIN app\.sessions other/);
  expect(text).not.toMatch(/revoked_at/);
  expect(text).toMatch(/mine\.is_current AND other\.is_current/);
  expect(text.match(/other\.user_id <> mine\.user_id/g)).toHaveLength(3);
});

it('[AC-B2-12g#6] 参数：app_id、被核销用户、候选单 id 与注入时钟的时刻', async () => {
  const [insert] = (await capture()).filter((query) => /insert\s+into/i.test(query.sql));
  const parameters = insert!.parameters;
  expect(parameters).toContain(INPUT.appId);
  expect(parameters).toContain(INPUT.sourceUserId);
  expect(parameters).toContain(INPUT.sourceRef);
  expect(parameters).toContainEqual(new Date(AT));
});
