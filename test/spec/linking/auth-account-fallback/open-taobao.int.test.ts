import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createLinkingPidReader } from '../../../../apps/api/src/modules/linking/infra/pid-reader.ts';
import { databaseFixture } from '../open-requote/kit.ts';
import { compose, failure, noAuthState, setup } from '../open-taobao/kit.ts';
import { activeSlot, driftedAccounts, interleavedAccounts, type SiteAuth } from './kit.ts';

// B1-22l (D10-239 ①; BR-ATTR-05 细则 ④⑦; BR-ID-24 ④): a Taobao open whose snapshot user has no
// unreleased binding, on a platform with no active self_buy slot, uses the earliest-registered
// account for both the scene's slot and the site authorization (expired → 30101
// auth_unavailable, no state). The link is an Agent card's (pid_scene agent), so both accounts
// have an active agent slot and neither has a self_buy one. Slots are read by union's own
// read-only query over real rows.
const database = databaseFixture(createTestDatabase);

/** The kit's own scene parameter lists detail / share; its registration takes any contract scene. */
const AGENT = 'agent' as string as NonNullable<Parameters<typeof setup>[1]>;

async function prepared(auth: { readonly first: SiteAuth; readonly later: SiteAuth }) {
  const f = await setup(database(), AGENT);
  const accounts = await driftedAccounts(f.db, f.appId, 'taobao', auth, f.account);
  for (const accountId of [accounts.first, accounts.later]) {
    await activeSlot(f.db, { appId: f.appId, platform: 'taobao', accountId, pidScene: 'agent' });
  }
  const open = compose(f, { pids: createLinkingPidReader(f.db, f.f.clock) });
  return { f, open };
}

/** Same, over three accounts whose update order is not the reverse of their registration order. */
async function interleaved(auth: { readonly first: SiteAuth; readonly others: SiteAuth }) {
  const f = await setup(database(), AGENT);
  const accounts = await interleavedAccounts(f.db, f.appId, 'taobao', auth, f.account);
  for (const accountId of [accounts.first, accounts.second, accounts.third]) {
    await activeSlot(f.db, { appId: f.appId, platform: 'taobao', accountId, pidScene: 'agent' });
  }
  const open = compose(f, { pids: createLinkingPidReader(f.db, f.f.clock) });
  return { f, open };
}

it('[B1-22l] 淘宝 open 无绑定、无 self_buy 位：最早登记的账号 expired → 30101 auth_unavailable，不签发 state', async () => {
  const { f, open } = await prepared({ first: 'expired', later: 'active' });
  expect(f.row.pid_scene).toBe('agent');
  const result = await open();
  await failure(result, f, 30101);
  expect(result.envelope.data).toEqual({ reason: 'auth_unavailable' });
  await noAuthState(result, f);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);

it('[B1-22l] 淘宝 open 无绑定、无 self_buy 位：最早登记的账号有效 → 30101 带授权入口，较晚登记的账号 expired 不影响', async () => {
  const { f, open } = await prepared({ first: 'active', later: 'expired' });
  const result = await open();
  await failure(result, f, 30101);
  expect(result.envelope.data).toMatchObject({
    auth_url: expect.any(String),
    state: expect.any(String),
    auth_methods: ['web_code'],
  });
  expect(result.envelope.data).not.toHaveProperty('reason', 'auth_unavailable');
  const data = result.envelope.data as { state: string };
  expect(await f.sessions()).toEqual([
    expect.objectContaining({
      state: data.state,
      app_id: f.appId,
      user_id: f.a,
      device_id: f.device,
      platform: 'taobao',
      mode: 'bind',
      link_id: f.row.link_id,
      used_at: null,
    }),
  ]);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);

it('[B1-22l] 淘宝 open 无绑定、无 self_buy 位、三个账号更新先后与登记先后交错：最早登记的账号 expired → 30101 auth_unavailable，不改用最近重新授权或最早更新的有效账号', async () => {
  const { f, open } = await interleaved({ first: 'expired', others: 'active' });
  expect(f.row.pid_scene).toBe('agent');
  const result = await open();
  await failure(result, f, 30101);
  expect(result.envelope.data).toEqual({ reason: 'auth_unavailable' });
  await noAuthState(result, f);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);

it('[B1-22l] 淘宝 open 无绑定、无 self_buy 位、三个账号更新先后与登记先后交错：最早登记的账号有效 → 30101 带授权入口，其余账号 expired 不影响', async () => {
  const { f, open } = await interleaved({ first: 'active', others: 'expired' });
  const result = await open();
  await failure(result, f, 30101);
  expect(result.envelope.data).toMatchObject({
    auth_url: expect.any(String),
    state: expect.any(String),
    auth_methods: ['web_code'],
  });
  expect(result.envelope.data).not.toHaveProperty('reason', 'auth_unavailable');
  const data = result.envelope.data as { state: string };
  expect(await f.sessions()).toEqual([
    expect.objectContaining({
      state: data.state,
      app_id: f.appId,
      user_id: f.a,
      device_id: f.device,
      platform: 'taobao',
      mode: 'bind',
      link_id: f.row.link_id,
      used_at: null,
    }),
  ]);
  expect(f.f.fetch).not.toHaveBeenCalled();
}, 60_000);
