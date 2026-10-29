// B1-15u: GET /v1/share-pages/{link_id} through the real api entry (BR-ATTR-10 细则「中间页的口令按
// 打开环境区分」「分享页与分享赚入口页」; BR-ATTR-05 细则「App 内打开链接的入口」「别人的分享 link
// 不可用」; contracts getSharePage, error-codes 30102 / 30111 / 30144).
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  BROWSER_UAS,
  MISSING,
  OPEN_IN_APP_KEY,
  QUOTED,
  UA,
  WECHAT_LIKE,
  WECHAT_UAS,
  expectLandingDeepLink,
  expectNoToken,
  expectRefused,
  expectSharedSubset,
  pageData,
  persisted,
  shareHarness,
  ticketOf,
  type BindingStatus,
  type InjectResponse,
  type SharerPlatform,
} from './kit.ts';

const h = shareHarness({ createTestDatabase, acquireTestRedis });

const AUTH_FIELDS = ['auth_url', 'state', 'auth_methods', 'auth_jump'] as const;

/** 30102 / 30111 of another user's share link: reason only, no way to authorize (CT-02h). */
async function expectSharerInvalid(
  response: InjectResponse,
  code: number,
  ...cores: readonly string[]
): Promise<void> {
  const body = await expectRefused(response, 422, code);
  expect(body).toMatchObject({ data: { reason: 'sharer_auth_invalid' } });
  for (const field of AUTH_FIELDS) expect(body.data ?? {}).not.toHaveProperty(field);
  for (const core of cores) expectNoToken(response, core);
}

it('[AC-B1-15u#1] 只答本 App 的 pid_scene=share link；其他场景、不存在、别的 App、非 uuid 都是同一个 30144', async () => {
  const t = await h.tenant();
  const other = await h.tenant();
  // The sharer's Taobao binding is invalid: a non-share link still answers 30144, never 30102.
  const sharer = await t.sharer({ taobao: 'invalid' });
  const shared = await t.link(await t.sharer(), 'jd');
  const foreign = await other.link(await other.sharer(), 'jd');
  await pageData(await h.get(t.appId, shared.linkId));
  await pageData(await h.get(other.appId, foreign.linkId));

  const missing = await h.get(t.appId, MISSING);
  const missingBody = await expectRefused(missing, 404, 30144);
  const hidden: string[] = [foreign.linkId, 'not-a-link-id'];
  for (const [scene, pidScene] of [
    ['detail', 'self_buy'],
    ['search', 'query'],
    ['agent', 'agent'],
    ['taolijin', 'taolijin'],
    // The sharer's own purchase re-registered on the self_buy slot is not a share link.
    ['share', 'self_buy'],
    ['clipboard', null],
  ] as const) {
    hidden.push((await t.link(sharer, 'taobao', { scene, pidScene })).linkId);
  }
  for (const linkId of hidden) {
    const response = await h.get(t.appId, linkId);
    await expectRefused(response, 404, 30144);
    // Unknown, foreign and non-share links answer alike: existence never leaks.
    expect(response.json()).toEqual(missingBody);
  }
}, 60_000);

it('[AC-B1-15u#2] 卡片是共享子集并带 quoted_at 与分享者短链 jump_url；任何 UA 下 GET 响应都不含口令', async () => {
  const t = await h.tenant();
  const link = await t.link(await t.sharer({ taobao: 'active' }), 'taobao');
  for (const ua of [...BROWSER_UAS, ...WECHAT_LIKE]) {
    const response = await h.get(t.appId, link.linkId, { ua });
    const data = await pageData(response);
    expect(data).toMatchObject({
      quoted_at: QUOTED,
      jump_url: link.jumpUrl,
      product_card: { link_id: link.linkId, platform: 'taobao' },
    });
    expectSharedSubset(data.product_card);
    expect(data.jump_url).not.toContain(link.tpwdCore);
    // Neither the body (ticket included) nor any header carries the token.
    expectNoToken(response, link.tpwdCore);
  }
}, 60_000);

