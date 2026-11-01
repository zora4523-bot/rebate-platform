// B1-06zd rule tests: a Taobao share that cannot get our promotion link or tpwd generates nothing
// (D10-510, BR-ATTR-10): the transaction rolls back, no link, no material, never the original link
// instead.
// The refusal codes are the existing conversionRefusal's; adapter_unimplemented (the Taobao adapter
// on its default baichuan source) is 50301 not_launched. Each case makes the conversion really
// happen, so its refusal is the conversion's answer and not a check before it.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { UnionError, type UnionErrorCode } from '../../../../apps/api/src/modules/union/index.ts';
import { bodyOf, expectRefused, expectShared } from '../shares/kit.ts';
import {
  COUPON_CLICK_URL,
  SHARE_SWITCH,
  SHORT_URL,
  cardOf,
  promoHarness,
  promotion,
  type PromoTenant,
} from './kit.ts';

const h = promoHarness({ createTestDatabase, acquireTestRedis });
const ON = { [SHARE_SWITCH]: true };
const FORBIDDEN = ['link_id', 'share_url', 'tpwd', 'copy', 'images', 'est_promo'];
const TOO_LONG = `https://s.click.example.test/t?e=${'a'.repeat(2048)}`;
const ORIGINAL = 'https://item.example.test/item.htm?id=synthetic-original';

function expectNoMaterial(body: { readonly data?: Readonly<Record<string, unknown>> }): void {
  for (const field of FORBIDDEN) expect(body.data ?? {}).not.toHaveProperty(field);
}

/** A sharer of the App generates a share: the App really converts Taobao shares. */
async function converts(t: PromoTenant): Promise<void> {
  const sharer = await t.user();
  await expectShared(await sharer.share(bodyOf(cardOf(await sharer.search('taobao')))));
  expect(h.conversions()).toHaveLength(1);
  h.clearConversions();
}

it.each([
  { code: 'upstream_rejected', status: 422, result: 30121 },
  { code: 'item_unavailable', status: 422, result: 30141 },
  { code: 'upstream_unavailable', status: 503, result: 50303 },
  { code: 'rate_limited', status: 503, result: 50303 },
] satisfies { code: UnionErrorCode; status: number; result: number }[])(
  '[AC-B1-06zd#8] 转链失败 $code → $result，整次回滚：不登记 link、不写 share_materials、不给原链接',
  async ({ code, status, result }) => {
    const t = await h.tenant(ON);
    const sharer = await t.user();
    const card = cardOf(await sharer.search('taobao'));
    const before = await h.persisted(t.appId);
    h.failConversion(new UnionError(code, 'synthetic conversion failure', 'taobao'));

    const body = await expectRefused(await sharer.share(bodyOf(card)), status, result);

    expect(h.conversions()).toHaveLength(1);
    expectNoMaterial(body);
    expect(await h.persisted(t.appId)).toEqual(before);
  },
  120_000,
);

it('[AC-B1-06zd#9] 转链未实现（默认数据源）adapter_unimplemented → 50301 not_launched，整次回滚', async () => {
  const t = await h.tenant(ON);
  const sharer = await t.user();
  const card = cardOf(await sharer.search('taobao'));
  const before = await h.persisted(t.appId);
  h.failConversion(new UnionError('adapter_unimplemented', 'synthetic', 'taobao'));

  const body = await expectRefused(await sharer.share(bodyOf(card)), 503, 50301);

  expect(h.conversions()).toHaveLength(1);
  expect(body.data).toMatchObject({ reason: 'not_launched', platform: 'taobao' });
  expectNoMaterial(body);
  expect(await h.persisted(t.appId)).toEqual(before);
}, 120_000);

it.each([
  {
    label: '百川形态（没有推广链接）',
    result: {
      kind: 'baichuan' as const,
      item: { platform: 'taobao' as const, item_id: 'synthetic-item' },
      promotionSlot: 'mm_1001_2002_3003',
      relationId: 'synthetic-relation',
    },
  },
  {
    label: '只有 url、没有 short_url 与 coupon_click_url',
    result: { kind: 'url' as const, url: ORIGINAL },
  },
  { label: '两个链接都超长', result: promotion({ short: TOO_LONG, coupon: TOO_LONG }) },
])(
  '[AC-B1-06zd#10] $label：取不到推广链接 → 50303，整次回滚，不以原链接代替',
  async ({ result }) => {
    const t = await h.tenant(ON);
    const sharer = await t.user();
    const card = cardOf(await sharer.search('taobao'));
    const before = await h.persisted(t.appId);
    h.answer(() => result);

    const response = await sharer.share(bodyOf(card));
    const body = await expectRefused(response, 503, 50303);

    expect(h.conversions()).toHaveLength(1);
    expectNoMaterial(body);
    expect(response.payload).not.toContain(ORIGINAL);
    expect(await h.persisted(t.appId)).toEqual(before);
  },
  120_000,
);

it('[AC-B1-06zd#4] BR-ATTR-10：转链成功但没有 tpwd → 50303，不生成淘宝分享：link、share_materials 都不留，什么都不写', async () => {
  const t = await h.tenant(ON);
  const sharer = await t.user();
  const card = cardOf(await sharer.search('taobao'));
  const before = await h.persisted(t.appId);
  h.answer(() => promotion({ tpwd: null }));

  const response = await sharer.share(bodyOf(card));
  const body = await expectRefused(response, 503, 50303);

  expect(h.conversions()).toHaveLength(1);
  expectNoMaterial(body);
  expect(response.payload).not.toContain(SHORT_URL);
  expect(response.payload).not.toContain(COUPON_CLICK_URL);
  expect(await h.persisted(t.appId)).toEqual(before);
}, 120_000);

it('[AC-B1-06zd#11] 分享者没有 active 绑定 → 30101，不调转链', async () => {
  const t = await h.tenant(ON);
  await converts(t);
  const sharer = await t.user({ taobao: 'absent' });
  const card = cardOf(await sharer.search('taobao'));
  const before = await h.persisted(t.appId);

  await expectRefused(await sharer.share(bodyOf(card)), 422, 30101);

  expect(h.conversions()).toEqual([]);
  expect(await h.persisted(t.appId)).toEqual(before);
}, 120_000);

it('[AC-B1-06zd#12] BR-ATTR-06：active 绑定没有可用 relation_id → 50301，不调转链、不用别的身份代替', async () => {
  const t = await h.tenant(ON);
  await converts(t);
  const sharer = await t.user({ relationId: null });
  const card = cardOf(await sharer.search('taobao'));
  const before = await h.persisted(t.appId);

  await expectRefused(await sharer.share(bodyOf(card)), 503, 50301);

  expect(h.conversions()).toEqual([]);
  expect(await h.persisted(t.appId)).toEqual(before);
}, 120_000);
