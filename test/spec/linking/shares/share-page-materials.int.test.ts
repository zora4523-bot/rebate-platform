// B1-15w rule tests: the share page's default material provider reads app.share_materials (BR-ATTR-10
// 细则「分享页与分享赚入口页」「中间页的口令按打开环境区分」; D10-424 / D10-426), with the real wiring of
// the api entry (nothing in LinkingModule replaced). Share links and their rows are written
// directly, so these cases do not depend on POST /v1/shares:
// - a share link with a share_materials row → jump_url = its share_url, the token (tpwd) is the
//   row's: a ticket outside WeChat, the exchange hands out exactly that token; JD and Pinduoduo rows
//   have no token;
// - the Taobao fallback stays: no row but links.promo_url → jump_url = promo_url, no token;
// - no row and no fallback → 30144 as before. The provider never converts.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { UA, expectRefused, hex, pageData, sharesHarness, tpwdOf } from './kit.ts';

const h = sharesHarness({ createTestDatabase, acquireTestRedis });

it('[AC-B1-15w#8] 京东、拼多多分享 link 有 share_materials 行 → jump_url 即物料的 share_url、无口令票据；淘宝无物料行时仍以 promo_url 兜底，两者都没有 → 30144；不转链', async () => {
  const t = await h.tenant();
  const sharer = await t.user();
  h.clearObservations();
  for (const platform of ['jd', 'pdd'] as const) {
    const shareUrl = `https://u.example.test/share-${platform}-${hex(12)}`;
    const linkId = await t.seedShareLink(sharer.uid, platform, {
      material: { shareUrl, tpwd: null },
    });
    for (const ua of [UA.safari, UA.wechat]) {
      const data = await pageData(await h.page(t.appId, linkId, ua));
      expect(data).toMatchObject({
        jump_url: shareUrl,
        tpwd_ticket: null,
        product_card: { link_id: linkId, platform },
      });
    }
  }
  const promoUrl = `https://s.click.example.test/t?e=promo${hex(16)}`;
  const fallback = await t.seedShareLink(sharer.uid, 'taobao', { promoUrl });
  const data = await pageData(await h.page(t.appId, fallback));
  expect(data).toMatchObject({ jump_url: promoUrl, tpwd_ticket: null });
  for (const platform of ['taobao', 'jd'] as const) {
    const bare = await t.seedShareLink(sharer.uid, platform);
    await expectRefused(await h.page(t.appId, bare), 404, 30144);
  }
  expect(h.converts()).toEqual([]);
}, 120_000);

it('[AC-B1-15w#8] 淘宝分享 link 有 share_materials 行时以物料为准：jump_url 为物料的 share_url（不是 promo_url），系统浏览器下发票据，取口令换到的正是物料行的 tpwd；微信内不发票据', async () => {
  const t = await h.tenant();
  const sharer = await t.user();
  const shareUrl = `https://s.click.example.test/t?e=share${hex(16)}`;
  const tpwd = `￥SynShare${hex(10)}￥`;
  const linkId = await t.seedShareLink(sharer.uid, 'taobao', {
    promoUrl: `https://s.click.example.test/t?e=promo${hex(16)}`,
    material: { shareUrl, tpwd },
  });
  h.clearObservations();
  const outside = await pageData(await h.page(t.appId, linkId, UA.safari));
  expect(outside.jump_url).toBe(shareUrl);
  expect(outside.tpwd_ticket).toEqual(expect.any(String));
  expect(await tpwdOf(await h.exchange(t.appId, linkId, String(outside.tpwd_ticket)))).toBe(tpwd);
  const inside = await pageData(await h.page(t.appId, linkId, UA.wechat));
  expect(inside).toMatchObject({ jump_url: shareUrl, tpwd_ticket: null });
  expect(h.converts()).toEqual([]);
}, 120_000);
