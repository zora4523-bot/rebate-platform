// B1-06zd rule tests: a Taobao share through POST /v1/shares (D10-510; BR-ATTR-10, BR-ATTR-13 ②,
// BR-ATTR-27 淘宝行 as amended by 编排补充 2026-11-01): with share.taobao_enabled on, the share link is
// converted in the request with the sharer's relation_id on the share slot; share_url and tpwd go
// to share_materials, our promotion link to links.promo_url at the injected clock. The 大淘客 price
// is never written to the quote snapshot (BR-PRICE-12), and an open of the share link serves that
// promotion link without calling the union. Off, the frozen 50301 not_launched stands.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { added, bodyOf, expectRefused, expectShared, pageData } from '../shares/kit.ts';
import {
  COUPON_CLICK_URL,
  NOW,
  SHARE_SWITCH,
  SHORT_URL,
  TPWD,
  cardOf,
  otherPrice,
  promoHarness,
  promotion,
} from './kit.ts';

const h = promoHarness({ createTestDatabase, acquireTestRedis });
const ON = { [SHARE_SWITCH]: true };

it.each([
  { label: '未配置', settings: {} },
  { label: '配置为 false', settings: { [SHARE_SWITCH]: false } },
])(
  '[AC-B1-06zd#1] share.taobao_enabled $label：淘宝分享维持 50301 not_launched，不调转链、不落库；开关打开的 App 才生成',
  async ({ settings }) => {
    const off = await h.tenant(settings);
    const sharer = await off.user();
    const card = cardOf(await sharer.search('taobao'));
    const before = await h.persisted(off.appId);
    const body = await expectRefused(await sharer.share(bodyOf(card)), 503, 50301);
    expect(body.data).toMatchObject({ reason: 'not_launched', platform: 'taobao' });
    expect(h.conversions()).toEqual([]);
    expect(await h.persisted(off.appId)).toEqual(before);

    const on = await h.tenant(ON);
    const other = await on.user();
    const shared = await other.share(bodyOf(cardOf(await other.search('taobao'))));
    await expectShared(shared);
    expect(h.conversions()).toHaveLength(1);
  },
  120_000,
);

it('[AC-B1-06zd#2] 开关打开：以分享者 relation_id 与 share 推广位同步转链，share_url = short_url、tpwd 写 share_materials、promo_url = coupon_click_url、时间取注入时钟', async () => {
  const t = await h.tenant(ON);
  const sharer = await t.user();
  const card = cardOf(await sharer.search('taobao'));
  const before = await h.persisted(t.appId);

  const data = await expectShared(await sharer.share(bodyOf(card)));
  const after = await h.persisted(t.appId);

  const links = added(before.links, after.links);
  expect(links.map((row) => row.link_id)).toEqual([data.link_id]);
  const row = links[0]!;
  expect(h.conversions()).toEqual([
    {
      parameters: {
        goodsId: row.raw_item_id,
        pid: t.pid('taobao', 'share'),
        channelId: sharer.relationId,
      },
      appId: t.appId,
      purpose: 'online',
    },
  ]);
  expect(row).toMatchObject({
    user_id: sharer.uid,
    platform: 'taobao',
    scene: 'share',
    pid_scene: 'share',
    pid: t.pid('taobao', 'share'),
    promo_url: COUPON_CLICK_URL,
  });
  expect(row.promo_url_fetched_at).toEqual(new Date(NOW));
  expect(added(before.materials, after.materials)).toEqual([
    expect.objectContaining({
      app_id: t.appId,
      link_id: data.link_id,
      share_url: SHORT_URL,
      tpwd: TPWD,
    }),
  ]);
  expect(data).toMatchObject({ share_url: SHORT_URL, tpwd: TPWD, poster_url: null });
  expect(data.copy.parts).toMatchObject({ tpwd_line: `复制 ${TPWD} 打开淘宝`, link_line: null });
  // The share page reads the material row it always did.
  const page = await pageData(await h.page(t.appId, data.link_id));
  expect(page).toMatchObject({ jump_url: SHORT_URL, tpwd_ticket: expect.any(String) });
}, 120_000);

