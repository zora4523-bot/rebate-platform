import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createCatalog,
  type ReparseResult,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { RECEIVED_AT, claims, corrupt, fixture } from './kit.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

/** Real catalog selector with canned storage reads; DummyDriver never connects anywhere. */
async function rawFixture(hasStored: boolean) {
  const refs = await fixture();
  const clock = new FixedClock(RECEIVED_AT);
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    const rows =
      hasStored && query.sql.includes('"product_refs"')
        ? [
            {
              app_id: claims().appId,
              platform: claims().platform,
              product_key: claims().productKey,
              raw_item_id: 'demo-stored-original',
              raw_fetched_at: RECEIVED_AT,
              refreshed_at: RECEIVED_AT,
              canonical_url: null,
              title: '演示商品',
              shop_id: null,
              shop_type: null,
              source: 'search',
            },
          ]
        : [];
    return { rows: rows as R[] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }).withSchema('app');
  handles.push(db);
  const catalog = createCatalog({ db, clock, warn: vi.fn() });
  const reparse = vi.fn(async (): Promise<ReparseResult> => ({ kind: 'off_shelf' }));
  return { ...refs, clock, catalog, reparse };
}

it.each([0, 1_799_999, 1_800_000])(
  '[AC-B1-05h#13] BR-PROD-05 取得 %i 毫秒的卡片原串优先于更新的存储记录',
  async (age) => {
    const { service, clock, catalog, reparse } = await rawFixture(true);
    const input = claims({ fetchedAt: new Date(clock.now().getTime() - age).toISOString() });
    const itemRef = service.issue(input);
    const requestRef = service.verify({ ...input, itemRef });
    expect(requestRef).toEqual({ ...input, source: 'item_ref' });
    for (const fallbackEnabled of [false, true]) {
      expect(
        await catalog.takeRawItemId({
          ...input,
          requestRef,
          fallbackEnabled,
          capabilities: { parseEnabled: true, searchEnabled: true },
          reparse,
        }),
      ).toEqual({ rawItemId: input.rawItemId, source: 'item_ref' });
    }
    expect(reparse).not.toHaveBeenCalled();
  },
);

it.each([1_800_001, 3_600_000])(
  '[AC-B1-05h#14] BR-PROD-05 签发时已取得 %i 毫秒，不得重新计时挽救过期原串',
  async (age) => {
    const { service, clock, catalog, reparse } = await rawFixture(true);
    const input = claims({ fetchedAt: new Date(clock.now().getTime() - age).toISOString() });
    const requestRef = service.verify({ ...input, itemRef: service.issue(input) });
    expect(requestRef).toEqual({ ...input, source: 'item_ref' });
    const request = {
      ...input,
      requestRef,
      fallbackEnabled: false,
      capabilities: { parseEnabled: true, searchEnabled: true },
      reparse,
    };
    expect(await catalog.takeRawItemId(request)).toEqual({
      rawItemId: 'demo-stored-original',
      source: 'product_refs',
    });
    expect(reparse).not.toHaveBeenCalled();
    await expect(
      catalog.takeRawItemId({ ...request, fallbackEnabled: true }),
    ).rejects.toMatchObject({
      code: 30141,
    });
    expect(reparse).toHaveBeenCalledExactlyOnceWith({
      appId: input.appId,
      platform: input.platform,
      productKey: input.productKey,
    });
  },
);

it('[AC-B1-05h#15] BR-PROD-05 验证同一令牌不延长取得时间，1800 秒后继续后备流程', async () => {
  const { service, clock, catalog, reparse } = await rawFixture(false);
  const input = claims();
  const itemRef = service.issue(input);
  const select = () =>
    catalog.takeRawItemId({
      ...input,
      requestRef: service.verify({ ...input, itemRef }),
      fallbackEnabled: false,
      capabilities: { parseEnabled: true, searchEnabled: true },
      reparse,
    });
  clock.advanceMs(1_800_000);
  expect(await select()).toEqual({ rawItemId: input.rawItemId, source: 'item_ref' });
  expect(reparse).not.toHaveBeenCalled();
  clock.advanceMs(1);
  await expect(select()).rejects.toMatchObject({ code: 30141 });
  expect(reparse).toHaveBeenCalledOnce();
  expect(service.verify({ ...input, itemRef })).toEqual({ ...input, source: 'item_ref' });
});

it.each([true, false])(
  '[AC-B1-05h#16] 无效引用不打断原串选择，存储可用=%s 时继续第②③级',
  async (hasStored) => {
    const { service, catalog, reparse } = await rawFixture(hasStored);
    const input = claims();
    const issued = service.issue(input);
    const cases = [
      null,
      'not-an-item-ref',
      corrupt(issued, 'tag'),
      issued.replace(/^v1\.\d+\./u, 'v1.2147483647.'),
      service.issue(claims({ appId: 'app-item-ref-b', productKey: 'tb:Other' })),
    ];
    for (const itemRef of cases) {
      const requestRef = service.verify({ ...input, itemRef });
      expect(requestRef).toBeNull();
      const result = catalog.takeRawItemId({
        ...input,
        requestRef,
        fallbackEnabled: false,
        capabilities: { parseEnabled: true, searchEnabled: true },
        reparse,
      });
      if (hasStored) {
        expect(await result).toEqual({ rawItemId: 'demo-stored-original', source: 'product_refs' });
      } else {
        await expect(result).rejects.toMatchObject({ code: 30141 });
      }
    }
    expect(reparse).toHaveBeenCalledTimes(hasStored ? 0 : cases.length);
  },
);

it('[AC-B1-05h#17] 过期但认证有效且同应用的不同商品仍须报 20001', async () => {
  const { service } = await fixture();
  const stale = claims({ fetchedAt: '2026-10-01T00:00:00.000Z' });
  const itemRef = service.issue(stale);
  expect(() => service.verify({ ...claims(), productKey: 'tb:Other', itemRef })).toThrowError(
    expect.objectContaining({ code: 20001 }),
  );
});
