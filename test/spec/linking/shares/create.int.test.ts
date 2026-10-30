// B1-15w rule tests: POST /v1/shares for JD and Pinduoduo (BR-ATTR-10 细则「分享页与分享赚入口页」,
// BR-TEXT-20 细则「分享页文案」, BR-PRICE-06; contract createShare, CT-15t; D10-424 / D10-426):
// - with the caller (the sharer) as the identity, one new link of scene / pid_scene share is
//   registered and converted in real time (the share slot of the platform's account, the sharer's
//   attr_code), and app.share_materials gets exactly one row: share_url = the converted link, tpwd
//   null; the response carries the same link_id and share_url, tpwd null and poster_url null;
//   source_link_id is only recorded: the card's link stays as it was;
// - images are only addresses the union returned (at most 9) and are stored in no table;
// - the copy is rendered from the product's returned fields (copy-oracle.ts);
// - est_promo is the buy_type=share quote of the sharer, from the same union response as quoted_at;
// - the same Idempotency-Key replays the same answer and writes nothing; a new key registers anew;
// - GET /v1/share-pages/{link_id} of the new link jumps to its share_url (the share page's material
//   provider reads share_materials) and shows no earnings.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { expectShareCopy } from './copy-oracle.ts';
import {
  UA,
  added,
  bodyOf,
  cardWith,
  expectShared,
  fen,
  pageData,
  sharesHarness,
  textOf,
  webUrlsOf,
} from './kit.ts';

const h = sharesHarness({ createTestDatabase, acquireTestRedis });

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-15w#2] %s：以分享者身份登记一条新的 share link（pid_scene=share）并实时转链，share_materials 恰好一行（share_url 为转链结果、tpwd 为空、app_id 取自该 link），响应 link_id / share_url 与之一致、tpwd 与 poster_url 为 null；source_link_id 只记来源，原 link 不变',
  async (platform) => {
    const t = await h.tenant();
    const sharer = await t.user();
    const card = cardWith(await sharer.search(platform), true);
    const before = await h.persisted(t.appId);
    expect(before.links.map((row) => row.link_id)).toContain(card.link_id);
    h.clearObservations();

    const data = await expectShared(await sharer.share(bodyOf(card)));
    const after = await h.persisted(t.appId);

    const links = added(before.links, after.links);
    expect(links.map((row) => row.link_id)).toEqual([data.link_id]);
    expect(links[0]).toMatchObject({
      app_id: t.appId,
      user_id: sharer.uid,
      platform,
      product_key: card.product_key,
      scene: 'share',
      pid_scene: 'share',
    });
    expect(links[0]!.identity_snapshot).toMatchObject({ user_id: sharer.uid });
    expect(data.link_id).not.toBe(card.link_id);
    // The source card's link and every other row are exactly as they were.
    expect(after.links.filter((row) => row.link_id !== data.link_id)).toEqual(before.links);

    expect(added(before.materials, after.materials)).toEqual([
      expect.objectContaining({
        app_id: t.appId,
        link_id: data.link_id,
        share_url: data.share_url,
        tpwd: null,
      }),
    ]);
    expect(after.materials.filter((row) => row.link_id !== data.link_id)).toEqual(before.materials);
    expect(data).toMatchObject({ tpwd: null, poster_url: null });

    const converts = h.converts();
    expect(converts).toHaveLength(1);
    expect(converts[0]!.identity).toMatchObject({
      claims: {
        appId: t.appId,
        platform,
        userId: sharer.attrCode,
        promotionSlot: t.pid(platform, 'share'),
      },
    });
    expect(webUrlsOf(converts[0]!.result)).toContain(data.share_url);
  },
  120_000,
);

it('[AC-B1-15w#4] images 只取联盟商品详情返回的图片地址、原样下发、最多 9 张；links、share_materials 都不存图片地址', async () => {
  const t = await h.tenant();
  const sharer = await t.user();
  const card = cardWith(await sharer.search('jd'), true);
  h.clearObservations();
  const data = await expectShared(await sharer.share(bodyOf(card)));
  expect(data.images.length).toBeLessThanOrEqual(9);
  // Nothing is made up: every address is one the union detail of this request returned.
  const returned = textOf(h.items());
  for (const image of data.images) {
    expect(Object.keys(image)).toEqual(['url']);
    expect(returned).toContain(image.url);
  }
  const stored = textOf(await h.persisted(t.appId));
  for (const image of data.images) expect(stored).not.toContain(image.url);
}, 120_000);

