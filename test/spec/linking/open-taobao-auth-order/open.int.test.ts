import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-requote/kit.ts';
import { compose, setup, type Fixture } from '../open-taobao/kit.ts';
import {
  addAccount,
  ban,
  dropAccounts,
  expireSite,
  refused,
  stateIssued,
  withoutSlots,
} from './kit.ts';

// Task B1-22m (BR-ATTR-05 细则「open 业务校验的先后」: ④ 站长授权 → ⑤ 无返利分流 → ⑥ 授权门 →
// ⑦ 推广位; D10-239 T2 + T3c) is the rule source. In every case below the account this open uses
// has no active slot in the scene: the authorization gate answers first, the slot is read only on
// the branch the gate lets through, and an app with no Taobao union account is always 50301.
const database = databaseFixture(createTestDatabase);
const unauthorized = [
  ['absent', 30101],
  ['unbound', 30101],
  ['pending_auth', 30101],
  ['released', 30101],
  ['invalid', 30102],
] as const;

async function setBinding(f: Fixture, status: 'invalid' | 'blocked') {
  await f.db
    .updateTable('union_bindings')
    .set({ status, blocked_reason: status === 'blocked' ? 'admin_disable' : null })
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.a)
    .execute();
}

it.each(unauthorized)(
  '[AC-B1-22m#1] 本人 %s、所用账号 self_buy 无 active 推广位、站长授权正常 → %i 带 auth_url 与 state，不取价',
  async (status, code) => {
    const f = await setup(database());
    await f.bind(status);
    withoutSlots(f, ['self_buy']);
    const result = await compose(f)();
    await stateIssued(result, f, code, f.a, f.row.link_id);
    expect(await f.sessions()).toHaveLength(1);
    expect(await f.attempts()).toEqual([]);
    expect(await f.logs()).toEqual([
      expect.objectContaining({ result_code: code, link_id: f.row.link_id }),
    ]);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
  60_000,
);

it.each(
  unauthorized.flatMap(([status, code]) =>
    [false, true].map((noRebate) => ({ status, code, noRebate })),
  ),
)(
  '[AC-B1-22m#2] 站长授权 expired、所用账号无 active 推广位：$status / no_rebate=$noRebate → $code auth_unavailable',
  async ({ status, code, noRebate }) => {
    const f = await setup(database());
    await f.bind(status);
    await expireSite(f);
    withoutSlots(f, ['self_buy']);
    const result = await compose(f)(f.request({ noRebate }));
    refused(result, code, 422, { reason: 'auth_unavailable' });
    expect(await f.sessions()).toEqual([]);
    expect(await f.attempts()).toEqual([]);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
  60_000,
);

it.each([
  { risk: 'normal', site: 'active', code: 30153, status: 422 },
  { risk: 'normal', site: 'expired', code: 30153, status: 422 },
  { risk: 'banned', site: 'active', code: 10001, status: 401 },
] as const)(
  '[AC-B1-22m#3] 本人 blocked（$risk 用户、站长授权 $site）、所用账号无 active 推广位 → $code，无授权入口',
  async ({ risk, site, code, status }) => {
    const f = await setup(database());
    await f.bind('blocked');
    if (risk === 'banned') await ban(f, f.a);
    if (site === 'expired') await expireSite(f);
    withoutSlots(f, ['self_buy']);
    const result = await compose(f)();
    refused(result, code, status);
    expect(await f.sessions()).toEqual([]);
    expect(await f.attempts()).toEqual([]);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
  60_000,
);

const sharers = [
  'absent',
  'unbound',
  'pending_auth',
  'invalid',
  'released',
  'blocked',
  'expired',
] as const;
const openers = ['member', 'guest'] as const;
const sharerCases = sharers.flatMap((status) => openers.map((opener) => ({ status, opener })));
it.each(sharerCases)(
  '[AC-B1-22m#4] $opener 开 A 的分享 link、分享者 $status、所用账号 share 无 active 推广位 → 30102 sharer_auth_invalid',
  async ({ status, opener }) => {
    const f = await setup(database(), 'share');
    await f.bind(status === 'expired' ? 'unbound' : status);
    if (status === 'expired') await expireSite(f);
    await f.bind('active', f.b);
    withoutSlots(f, ['share']);
    f.opener(opener === 'guest' ? null : f.b);
    // no_rebate on another user's share link is ignored (BR-ATTR-05 细则「别人的分享 link 不可用」).
    const result = await compose(f)(f.request({ noRebate: opener === 'member' }));
    refused(result, 30102, 422, { reason: 'sharer_auth_invalid' });
    expect(await f.sessions()).toEqual([]);
    expect(await f.links()).toHaveLength(1);
    expect(await f.attempts()).toEqual([]);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
  60_000,
);

it('[AC-B1-22m#5] 本人 active 放行后无 active self_buy 推广位仍 50301（含 no_rebate）；同一账号的绑定变 invalid 则 30102 带 state', async () => {
  const f = await setup(database());
  await f.bind('active');
  withoutSlots(f, ['self_buy']);
  const open = compose(f);
  for (const noRebate of [false, true]) refused(await open(f.request({ noRebate })), 50301, 503);
  expect(await f.sessions()).toEqual([]);
  await setBinding(f, 'invalid');
  await stateIssued(await open(), f, 30102, f.a, f.row.link_id);
  expect(await f.attempts()).toEqual([]);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);

it('[AC-B1-22m#6] 本人 blocked：no_rebate 放行后无 active self_buy 推广位仍 50301；不带 no_rebate 为 30153', async () => {
  const f = await setup(database());
  await f.bind('blocked');
  withoutSlots(f, ['self_buy']);
  const open = compose(f);
  refused(await open(f.request({ noRebate: true })), 50301, 503);
  refused(await open(), 30153, 422);
  expect(await f.sessions()).toEqual([]);
  expect(await f.attempts()).toEqual([]);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);

it.each(unauthorized)(
  '[AC-B1-22m#7] 站长授权正常、本人 %s：no_rebate 放行后无 active self_buy 推广位 50301；不带 no_rebate 为 %i 带 state',
  async (status, code) => {
    const f = await setup(database());
    await f.bind(status);
    withoutSlots(f, ['self_buy']);
    const open = compose(f);
    refused(await open(f.request({ noRebate: true })), 50301, 503);
    expect(await f.sessions()).toEqual([]);
    await stateIssued(await open(), f, code, f.a, f.row.link_id);
    expect(await f.attempts()).toEqual([]);
    expect(f.f.fetch).not.toHaveBeenCalled();
  },
  60_000,
);

it('[AC-B1-22m#8] 淘宝没有任何联盟账号：本人未绑定一律 50301（含 no_rebate），不签发 state；登记账号（仍无推广位）后为 30101', async () => {
  const f = await setup(database());
  await dropAccounts(f);
  const open = compose(f);
  for (const noRebate of [false, true]) refused(await open(f.request({ noRebate })), 50301, 503);
  expect(await f.sessions()).toEqual([]);
  await addAccount(f);
  await stateIssued(await open(), f, 30101, f.a, f.row.link_id);
  expect(await f.attempts()).toEqual([]);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);

it('[AC-B1-22m#9] 淘宝没有任何联盟账号：别人开 A 的分享 link 一律 50301；登记账号（仍无推广位）后为 30102 sharer_auth_invalid', async () => {
  const f = await setup(database(), 'share');
  await dropAccounts(f);
  f.opener(f.b);
  const open = compose(f);
  refused(await open(), 50301, 503);
  await addAccount(f);
  refused(await open(), 30102, 422, { reason: 'sharer_auth_invalid' });
  expect(await f.sessions()).toEqual([]);
  expect(await f.links()).toHaveLength(1);
  expect(await f.attempts()).toEqual([]);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);
