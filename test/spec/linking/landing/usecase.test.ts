import { expect, it, vi } from 'vitest';
import {
  createLinkLanding,
  type LandingLink,
} from '../../../../apps/api/src/modules/linking/application/link-landing.ts';
import {
  APP,
  DEVICE,
  LINK,
  MISSING,
  OTHER,
  OTHER_APP,
  OWNER,
  QUOTED,
  TRACE,
  expectPrivateFieldsAbsent,
  fullCard,
  landingData,
  snapshot,
  validate,
} from './kit.ts';

function fixture(link: LandingLink | null, userId: string | null) {
  const current = vi.fn(async () => ({ appId: APP, userId, deviceId: DEVICE }));
  const find = vi.fn(async (_appId: string, linkId: string) =>
    link?.link_id === linkId ? structuredClone(link) : null,
  );
  const read = vi.fn(async (row: LandingLink) => fullCard(row));
  const service = createLinkLanding({
    callerContext: { current },
    links: { find },
    cards: { read },
  });
  return { service, find, read };
}

it.each([
  ['share', 'share', null, 'share', false],
  ['share', 'share', OWNER, 'share', true],
  ['share', 'share', OTHER, 'share', false],
  ['search', 'self_buy', OWNER, 'other', false],
  ['detail', 'self_buy', OTHER, 'other', false],
  ['agent', 'agent', OWNER, 'other', false],
  ['taolijin', 'taolijin', OWNER, 'other', false],
  ['clipboard', 'self_buy', null, 'other', false],
] as const)(
  '[AC-B1-06j#1] %s/%s，查看者 %s：分类 %s、分享者提示 %s；查看不执行 open 归属规则',
  async (scene, pidScene, userId, kind, isSharer) => {
    const link = snapshot({ scene, pid_scene: pidScene });
    link.identity_snapshot = { user_id: OWNER, platform: 'jd', pid_scene: pidScene };
    const before = structuredClone(link);
    const f = fixture(link, userId);
    const result = await f.service.get({ linkId: LINK, traceId: TRACE });
    expect(result.status).toBe(200);
    await validate(result.envelope, 'LinkLandingResponse');
    const data = landingData(result.envelope);
    expect(data).toMatchObject({ link_kind: kind, viewer_is_sharer: isSharer, quoted_at: QUOTED });
    expect(data.product_card.link_id).toBe(LINK);
    expectPrivateFieldsAbsent(data.product_card);
    expect(f.find).toHaveBeenCalledWith(APP, LINK);
    expect(link).toEqual(before);
  },
);

it('[AC-B1-06j#2] 卡片严格采用共享子集，保留商品信息，不泄露返利、返后价或 Agent 字段', async () => {
  const link = snapshot();
  const f = fixture(link, OWNER);
  // Unknown future rebate fields must not leak through a blacklist of current fields.
  const card = { ...fullCard(link), rebate_future_fen: 999 };
  f.read.mockResolvedValue(card);
  const result = await f.service.get({ linkId: LINK, traceId: TRACE });
  expect(result.status).toBe(200);
  await validate(result.envelope, 'LinkLandingResponse');
  const data = landingData(result.envelope);
  expect(data.quoted_at).toBe(QUOTED);
  expect(data.product_card).toEqual({
    product_key: link.product_key,
    item_ref: card.item_ref,
    platform: 'jd',
    title: card.title,
    image: card.image,
    shop_type: null,
    shop_name: card.shop_name,
    price_fen: 12000,
    coupon_fen: 2000,
    final_price_fen: 10000,
    benefit_tags: ['有券'],
    is_presale: false,
    link_id: LINK,
    stale: true,
    age_sec: 89879,
    source: 'jd_union',
    disclaimer_keys: ['price_basis'],
    availability: 'ok',
  });
  expectPrivateFieldsAbsent(data.product_card);
});

it('[AC-B1-06j#3] 未知报价的游客 link 可查看，quoted_at 保留 null 且不认领 link', async () => {
  const link = snapshot({
    scene: 'clipboard',
    pid_scene: 'self_buy',
    user_id: null,
    identity_snapshot: { user_id: null, platform: 'pdd', pid_scene: 'self_buy' },
    platform: 'pdd',
    product_key: null,
    raw_item_id: null,
    raw_fetched_at: null,
    quoted_at: null,
    quoted_final_price_fen: null,
    quoted_coupon_fen: null,
  });
  const f = fixture(link, OWNER);
  f.read.mockResolvedValue({
    ...fullCard(link),
    platform: 'pdd',
    product_key: null,
    item_ref: null,
    price_fen: null,
    coupon_fen: null,
    final_price_fen: null,
    rebate_min_fen: null,
    rebate_max_fen: null,
    est_net_price_fen: null,
    rebate_basis: 'amount_unknown',
    availability: 'unknown',
    quoted_at: null,
    source: 'pdd_union',
    age_sec: null,
  });
  const result = await f.service.get({ linkId: LINK, traceId: TRACE });
  expect(result.status).toBe(200);
  await validate(result.envelope, 'LinkLandingResponse');
  expect(landingData(result.envelope)).toMatchObject({
    link_kind: 'other',
    viewer_is_sharer: false,
    quoted_at: null,
    product_card: { link_id: LINK, product_key: null, final_price_fen: null },
  });
  expect(link.user_id).toBeNull();
});

it('[AC-B1-06j#4] 不存在与跨 App link 都为相同的 30144，且不读取商品卡片', async () => {
  const absent = fixture(null, null);
  const foreign = fixture(snapshot({ app_id: OTHER_APP }), null);
  const a = await absent.service.get({ linkId: MISSING, traceId: TRACE });
  const b = await foreign.service.get({ linkId: LINK, traceId: TRACE });
  expect(a).toMatchObject({ status: 404, envelope: { code: 30144, trace_id: TRACE } });
  expect(b).toEqual(a);
  await validate(a.envelope, 'ErrorEnvelope');
  expect(absent.read).not.toHaveBeenCalled();
  expect(foreign.read).not.toHaveBeenCalled();
});