it('[AC-B1-15u#3] open_in_app_url 是 LinkLanding 深链，只看 share.open_in_app.enabled：缺省开、关时为 null，与 UA 无关', async () => {
  const byDefault = await h.tenant();
  const off = await h.tenant({ [OPEN_IN_APP_KEY]: false });
  const on = await h.tenant({ [OPEN_IN_APP_KEY]: true });
  for (const t of [byDefault, on]) {
    const link = await t.link(await t.sharer(), 'jd');
    for (const ua of [UA.safariIos, ...WECHAT_UAS, null]) {
      const data = await pageData(await h.get(t.appId, link.linkId, { ua }));
      expectLandingDeepLink(data.open_in_app_url, link.linkId);
    }
  }
  const link = await off.link(await off.sharer({ taobao: 'active' }), 'taobao');
  for (const ua of [UA.safariIos, UA.wechatIos]) {
    const data = await pageData(await h.get(off.appId, link.linkId, { ua }));
    expect(data.open_in_app_url).toBeNull();
    expect(data.jump_url).toBe(link.jumpUrl);
  }
  // The switch never decides the ticket: off still hands one out outside WeChat.
  ticketOf(await pageData(await h.get(off.appId, link.linkId, { ua: UA.safariIos })));
}, 60_000);

const INVALID_STATUSES: readonly BindingStatus[] = [
  'absent',
  'unbound',
  'pending_auth',
  'invalid',
  'blocked',
  'released',
];
const SHARER_CASES: [SharerPlatform, BindingStatus, number][] = [];
for (const status of INVALID_STATUSES) {
  SHARER_CASES.push(['taobao', status, 30102], ['pdd', status, 30111]);
}

it.each(SHARER_CASES)(
  '[AC-B1-15u#4] 分享者 %s 绑定为 %s → %i，data.reason=sharer_auth_invalid，不带 auth_url / state / auth_jump，不写授权会话',
  async (platform, status, code) => {
    const t = await h.tenant();
    const valid = await t.link(
      await t.sharer(platform === 'taobao' ? { taobao: 'active' } : { pdd: 'active' }),
      platform,
    );
    const invalid = await t.link(
      await t.sharer(platform === 'taobao' ? { taobao: status } : { pdd: status }),
      platform,
      { tpwd: `￥SynTpwdInvalid${status}￥` },
    );
    await pageData(await h.get(t.appId, valid.linkId));
    const before = await persisted(h.db());
    for (const ua of [UA.safariIos, UA.wechatAndroid, null]) {
      await expectSharerInvalid(
        await h.get(t.appId, invalid.linkId, { ua }),
        code,
        invalid.tpwdCore,
        invalid.jumpUrl,
      );
    }
    expect(await persisted(h.db())).toEqual(before);
  },
  60_000,
);

it('[AC-B1-15u#4] 站长授权中断期间同样按分享者的绑定判断：sharer_auth_invalid，不返回 auth_unavailable 或 50301', async () => {
  const t = await h.tenant();
  await t.expireSiteAuth('taobao');
  await t.expireSiteAuth('pdd');
  const jd = await t.link(await t.sharer(), 'jd');
  const taobao = await t.link(await t.sharer({ taobao: 'invalid' }), 'taobao');
  const pdd = await t.link(await t.sharer({ pdd: 'unbound' }), 'pdd');
  await pageData(await h.get(t.appId, jd.linkId));
  await expectSharerInvalid(await h.get(t.appId, taobao.linkId), 30102, taobao.tpwdCore);
  await expectSharerInvalid(await h.get(t.appId, pdd.linkId), 30111);
}, 60_000);