it.each([
  ['jd', true],
  ['jd', false],
  ['pdd', true],
  ['pdd', false],
] as const)(
  '[AC-B1-15w#5] %s 有券=%s：copy 按商品实际返回的字段渲染（有券：券后价与取价日期、券前价、券面额；无券：售价写法，无券前价、券面额段），下单链接段即 share_url、无口令段，include_default 只列返回的段，default_text 末行为价格口径说明，文案不带收益金额',
  async (platform, coupon) => {
    const t = await h.tenant();
    const sharer = await t.user();
    const card = cardWith(await sharer.search(platform), coupon);
    const data = await expectShared(await sharer.share(bodyOf(card)));
    expectShareCopy(data.copy, {
      platform,
      title: card.title,
      priceFen: fen(card.price_fen),
      couponFen: fen(card.coupon_fen),
      finalPriceFen: fen(card.final_price_fen),
      quotedAt: new Date(data.quoted_at),
      shareUrl: data.share_url,
      tpwd: null,
    });
  },
  120_000,
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-15w#6] %s：est_promo 是分享者本人 buy_type=share 的报价（经进程报价端口，查看者即分享者），quoted_at 与该报价、新 link 的报价快照同源',
  async (platform) => {
    const t = await h.tenant();
    const sharer = await t.user();
    const card = cardWith(await sharer.search(platform), true);
    h.clearObservations();
    const data = await expectShared(await sharer.share(bodyOf(card)));

    const shareQuotes = h.quotes().filter((call) => {
      const buyType: unknown = call.context?.buyType;
      return buyType === 'share';
    });
    expect(shareQuotes.length).toBeGreaterThan(0);
    const quote = shareQuotes.at(-1)!;
    expect(quote.viewer).toMatchObject({ appId: t.appId, userId: sharer.uid });
    expect(data.est_promo).toEqual({
      rebate_min_fen: Number(quote.result.rebateMinFen),
      rebate_max_fen: Number(quote.result.rebateMaxFen),
      rebate_basis: quote.result.rebateBasis,
    });
    expect(data.est_promo.rebate_min_fen).toBeLessThanOrEqual(data.est_promo.rebate_max_fen);
    expect(Date.parse(data.quoted_at)).toBe(Date.parse(quote.item.quoted_at));
    const row = await h
      .db()
      .selectFrom('links')
      .select('quoted_at')
      .where('app_id', '=', t.appId)
      .where('link_id', '=', data.link_id)
      .executeTakeFirst();
    expect(row?.quoted_at).toBeInstanceOf(Date);
    expect((row!.quoted_at as Date).getTime()).toBe(Date.parse(data.quoted_at));
  },
  120_000,
);

it('[AC-B1-15w#7] 幂等：同一 Idempotency-Key 同体重放返回同一 link_id 与物料、不再转链、不新增 link 与 share_materials；换一个键再进分享页各登记一条新 link，旧 link 与物料不变', async () => {
  const t = await h.tenant();
  const sharer = await t.user();
  const body = bodyOf(cardWith(await sharer.search('jd'), true));
  const key = randomUUID();
  const first = await expectShared(await sharer.share(body, { key }));
  const afterFirst = await h.persisted(t.appId);

  h.clearObservations();
  const replay = await expectShared(await sharer.share(body, { key }));
  expect(replay).toEqual(first);
  expect(h.converts()).toEqual([]);
  expect(await h.persisted(t.appId)).toEqual(afterFirst);

  const second = await expectShared(await sharer.share(body, { key: randomUUID() }));
  expect(second.link_id).not.toBe(first.link_id);
  expect(h.converts()).toHaveLength(1);
  const final = await h.persisted(t.appId);
  expect(added(afterFirst.links, final.links).map((row) => row.link_id)).toEqual([second.link_id]);
  expect(added(afterFirst.materials, final.materials)).toEqual([
    expect.objectContaining({ link_id: second.link_id, share_url: second.share_url }),
  ]);
  expect(final.links.filter((row) => row.link_id !== second.link_id)).toEqual(afterFirst.links);
  expect(final.materials.filter((row) => row.link_id !== second.link_id)).toEqual(
    afterFirst.materials,
  );
}, 120_000);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-15w#8] %s：生成后 GET /v1/share-pages/{link_id} 的 jump_url 即该 share_url、无口令票据；分享页只读不转链，响应里没有 est_promo 与任何返利字段',
  async (platform) => {
    const t = await h.tenant();
    const sharer = await t.user();
    const card = cardWith(await sharer.search(platform), true);
    const data = await expectShared(await sharer.share(bodyOf(card)));
    h.clearObservations();
    const before = await h.persisted(t.appId);
    for (const ua of [UA.safari, UA.wechat]) {
      const response = await h.page(t.appId, data.link_id, ua);
      const page = await pageData(response);
      expect(page).toMatchObject({
        jump_url: data.share_url,
        tpwd_ticket: null,
        product_card: { link_id: data.link_id, platform },
      });
      expect(response.payload).not.toContain('est_promo');
      expect(response.payload).not.toContain('rebate_');
    }
    expect(h.converts()).toEqual([]);
    expect(await h.persisted(t.appId)).toEqual(before);
  },
  120_000,
);
