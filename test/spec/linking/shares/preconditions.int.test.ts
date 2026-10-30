// B1-15w rule tests: who may generate share materials (BR-ATTR-10 细则「分享页与分享赚入口页」范围,
// BR-INV-19, BR-ID-01; contract createShare x-auth phone, x-error-codes). Only a signed-in user with a
// bound phone (10001 / 10005), authorized on the platform (Taobao binding → else 30101 with
// auth_url / state / auth_methods, also when the binding is unbound, pending_auth or invalid;
// Pinduoduo filing → else 30111 with auth_jump) and not an identified minor (verified birth date
// under 18 at the injected clock → 30413 data.reason=self_minor; BR-ID-26: 18 is reached at 00:00
// Beijing of the day after the 18th birthday). A refused request registers no link and writes no
// share_materials row. Cases that refuse for a reason the missing route would also produce prove
// the route first with an allowed request of the same tenant.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  bodyOf,
  cardWith,
  expectRefused,
  expectShared,
  sharesHarness,
  type ProductCard,
} from './kit.ts';

const h = sharesHarness({ createTestDatabase, acquireTestRedis });

function anyCard(cards: readonly ProductCard[]): ProductCard {
  const found = cards.find((card) => card.product_key !== null);
  expect(found).toBeDefined();
  return found!;
}

it('[AC-B1-15w#1] 未登录（不带 Authorization）→ 10001，不登记 link、不写 share_materials', async () => {
  const t = await h.tenant();
  const sharer = await t.user();
  const body = bodyOf(cardWith(await sharer.search('jd'), true));
  await expectShared(await sharer.share(body));
  const before = await h.persisted(t.appId);
  h.clearObservations();
  await expectRefused(await sharer.share(body, { token: null }), 401, 10001);
  expect(await h.persisted(t.appId)).toEqual(before);
  expect(h.converts()).toEqual([]);
}, 120_000);

it('[AC-B1-15w#1] 已登录但未绑手机号 → 10005，不登记 link、不写 share_materials', async () => {
  const t = await h.tenant();
  const bound = await t.user();
  const body = bodyOf(cardWith(await bound.search('jd'), true), false);
  await expectShared(await bound.share(body));
  const unbound = await t.user({ phone: false });
  const before = await h.persisted(t.appId);
  h.clearObservations();
  await expectRefused(await unbound.share(body), 403, 10005);
  expect(await h.persisted(t.appId)).toEqual(before);
  expect(h.converts()).toEqual([]);
}, 120_000);

it('[AC-B1-15w#1] 淘宝未授权（无绑定）→ 30101，带 auth_url、state 与 auth_methods；不登记 link、不写 share_materials', async () => {
  const t = await h.tenant();
  const sharer = await t.user({ taobao: 'absent' });
  const card = anyCard(await sharer.search('taobao'));
  const before = await h.persisted(t.appId);
  h.clearObservations();
  const body = await expectRefused(await sharer.share(bodyOf(card)), 422, 30101);
  expect(body.data).toMatchObject({
    auth_url: expect.any(String),
    state: expect.any(String),
    auth_methods: expect.any(Array),
  });
  expect(await h.persisted(t.appId)).toEqual(before);
  expect(h.converts()).toEqual([]);
}, 120_000);

it.each(['unbound', 'pending_auth', 'invalid'] as const)(
  '[AC-B1-15w#1] 淘宝绑定为 %s（不是 active）→ 30101；不登记 link、不写 share_materials、不转链',
  async (taobao) => {
    const t = await h.tenant();
    const sharer = await t.user({ taobao });
    const card = anyCard(await sharer.search('taobao'));
    const before = await h.persisted(t.appId);
    h.clearObservations();
    await expectRefused(await sharer.share(bodyOf(card)), 422, 30101);
    expect(await h.persisted(t.appId)).toEqual(before);
    expect(h.converts()).toEqual([]);
  },
  120_000,
);

it('[AC-B1-15w#1] 拼多多未备案（无备案记录、联盟查询也答未备案）→ 30111，带 auth_jump；不登记 link、不写 share_materials', async () => {
  const t = await h.tenant();
  const sharer = await t.user({ pdd: 'absent' });
  const card = cardWith(await sharer.search('pdd'), true);
  const before = await h.persisted(t.appId);
  h.refusePddFiling();
  h.clearObservations();
  const body = await expectRefused(await sharer.share(bodyOf(card)), 422, 30111);
  expect(body.data).toHaveProperty('auth_jump');
  expect(await h.persisted(t.appId)).toEqual(before);
  expect(h.converts()).toEqual([]);
}, 120_000);

it('[AC-B1-15w#1] 已识别未满 18 周岁 → 30413 data.reason=self_minor，不登记 link、不写 share_materials', async () => {
  const t = await h.tenant();
  const minor = await t.user({ birthDate: '2012-03-15' });
  const card = cardWith(await minor.search('jd'), true);
  const before = await h.persisted(t.appId);
  h.clearObservations();
  const body = await expectRefused(await minor.share(bodyOf(card)), 422, 30413);
  expect(body.data).toEqual({ reason: 'self_minor' });
  expect(await h.persisted(t.appId)).toEqual(before);
  expect(h.converts()).toEqual([]);
}, 120_000);

it('[AC-B1-15w#1] 满 18 周岁按生日次日 00:00 起算（BR-ID-26，从严）：生日 2008-10-29 今天 00:00 已满 18 可以生成；生日 2008-10-30（今天是 18 岁生日，明天 00:00 才满）→ 30413', async () => {
  const t = await h.tenant();
  // NOW is 2026-10-30 10:00 Beijing (the Asia/Shanghai and UTC dates agree).
  const adult = await t.user({ birthDate: '2008-10-29' });
  const body = bodyOf(cardWith(await adult.search('jd'), true), false);
  await expectShared(await adult.share(body));
  const birthday = await t.user({ birthDate: '2008-10-30' });
  const before = await h.persisted(t.appId);
  h.clearObservations();
  const refused = await expectRefused(await birthday.share(body), 422, 30413);
  expect(refused.data).toEqual({ reason: 'self_minor' });
  expect(await h.persisted(t.appId)).toEqual(before);
  expect(h.converts()).toEqual([]);
}, 120_000);

it('[AC-B1-15w#1] 生日 2-29（BR-ID-26 例）：2008-02-29 生的在 2026-03-01 仍未满 18 → 30413，2026-03-02 00:00 起满 18 可以生成', async () => {
  // 10:00 Beijing on each day: the Asia/Shanghai and UTC dates agree.
  h.clock.set('2026-03-01T02:00:00.000Z');
  const t = await h.tenant();
  const early = await t.user({ birthDate: '2008-02-29' });
  const card = cardWith(await early.search('jd'), true);
  const before = await h.persisted(t.appId);
  h.clearObservations();
  const refused = await expectRefused(await early.share(bodyOf(card, false)), 422, 30413);
  expect(refused.data).toEqual({ reason: 'self_minor' });
  expect(await h.persisted(t.appId)).toEqual(before);
  expect(h.converts()).toEqual([]);

  h.clock.set('2026-03-02T02:00:00.000Z');
  const grown = await t.user({ birthDate: '2008-02-29' });
  const data = await expectShared(
    await grown.share(bodyOf(cardWith(await grown.search('jd'), true), false)),
  );
  const created = await h
    .db()
    .selectFrom('links')
    .select('user_id')
    .where('app_id', '=', t.appId)
    .where('link_id', '=', data.link_id)
    .executeTakeFirst();
  expect(created?.user_id).toBe(grown.uid);
}, 120_000);
