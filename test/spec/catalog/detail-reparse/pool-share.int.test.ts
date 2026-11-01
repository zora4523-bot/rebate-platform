// B1-05w 编排第 7 条: the pool add and the pool refresh re-parse through the same code as the detail,
// so they take 重新解析步骤 3's limit too. Each purpose keeps its own quota, and a call that hangs no
// longer holds the pool's read. createPoolSource as the admin route and the refresh handler build
// it, over real rows and the fake union of ./kit.ts; a hung union shows up as an assertion on how
// the call ended, so the case fails on the old code without timing out.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createCatalog } from '../../../../apps/api/src/modules/catalog/application/catalog.ts';
import { createPoolSource } from '../../../../apps/api/src/modules/catalog/application/pool-source.ts';
import { createUnionDetailUpstream } from '../../../../apps/api/src/modules/catalog/infra/detail-wiring.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { NOW, PRODUCT_KEY } from '../detail/kit.ts';
import {
  TIMEOUT,
  configOf,
  seedRef,
  secondsAgo,
  tenant,
  usePoolDatabase,
} from '../product-pool-read/kit.ts';
import {
  CANONICAL_URL,
  NEW_RAW,
  STORED_TITLE,
  hang,
  unionFake,
  waitedOut,
  type UnionFake,
} from './kit.ts';
import { AGED_SEC, STABLE } from './rows-kit.ts';

const h = usePoolDatabase(createTestDatabase);

async function sourceCase(purpose: 'online' | 'pool_refresh', canonicalUrl: string | null) {
  const clock = new FixedClock(NOW);
  const fake: UnionFake = unionFake();
  const owner = await tenant(h.db);
  const aged = secondsAgo(clock, AGED_SEC);
  await seedRef(h.db, owner, clock, STABLE, {
    title: STORED_TITLE,
    canonical_url: canonicalUrl,
    raw_fetched_at: aged,
    refreshed_at: aged,
  });
  const source = createPoolSource({
    clock,
    config: configOf(new Map()),
    catalog: createCatalog({ db: h.db, clock, warn: () => undefined }),
    itemRefs: { read: () => null },
    union: fake.union,
    upstream: createUnionDetailUpstream({ union: fake.union, purpose }),
    links: {
      candidates: () => [],
      parse: () => Promise.reject(new Error('pool-share: no link is parsed here')),
    },
    purpose,
  });
  const current = () =>
    source.current({
      appId: owner.appId,
      platform: 'taobao',
      productKey: PRODUCT_KEY,
      title: STORED_TITLE,
    });
  const refRow = () =>
    h.db
      .selectFrom('product_refs')
      .selectAll()
      .where('app_id', '=', owner.appId)
      .where('product_key', '=', PRODUCT_KEY)
      .executeTakeFirstOrThrow();
  return { ...fake, owner, current, refRow };
}

it.each(['online', 'pool_refresh'] as const)(
  '[B1-05w#54][BR-PROD-05] 编排第 7 条：入库与刷新共用重解析：%s 用途的标题搜索不返回 → 3 秒超时按 50401，用途不变',
  async (purpose) => {
    const f = await sourceCase(purpose, null);
    f.searchItems.mockImplementation(hang);

    const ended = await waitedOut(f.current);

    expect(ended).toMatchObject({ state: 'rejected', error: { code: 50401 } });
    expect(f.searchItems.mock.calls[0]?.[1]).toMatchObject({ appId: f.owner.appId, purpose });
  },
  TIMEOUT,
);

it.each(['online', 'pool_refresh'] as const)(
  '[B1-05w#55][BR-PROD-05] 编排第 7 条：入库与刷新共用重解析：%s 用途的链接解析不返回 → 3 秒超时按 50401，用途不变',
  async (purpose) => {
    const f = await sourceCase(purpose, CANONICAL_URL);
    f.resolveLink.mockImplementation(hang);

    const ended = await waitedOut(f.current);

    expect(ended).toMatchObject({ state: 'rejected', error: { code: 50401 } });
    expect(f.resolveLink.mock.calls[0]?.[1]).toMatchObject({ appId: f.owner.appId, purpose });
  },
  TIMEOUT,
);

it.each(['online', 'pool_refresh'] as const)(
  '[B1-05w#69][BR-PROD-05] 编排第 7 条：%s 用途超时不动行，重试解析成功写 source=pool，共用代码不把来源写成 detail',
  async (purpose) => {
    const f = await sourceCase(purpose, null);
    const before = await f.refRow();
    f.searchItems.mockImplementationOnce(hang);

    expect(await waitedOut(f.current)).toMatchObject({
      state: 'rejected',
      error: { code: 50401 },
    });
    expect(await f.refRow()).toEqual(before);

    expect(await f.current()).toMatchObject({ kind: 'live', rawItemId: NEW_RAW });
    expect(await f.refRow()).toMatchObject({ raw_item_id: NEW_RAW, source: 'pool' });
  },
  TIMEOUT,
);
