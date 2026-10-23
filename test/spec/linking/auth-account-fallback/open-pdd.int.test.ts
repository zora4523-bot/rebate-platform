import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createPddAuthLinkOpen } from '../../../../apps/api/src/modules/linking/application/link-open-pdd-auth.ts';
import { createLinkingPidReader } from '../../../../apps/api/src/modules/linking/infra/pid-reader.ts';
import { noAuthEntry, noConversion, response } from '../open-pdd-auth/assertions.ts';
import { fixture, outcome } from '../open-pdd-auth/kit.ts';
import {
  activeSlot,
  databaseFixture,
  driftedAccounts,
  interleavedAccounts,
  type SiteAuth,
} from './kit.ts';

// B1-22l (D10-239 ①; BR-ATTR-05 细则 ④⑦; BR-ID-22; BR-ID-24 ④): a Pinduoduo open whose snapshot
// user has no unreleased binding, on a platform with no active self_buy slot, uses the
// earliest-registered account: its site authorization decides maintenance, and its slot of the
// scene is the filing query's. The link is an Agent card's (pid_scene agent), so both accounts
// have an active agent slot and neither has a self_buy one. Slots are read by union's own
// read-only query over real rows.
const database = databaseFixture(createTestDatabase);

async function prepared(auth: { readonly first: SiteAuth; readonly later: SiteAuth }) {
  const f = await fixture(database(), { binding: 'absent', query: false, scene: 'agent' });
  const accounts = await driftedAccounts(f.db, f.appId, 'pdd', auth, f.accountId);
  const slots = {
    first: await activeSlot(f.db, {
      appId: f.appId,
      platform: 'pdd',
      accountId: accounts.first,
      pidScene: 'agent',
    }),
    later: await activeSlot(f.db, {
      appId: f.appId,
      platform: 'pdd',
      accountId: accounts.later,
      pidScene: 'agent',
    }),
  };
  const open = createPddAuthLinkOpen({
    ...f.options,
    pids: createLinkingPidReader(f.db, f.clock),
  });
  return { f, accounts, slots, open };
}

/** Same, over three accounts whose update order is not the reverse of their registration order. */
async function interleaved(auth: { readonly first: SiteAuth; readonly others: SiteAuth }) {
  const f = await fixture(database(), { binding: 'absent', query: false, scene: 'agent' });
  const accounts = await interleavedAccounts(f.db, f.appId, 'pdd', auth, f.accountId);
  const slot = (accountId: string) =>
    activeSlot(f.db, { appId: f.appId, platform: 'pdd', accountId, pidScene: 'agent' });
  const slots = {
    first: await slot(accounts.first),
    second: await slot(accounts.second),
    third: await slot(accounts.third),
  };
  const open = createPddAuthLinkOpen({
    ...f.options,
    pids: createLinkingPidReader(f.db, f.clock),
  });
  return { f, accounts, slots, open };
}

it('[B1-22l] 拼多多 open 无绑定、无 self_buy 位：最早登记的账号 expired → maintenance，不改用更早更新的有效账号', async () => {
  const { f, open } = await prepared({ first: 'expired', later: 'active' });
  const before = await f.bindings();
  const result = await response(await outcome(() => open.open(f.request())), 50301, 503);
  expect(result.envelope.data).toEqual({ reason: 'maintenance' });
  noAuthEntry(result);
  expect(f.query).not.toHaveBeenCalled();
  expect(await f.sessions()).toEqual([]);
  expect(await f.bindings()).toEqual(before);
  await noConversion(f);
}, 60_000);

it('[B1-22l] 拼多多 open 无绑定、无 self_buy 位：最早登记的账号有效 → 用它的 agent 位查备案，较晚登记的账号 expired 不影响', async () => {
  const { f, slots, open } = await prepared({ first: 'active', later: 'expired' });
  const result = await response(await outcome(() => open.open(f.request())), 30111, 422);
  expect(result.envelope.data).toMatchObject({ auth_jump: expect.any(Object) });
  expect(f.query.mock.calls.map(([identity]) => identity.claims.promotionSlot)).toEqual([
    slots.first.pid,
  ]);
  expect(await f.sessions()).toEqual([
    expect.objectContaining({
      app_id: f.appId,
      user_id: f.a.userId,
      device_id: f.a.deviceId,
      platform: 'pdd',
      link_id: f.row.link_id,
      used_at: null,
    }),
  ]);
  await noConversion(f);
}, 60_000);

it('[B1-22l] 拼多多 open 无绑定、无 self_buy 位、三个账号更新先后与登记先后交错：最早登记的账号 expired → maintenance，不改用最近重新授权或最早更新的有效账号', async () => {
  const { f, open } = await interleaved({ first: 'expired', others: 'active' });
  const before = await f.bindings();
  const result = await response(await outcome(() => open.open(f.request())), 50301, 503);
  expect(result.envelope.data).toEqual({ reason: 'maintenance' });
  noAuthEntry(result);
  expect(f.query).not.toHaveBeenCalled();
  expect(await f.sessions()).toEqual([]);
  expect(await f.bindings()).toEqual(before);
  await noConversion(f);
}, 60_000);

it('[B1-22l] 拼多多 open 无绑定、无 self_buy 位、三个账号更新先后与登记先后交错：最早登记的账号有效 → 用它的 agent 位查备案', async () => {
  const { f, slots, open } = await interleaved({ first: 'active', others: 'expired' });
  const result = await response(await outcome(() => open.open(f.request())), 30111, 422);
  expect(result.envelope.data).toMatchObject({ auth_jump: expect.any(Object) });
  expect(f.query.mock.calls.map(([identity]) => identity.claims.promotionSlot)).toEqual([
    slots.first.pid,
  ]);
  expect(await f.sessions()).toEqual([
    expect.objectContaining({
      app_id: f.appId,
      user_id: f.a.userId,
      device_id: f.a.deviceId,
      platform: 'pdd',
      link_id: f.row.link_id,
      used_at: null,
    }),
  ]);
  await noConversion(f);
}, 60_000);
