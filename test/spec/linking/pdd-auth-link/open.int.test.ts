import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  STATE_TTL_MS,
  authorityHarness,
  customOf,
  expectAuthorityIdentity,
  expectNoState,
  expectedLink,
  opened,
  planOver,
  planValues,
  refused,
} from './kit.ts';

// B1-06zf (FU-PDD-AUTH-LINK, D10-647 ①②③): a Pinduoduo open the filing query answers "not filed"
// refuses with 30111 whose data.auth_jump is built over the link pddAuthorityUrl generated for the
// identity the conversion uses; the state is bound to uid + device record + the opened link and
// never put in the link. Filing is still decided by the authority query (BR-ID-22).
const h = authorityHarness({ createTestDatabase, acquireTestRedis });

it('[AC-B1-06zf#7] 拼多多 open 未备案 30111：data.auth_jump 就是 pddAuthorityUrl 返回的链接（schema_url → mobile_short_url → url），不是 example.test 占位', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  const response = await u.open(linkId);
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(1);
  const link = expectedLink(calls[0]!.result);
  const body = await refused(response, 422, 30111);
  expect(body.data).toEqual({ auth_jump: planOver(link) });
  expect(h.convertCalls(t.appId)).toEqual([]);
}, 60_000);

it('[AC-B1-06zf#8] 拼多多 open 30111：state 只进 union_auth_sessions，一行绑 uid、设备记录与本次 open 的 link，链接与响应里都不带它', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  const body = await refused(await u.open(linkId), 422, 30111);
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  const rows = await t.sessions();
  expect(rows).toEqual([
    expect.objectContaining({
      app_id: t.appId,
      user_id: u.uid,
      device_id: u.deviceId,
      platform: 'pdd',
      mode: 'bind',
      link_id: linkId,
      used_at: null,
      client: 'ios',
      auth_methods: null,
      auth_app_refs: null,
    }),
  ]);
  const state = rows[0]!.state;
  expect(rows[0]!.expire_at.getTime() - rows[0]!.created_at.getTime()).toBe(STATE_TTL_MS);
  expectNoState(planValues(body.data?.['auth_jump']), state);
  expect(JSON.stringify(body)).not.toContain(state);
}, 60_000);

it('[AC-B1-06zf#9] 拼多多 open 调 pddAuthorityUrl 的身份就是备案查询与转链用的：同一 App、同一账户的 self_buy 推广位、同一 custom_parameters，不含 user_id', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  await refused(await u.open(linkId), 422, 30111);
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expectAuthorityIdentity(call, {
    appId: t.appId,
    pid: t.pid('self_buy'),
    attrCode: u.attrCode,
    scene: 'self_buy',
    privateValues: [u.uid, u.deviceId],
  });
  const queries = h.queryCalls(t.appId);
  expect(queries).toHaveLength(1);
  expect(call.identity.claims).toEqual(queries[0]!.identity.claims);
  expect(customOf(call.identity)).toEqual(customOf(queries[0]!.identity));

  // The same user filed: the open converts with the identity the link was generated for.
  h.fileUsers();
  await opened(await u.open(linkId));
  const converts = h.convertCalls(t.appId);
  expect(converts).toHaveLength(1);
  expect(converts[0]!.identity.claims).toMatchObject({
    appId: call.identity.claims.appId,
    platform: 'pdd',
    promotionSlot: call.identity.claims.promotionSlot,
    userId: call.identity.claims.userId,
  });
  expect(customOf(converts[0]!.identity)).toEqual(customOf(call.identity));
}, 60_000);

it('[AC-B1-06zf#10] 点击才生成：注册设备、搜索、授权管理页不调用；未备案 open 调一次；已备案（active）的 open 不再调用、不写 state', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  await u.bindings();
  expect(h.authorityUrlCalls(t.appId)).toEqual([]);

  await refused(await u.open(linkId), 422, 30111);
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  expect(await t.sessions()).toHaveLength(1);

  // Filed now: the query activates the binding and the open converts, no link generated.
  h.fileUsers();
  await opened(await u.open(linkId));
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  expect(await t.bindings()).toEqual([
    expect.objectContaining({ user_id: u.uid, platform: 'pdd', status: 'active' }),
  ]);

  // Active: neither the query nor the link generation is asked again.
  const asked = h.queryCalls(t.appId).length;
  await opened(await u.open(linkId));
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  expect(h.queryCalls(t.appId)).toHaveLength(asked);
  expect(await t.sessions()).toHaveLength(1);
}, 60_000);

it('[AC-B1-06zf#11] 每次未备案 open 各生成一次（不预生成、不缓存），每次各一个新 state，链接都是当次返回的', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  const first = await refused(await u.open(linkId), 422, 30111);
  const second = await refused(await u.open(linkId), 422, 30111);
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(2);
  expect(first.data).toEqual({ auth_jump: planOver(expectedLink(calls[0]!.result)) });
  expect(second.data).toEqual({ auth_jump: planOver(expectedLink(calls[1]!.result)) });
  const rows = await t.sessions();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.state)).size).toBe(2);
  expect(rows.every((row) => row.link_id === linkId)).toBe(true);
}, 60_000);

it('[AC-B1-06zf#12] pddAuthorityUrl 抛错：未备案 open 返回 HTTP 503 / 50303，不下发 auth_jump，union_auth_sessions 没有新行，绑定与转链都不动', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  h.failAuthorityUrl(new UnionError('upstream_rejected', 'synthetic filing link refusal', 'pdd'));
  const response = await u.open(linkId);
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  expect(h.queryCalls(t.appId)).toHaveLength(1);
  const body = await refused(response, 503, 50303);
  expect(body.data ?? {}).not.toHaveProperty('auth_jump');
  expect(await t.sessions()).toEqual([]);
  expect(await t.bindings()).toEqual([]);
  expect(h.convertCalls(t.appId)).toEqual([]);
}, 60_000);