it('[AC-B1-15u#4] 站长授权中断期间，分享者绑定有效的淘宝、拼多多分享 link 照常出卡（200，带分享者短链，淘宝在浏览器下有票据），不返回 50301 或 30102 / 30111', async () => {
  const t = await h.tenant();
  await t.expireSiteAuth('taobao');
  await t.expireSiteAuth('pdd');
  const taobao = await t.link(await t.sharer({ taobao: 'active' }), 'taobao');
  const pdd = await t.link(await t.sharer({ pdd: 'active' }), 'pdd');
  const before = await persisted(h.db());
  for (const ua of [UA.safariIos, UA.wechatIos, null]) {
    const response = await h.get(t.appId, taobao.linkId, { ua });
    const data = await pageData(response);
    expect(data).toMatchObject({
      quoted_at: QUOTED,
      jump_url: taobao.jumpUrl,
      product_card: { link_id: taobao.linkId, platform: 'taobao' },
    });
    expectNoToken(response, taobao.tpwdCore);
    const pddData = await pageData(await h.get(t.appId, pdd.linkId, { ua }));
    expect(pddData).toMatchObject({
      quoted_at: QUOTED,
      jump_url: pdd.jumpUrl,
      tpwd_ticket: null,
      product_card: { link_id: pdd.linkId, platform: 'pdd' },
    });
  }
  // Outside WeChat the Taobao page still hands out a ticket during the outage.
  ticketOf(await pageData(await h.get(t.appId, taobao.linkId, { ua: UA.safariIos })));
  expect(await persisted(h.db())).toEqual(before);
}, 60_000);

it('[AC-B1-15u#4] 京东不判分享者授权：分享者的淘宝、拼多多授权都失效时京东分享 link 照常出卡', async () => {
  const t = await h.tenant();
  const link = await t.link(await t.sharer({ taobao: 'invalid', pdd: 'blocked' }), 'jd');
  const data = await pageData(await h.get(t.appId, link.linkId));
  expect(data).toMatchObject({ jump_url: link.jumpUrl, product_card: { platform: 'jd' } });
}, 60_000);

it('[AC-B1-15u#5] tpwd_ticket 只在 UA 判为非微信且 link 有口令时下发；微信、无 UA、空 UA、link 无口令都为 null', async () => {
  const t = await h.tenant();
  const sharer = await t.sharer({ taobao: 'active' });
  const withToken = await t.link(sharer, 'taobao');
  const withoutToken = await t.link(sharer, 'taobao', { tpwd: null });
  const jd = await t.link(await t.sharer(), 'jd');
  for (const ua of BROWSER_UAS) {
    ticketOf(await pageData(await h.get(t.appId, withToken.linkId, { ua })));
  }
  for (const ua of WECHAT_LIKE) {
    const data = await pageData(await h.get(t.appId, withToken.linkId, { ua }));
    expect(data.tpwd_ticket).toBeNull();
    // The rest of the page does not depend on the environment.
    expect(data.jump_url).toBe(withToken.jumpUrl);
  }
  for (const link of [withoutToken, jd]) {
    for (const ua of BROWSER_UAS) {
      const data = await pageData(await h.get(t.appId, link.linkId, { ua }));
      expect(data.tpwd_ticket).toBeNull();
      expect(data.jump_url).toBe(link.jumpUrl);
    }
  }
}, 60_000);

it('[AC-B1-15u#8] 匿名、不签名、不带 X-Device-Id 即可读取；成功与拒绝都 no-store；GET 只读：不登记 link、不写日志与授权会话、不转链', async () => {
  const t = await h.tenant();
  const taobao = await t.link(await t.sharer({ taobao: 'active' }), 'taobao');
  const pdd = await t.link(await t.sharer({ pdd: 'active' }), 'pdd');
  const jd = await t.link(await t.sharer(), 'jd');
  const invalid = await t.link(await t.sharer({ taobao: 'invalid' }), 'taobao');
  const before = await persisted(h.db());
  h.clearConvert();
  for (const link of [taobao, pdd, jd]) {
    for (const ua of [UA.safariIos, UA.wechatIos, null]) {
      // pageData checks Cache-Control: no-store on every success.
      await pageData(await h.get(t.appId, link.linkId, { ua }));
    }
  }
  await expectRefused(await h.get(t.appId, invalid.linkId), 422, 30102);
  await expectRefused(await h.get(t.appId, MISSING), 404, 30144);
  expect(await persisted(h.db())).toEqual(before);
  expect(h.convertCalls()).toBe(0);
}, 60_000);
