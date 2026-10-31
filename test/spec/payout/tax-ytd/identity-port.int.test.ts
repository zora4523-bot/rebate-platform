// B2-08b (编排裁定 D10-181 ①, D10-459; task §9.2 4, §9.3 端口): identity's read-only port
// realname-identity-key. readIdentityKey(executor, { appId, userId }) returns the id_no_hmac of the
// member's verified app.realname row; null for no row, status 'none' (also when the cleared row keeps
// its hmac for tax), 'failed', another app's member or an unknown member. It reads on the executor
// it is given (a transaction's uncommitted correction is visible to it) and writes nothing.
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRealnameIdentityKeyReader } from '../../../../apps/api/src/modules/identity/ports/realname-identity-key.ts';
import {
  TIMEOUT,
  closeDb,
  openDb,
  randomHmac,
  seedMember,
  seedRealname,
  type DbHarness,
} from './kit.ts';

let h: DbHarness;
beforeAll(async () => {
  h = await openDb(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await closeDb(h);
}, TIMEOUT);

function appId(): string {
  return `taxid_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/** The realname rows of the app as they are (to show the port changed nothing). */
async function realnameRows(app: string) {
  return h.observer
    .withSchema('app')
    .selectFrom('realname')
    .selectAll()
    .where('app_id', '=', app)
    .orderBy('user_id')
    .execute();
}

it('[AC-B2-08b#port] 已实名（verified）→ 返回该行的 id_no_hmac；同一 app 两个会员各得各的，不改任何行', async () => {
  const reader = createRealnameIdentityKeyReader();
  const app = appId();
  const first = await seedMember(h.db, app);
  const second = await seedMember(h.db, app);
  const firstHmac = randomHmac();
  const secondHmac = randomHmac();
  await seedRealname(h.db, app, first, { status: 'verified', hmac: firstHmac });
  await seedRealname(h.db, app, second, { status: 'verified', hmac: secondHmac });
  const before = await realnameRows(app);

  expect(await reader.readIdentityKey(h.db, { appId: app, userId: first })).toBe(firstHmac);
  expect(await reader.readIdentityKey(h.db, { appId: app, userId: second })).toBe(secondHmac);
  expect(await realnameRows(app)).toEqual(before);
});

it('[AC-B2-08b#port] 未实名 → null：没有 realname 行、status=none、status=failed，以及 none 但为个税留存了 hmac（tax_retained）', async () => {
  const reader = createRealnameIdentityKeyReader();
  const app = appId();
  const noRow = await seedMember(h.db, app);
  const none = await seedMember(h.db, app);
  const failed = await seedMember(h.db, app);
  const retained = await seedMember(h.db, app);
  await seedRealname(h.db, app, none, { status: 'none' });
  await seedRealname(h.db, app, failed, { status: 'failed' });
  await seedRealname(h.db, app, retained, { status: 'none', retainedHmac: randomHmac() });

  for (const userId of [noRow, none, failed, retained]) {
    expect(await reader.readIdentityKey(h.db, { appId: app, userId }), userId).toBeNull();
  }
});

it('[AC-B2-08b#port] 按 (app_id, user_id) 取：别的 app 的同一 user_id 查不到、不存在的会员 → null', async () => {
  const reader = createRealnameIdentityKeyReader();
  const app = appId();
  const other = appId();
  const userId = await seedMember(h.db, app);
  await seedRealname(h.db, app, userId, { status: 'verified', hmac: randomHmac() });

  expect(await reader.readIdentityKey(h.db, { appId: other, userId })).toBeNull();
  expect(await reader.readIdentityKey(h.db, { appId: app, userId: randomUUID() })).toBeNull();
});

it('[AC-B2-08b#port] 在调用方给的事务上读：同一事务里尚未提交的实名更正（新 hmac）当场可见，回滚后仍是旧 hmac', async () => {
  const reader = createRealnameIdentityKeyReader();
  const app = appId();
  const userId = await seedMember(h.db, app);
  const oldHmac = randomHmac();
  const newHmac = randomHmac();
  await seedRealname(h.db, app, userId, { status: 'verified', hmac: oldHmac });

  const rollback = new Error('rollback on purpose');
  let seen: string | null = null;
  await expect(
    h.db.transaction().execute(async (trx) => {
      await sql`UPDATE app.realname SET id_no_hmac = ${newHmac}
        WHERE app_id = ${app} AND user_id = ${userId}`.execute(trx);
      seen = await reader.readIdentityKey(trx, { appId: app, userId });
      throw rollback;
    }),
  ).rejects.toBe(rollback);

  expect(seen).toBe(newHmac);
  expect(await reader.readIdentityKey(h.db, { appId: app, userId })).toBe(oldHmac);
});
