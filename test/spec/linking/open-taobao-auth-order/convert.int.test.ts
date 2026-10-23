import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture, failure, fixture, service, type Fixture } from '../convert/kit.ts';
import { addAccount, dropAccounts, expireSite, refused, stateIssued, withoutSlots } from './kit.ts';

// Task B1-22m: POST /v1/links/convert shares the open's Taobao authorization (link-convert.ts →
// composeTaobaoConversion), so the same order holds there: the authorization gate answers before
// the slot of the account in use is read, and no Taobao union account at all is always 50301.
// convert registers the caller's own H5 link (scene h5 → pid_scene self_buy).
const database = databaseFixture(createTestDatabase);

/** The H5 links registered since `before` (convert registers one per new request). */
async function fresh(f: Fixture, before: readonly { link_id: string }[]) {
  const known = new Set(before.map((row) => row.link_id));
  const rows = (await f.links()).filter((row) => !known.has(row.link_id));
  expect(rows).toHaveLength(1);
  return rows[0]!.link_id;
}

it.each([
  ['absent', 30101],
  ['pending_auth', 30101],
  ['released', 30101],
  ['invalid', 30102],
] as const)(
  '[AC-B1-22m#10] convert 本人 %s、所用账号 self_buy 无 active 推广位 → %i 带 auth_url 与 state（绑定新登记的 H5 link）',
  async (status, code) => {
    const f = await fixture(database(), 'taobao', status);
    withoutSlots(f, ['self_buy']);
    const result = await service(f).convert(f.request());
    await failure(result, f, code, 422);
    await stateIssued(result, f, code, f.a, await fresh(f, []));
    expect(await f.sessions()).toHaveLength(1);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
  60_000,
);

it('[AC-B1-22m#11] convert 本人 blocked、所用账号 self_buy 无 active 推广位 → 30153，无授权入口', async () => {
  const f = await fixture(database(), 'taobao', 'blocked');
  withoutSlots(f, ['self_buy']);
  const result = await service(f).convert(f.request());
  await failure(result, f, 30153, 422);
  refused(result, 30153, 422);
  expect(await f.sessions()).toEqual([]);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);

it.each([
  ['absent', 30101],
  ['invalid', 30102],
] as const)(
  '[AC-B1-22m#12] convert 站长授权 expired、本人 %s、所用账号无 active 推广位 → %i auth_unavailable',
  async (status, code) => {
    const f = await fixture(database(), 'taobao', status);
    await expireSite(f);
    withoutSlots(f, ['self_buy']);
    const result = await service(f).convert(f.request());
    await failure(result, f, code, 422);
    refused(result, code, 422, { reason: 'auth_unavailable' });
    expect(await f.sessions()).toEqual([]);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
  60_000,
);

it('[AC-B1-22m#13] convert 本人 active 放行后无 active self_buy 推广位仍 50301；绑定变 invalid 后新请求 30102 带 state', async () => {
  const f = await fixture(database(), 'taobao', 'active');
  withoutSlots(f, ['self_buy']);
  const convert = service(f);
  const first = await convert.convert(f.request());
  await failure(first, f, 50301, 503);
  expect(await f.sessions()).toEqual([]);
  const before = await f.links();
  await f.db
    .updateTable('union_bindings')
    .set({ status: 'invalid' })
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.a)
    .execute();
  const result = await convert.convert(f.request());
  await stateIssued(result, f, 30102, f.a, await fresh(f, before));
  expect(await f.attempts()).toEqual([]);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);

it('[AC-B1-22m#14] convert 淘宝没有任何联盟账号 → 50301 不签发 state；登记账号（仍无推广位）后新请求 30101', async () => {
  const f = await fixture(database(), 'taobao', 'absent');
  await dropAccounts(f);
  const convert = service(f);
  const first = await convert.convert(f.request());
  await failure(first, f, 50301, 503);
  refused(first, 50301, 503);
  expect(await f.sessions()).toEqual([]);
  const before = await f.links();
  await addAccount(f);
  const result = await convert.convert(f.request());
  await stateIssued(result, f, 30101, f.a, await fresh(f, before));
  expect(await f.attempts()).toEqual([]);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);