it('[AC-B1-06zd#3] BR-PRICE-12：转链同次返回的价格不写 links 报价快照', async () => {
  const t = await h.tenant(ON);
  const sharer = await t.user();
  const card = cardOf(await sharer.search('taobao'));
  const before = await h.persisted(t.appId);

  const data = await expectShared(await sharer.share(bodyOf(card)));

  const links = added(before.links, (await h.persisted(t.appId)).links);
  expect(links).toHaveLength(1);
  const row = links[0]!;
  expect(row.link_id).toBe(data.link_id);
  expect(row.quoted_final_price_fen).not.toBe(otherPrice().final_price_fen);
  expect(row.quoted_at).not.toEqual(new Date(otherPrice().quoted_at));
}, 120_000);

it.each([
  {
    label: '没有 short_url',
    result: promotion({ short: null }),
    shareUrl: COUPON_CLICK_URL,
    promoUrl: COUPON_CLICK_URL,
  },
  {
    label: '没有 coupon_click_url',
    result: promotion({ coupon: null }),
    shareUrl: SHORT_URL,
    promoUrl: SHORT_URL,
  },
])(
  '[AC-B1-06zd#4] $label：share_url 取 short_url 否则 coupon_click_url，promo_url 取 coupon_click_url 否则 short_url（没有 tpwd 不生成，见 share-failures）',
  async ({ result, shareUrl, promoUrl }) => {
    const t = await h.tenant(ON);
    const sharer = await t.user();
    const card = cardOf(await sharer.search('taobao'));
    h.answer(() => result);

    const data = await expectShared(await sharer.share(bodyOf(card)));

    expect(data).toMatchObject({ share_url: shareUrl, tpwd: TPWD });
    expect((await h.link(data.link_id)).promo_url).toBe(promoUrl);
    const { materials } = await h.persisted(t.appId);
    expect(materials).toEqual([expect.objectContaining({ share_url: shareUrl, tpwd: TPWD })]);
  },
  120_000,
);

it('[AC-B1-06zd#5] 不跨用户：两位分享者同一商品各转一次，各带自己的 relation_id，promo_url 各是自己的', async () => {
  const t = await h.tenant(ON);
  h.answer((parameters) =>
    promotion({
      short: `${SHORT_URL}&r=${String(parameters['channelId'])}`,
      coupon: `${COUPON_CLICK_URL}&r=${String(parameters['channelId'])}`,
    }),
  );
  const seen: (string | null)[] = [];
  for (const sharer of [await t.user(), await t.user()]) {
    const card = cardOf(await sharer.search('taobao'));
    const data = await expectShared(await sharer.share(bodyOf(card)));
    expect((await h.link(data.link_id)).promo_url).toBe(
      `${COUPON_CLICK_URL}&r=${String(sharer.relationId)}`,
    );
    seen.push(sharer.relationId);
  }
  expect(h.conversions().map((call) => call.parameters['channelId'])).toEqual(seen);
  expect(new Set(seen).size).toBe(2);
}, 120_000);

it('[AC-B1-06zd#6] 同一 Idempotency-Key 重放原答复：只转链一次、只登记一条 link', async () => {
  const t = await h.tenant(ON);
  const sharer = await t.user();
  const card = cardOf(await sharer.search('taobao'));
  const before = await h.persisted(t.appId);
  const key = randomUUID();

  const first = await expectShared(await sharer.share(bodyOf(card), { key }));
  const replay = await expectShared(await sharer.share(bodyOf(card), { key }));

  expect(replay).toEqual(first);
  expect(h.conversions()).toHaveLength(1);
  const after = await h.persisted(t.appId);
  expect(added(before.links, after.links).map((row) => row.link_id)).toEqual([first.link_id]);
}, 120_000);

it('[AC-B1-06zd#7] 打开流程不调联盟：别的用户打开分享 link，按 promo_url 走 openByUrl，转链次数不变', async () => {
  const t = await h.tenant(ON);
  const sharer = await t.user();
  const data = await expectShared(
    await sharer.share(bodyOf(cardOf(await sharer.search('taobao')))),
  );
  h.clearConversions();

  const opener = await t.user();
  const response = await opener.open(data.link_id);

  expect(response.statusCode, response.payload).toBe(200);
  const opened = response.json() as { data: { jump: { primary: unknown } } };
  expect(opened.data.jump.primary).toMatchObject({
    type: 'sdk',
    sdk: { provider: 'baichuan', open_by: 'url', url: COUPON_CLICK_URL },
  });
  expect(h.conversions()).toEqual([]);
}, 120_000);
