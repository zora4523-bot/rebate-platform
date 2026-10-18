import { expect, it } from 'vitest';
import { matchOrderSource } from '../../../../apps/api/src/modules/orders/index.ts';
import { at, input, log, matched, NONE } from './kit.ts';

it('[AC-B1-08j#1] exact 优先于 product/shop，不要求点击或商品相同', () => {
  const exactLink = {
    link_id: 'exact-link',
    user_id: 'user-U',
    scene: 'share',
    agent_session_id: null,
  };
  expect(matchOrderSource(input({ exactLink }))).toEqual({
    source_match: 'exact',
    link_id: 'exact-link',
    source_scene: 'share',
    agent_session_id: null,
  });
  expect(
    matchOrderSource(input({ exactLink, candidates: [], productKey: null, shopId: null })),
  ).toEqual({
    source_match: 'exact',
    link_id: 'exact-link',
    source_scene: 'share',
    agent_session_id: null,
  });
});

it.each(['other-user', null])('[AC-B1-08j#2] exact 属于 %s 则继续 product', (user_id) => {
  expect(matchOrderSource(input({ exactLink: { ...log(), link_id: 'exact', user_id } }))).toEqual(
    matched(log()),
  );
});

it('[AC-B1-08j#3] product 优先于较新的 shop，按时间取最新而非最大 id', () => {
  const older = log({ id: 99n, created_at: at('2026-10-16T13:14:15+08:00') });
  const newer = log({ id: 2n, link_id: 'new-product' });
  const shop = log({
    id: 100n,
    product_key: 'other',
    link_id: 'new-shop',
    created_at: at('2026-10-19T13:14:15+08:00'),
  });
  expect(matchOrderSource(input({ candidates: [shop, newer, older] }))).toEqual(matched(newer));
});

it.each(['jd', 'pdd', 'taobao'] as const)(
  '[AC-B1-08j#4] %s 支持 shop，商品不匹配仍可同店匹配',
  (platform) => {
    const row = log({
      platform,
      product_key: 'different',
      scene: 'search',
      agent_session_id: null,
    });
    expect(matchOrderSource(input({ platform, candidates: [row] }))).toEqual(matched(row, 'shop'));
  },
);

it('[AC-B1-08j#5] 无匹配清空三个来源字段，不能把两个空商品或空店铺当相同', () => {
  expect(matchOrderSource(input({ candidates: [] }))).toEqual(NONE);
  expect(
    matchOrderSource(
      input({
        productKey: null,
        shopId: null,
        candidates: [log({ product_key: null, shop_id: null })],
      }),
    ),
  ).toEqual(NONE);
  expect(
    matchOrderSource(input({ candidates: [log({ product_key: 'other', shop_id: 'other' })] })),
  ).toEqual(NONE);
});

it.each(['product', 'shop'] as const)(
  '[AC-B1-08j#6] %s 同刻用 bigint id 降序，不经浮点转换',
  (kind) => {
    const low = log({ id: 9007199254740992n, link_id: 'low' });
    const high = log({ id: 9007199254740993n, link_id: 'high' });
    for (const candidates of [
      [high, low],
      [low, high],
    ]) {
      expect(
        matchOrderSource(input({ candidates, productKey: kind === 'shop' ? null : 'pdd:123' })),
      ).toEqual(matched(high, kind));
    }
  },
);

it('[AC-B1-08j#7] BR-ATTR-15 原例：10-18 Agent S7 胜过搜索与 precompute S8', () => {
  const rows = [
    log({
      id: 1n,
      platform: 'taobao',
      product_key: 'tb:123',
      scene: 'search',
      pid_scene: 'self_buy',
      created_at: at('2026-10-10T12:00:00+08:00'),
      event: 'convert',
    }),
    log({
      id: 2n,
      platform: 'taobao',
      product_key: 'tb:123',
      link_id: 'agent-card',
      created_at: at('2026-10-18T12:00:00+08:00'),
      agent_session_id: 'S7',
    }),
    log({
      id: 3n,
      platform: 'taobao',
      product_key: 'tb:123',
      scene: 'search',
      pid_scene: 'self_buy',
      created_at: at('2026-10-19T10:00:00+08:00'),
      event: 'convert',
    }),
    log({
      id: 4n,
      platform: 'taobao',
      product_key: 'tb:123',
      event: 'precompute',
      created_at: at('2026-10-19T11:00:00+08:00'),
      agent_session_id: 'S8',
    }),
  ];
  expect(
    matchOrderSource(input({ platform: 'taobao', productKey: 'tb:123', candidates: rows })),
  ).toEqual({
    source_match: 'product',
    link_id: 'agent-card',
    source_scene: 'agent',
    agent_session_id: 'S7',
  });
});

it('[AC-B1-08j#8] BR-ATTR-12 原例：10-01 Agent、10-03 搜索后付款，自购位取 search', () => {
  const search = log({
    platform: 'taobao',
    product_key: 'tb:123',
    scene: 'search',
    pid_scene: 'self_buy',
    agent_session_id: null,
    created_at: at('2026-10-03T10:00:00+08:00'),
  });
  const agent = log({
    platform: 'taobao',
    product_key: 'tb:123',
    created_at: at('2026-10-01T11:00:00+08:00'),
  });
  expect(
    matchOrderSource(
      input({
        platform: 'taobao',
        productKey: 'tb:123',
        pidScene: 'self_buy',
        attrAt: at('2026-10-03T12:00:00+08:00'),
        candidates: [agent, search],
      }),
    ),
  ).toEqual(matched(search));
});

it('[AC-B1-08j#9] 纯匹配不改输入或候选顺序，null 来源按原样传递', () => {
  const row = Object.freeze(log({ link_id: null, scene: null, agent_session_id: null }));
  const request = Object.freeze(input({ candidates: Object.freeze([row]) }));
  const before = structuredClone(request);
  expect(matchOrderSource(request)).toEqual(matched(row));
  expect(request).toEqual(before);
});
