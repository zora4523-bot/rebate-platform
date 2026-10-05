import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type {
  RequestRawRef,
  ReparseResult,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { aliases, enabled, instant, rawRequest, reference, setup, START } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
});

it('[AC-B1-05c#16] BR-PROD-05 第一级 item_ref 或 links 在 1800 秒整仍优先于较新 product_refs', async () => {
  const { catalog } = setup(db);
  await catalog.registerProductRef(
    reference({ appId: 'request-first', rawItemId: 'DB-K1' }),
    enabled,
  );
  for (const source of ['item_ref', 'link'] as const) {
    for (const age of [0, 1_799_999, 1_800_000]) {
      const request = rawRequest({
        appId: 'request-first',
        requestRef: {
          appId: 'request-first',
          platform: 'taobao',
          productKey: 'tb:K1',
          rawItemId: 'CARD-K1',
          fetchedAt: instant(-age),
          source,
        },
      });
      expect(await catalog.takeRawItemId(request)).toEqual({ rawItemId: 'CARD-K1', source });
      expect(request.reparse).not.toHaveBeenCalled();
    }
  }
});

it('[AC-B1-05c#17] BR-PROD-05 第一级过期 1ms 后使用 product_refs，第二级按 refreshed_at 判断', async () => {
  const { catalog } = setup(db);
  await catalog.registerProductRef(
    reference({
      appId: 'db-second',
      rawItemId: 'DB-K1',
      receivedAt: instant(-1_800_000),
      rawFetchedAt: instant(-3_600_000),
    }),
    enabled,
  );
  for (const source of ['item_ref', 'link'] as const) {
    const request = rawRequest({
      appId: 'db-second',
      requestRef: {
        appId: 'db-second',
        platform: 'taobao',
        productKey: 'tb:K1',
        rawItemId: 'EXPIRED-K1',
        fetchedAt: instant(-1_800_001),
        source,
      },
    });
    expect(await catalog.takeRawItemId(request)).toEqual({
      rawItemId: 'DB-K1',
      source: 'product_refs',
    });
    expect(request.reparse).not.toHaveBeenCalled();
  }
});

it('[AC-B1-05c#18] BR-PROD-01 第一级不得借用其他应用、平台或商品的原串', async () => {
  const { catalog } = setup(db);
  await catalog.registerProductRef(reference({ appId: 'bound', rawItemId: 'OWN-K1' }), enabled);
  const own: RequestRawRef = {
    appId: 'bound',
    platform: 'taobao',
    productKey: 'tb:K1',
    rawItemId: 'FOREIGN-K1',
    fetchedAt: START,
    source: 'item_ref',
  };
  for (const requestRef of [
    { ...own, appId: 'other' },
    { ...own, platform: 'jd' as const },
    { ...own, productKey: 'tb:Other' },
  ]) {
    const request = rawRequest({ appId: 'bound', requestRef });
    expect(await catalog.takeRawItemId(request)).toEqual({
      rawItemId: 'OWN-K1',
      source: 'product_refs',
    });
    expect(request.reparse).not.toHaveBeenCalled();
  }
});

it('[AC-B1-05c#19] BR-PROD-05 第二级过期 1ms 必须重解析，成功后新原串持久化', async () => {
  const { catalog } = setup(db);
  await catalog.registerProductRef(
    reference({
      appId: 'reparse',
      receivedAt: instant(-1_800_001),
      rawFetchedAt: START,
      rawItemId: 'EXPIRED-K1',
    }),
    enabled,
  );
  const fresh = reference({ appId: 'reparse', source: 'parse', rawItemId: 'NEW-K1' });
  const request = rawRequest({
    appId: 'reparse',
    reparse: vi.fn(async (): Promise<ReparseResult> => ({ kind: 'found', ref: fresh })),
  });
  expect(await catalog.takeRawItemId(request)).toEqual({ rawItemId: 'NEW-K1', source: 'reparse' });
  expect(request.reparse).toHaveBeenCalledExactlyOnceWith({
    appId: 'reparse',
    platform: 'taobao',
    productKey: 'tb:K1',
  });
  expect(await catalog.readProductRef(fresh)).toEqual(fresh);
});

it('[AC-B1-05c#20] BR-PROD-01 本应用缺少引用时重解析，不取其他应用同键原串', async () => {
  const { catalog } = setup(db);
  await catalog.registerProductRef(
    reference({ appId: 'foreign', rawItemId: 'FOREIGN-K1' }),
    enabled,
  );
  const ref = reference({ appId: 'missing', rawItemId: 'OWN-K1', source: 'parse' });
  const request = rawRequest({
    appId: 'missing',
    reparse: vi.fn(async (): Promise<ReparseResult> => ({ kind: 'found', ref })),
  });
  expect(await catalog.takeRawItemId(request)).toEqual({ rawItemId: 'OWN-K1', source: 'reparse' });
  expect(request.reparse).toHaveBeenCalledTimes(1);
});

it('[AC-B1-05c#21] BR-PROD-05 已启用兜底时保留第一级，过期后跳过新鲜 product_refs', async () => {
  const { catalog, clock } = setup(db);
  await catalog.registerProductRef(reference({ appId: 'fallback', rawItemId: 'DB-K1' }), enabled);
  const ref = reference({ appId: 'fallback', source: 'parse', rawItemId: 'REPARSED-K1' });
  const request = rawRequest({
    appId: 'fallback',
    fallbackEnabled: true,
    requestRef: {
      appId: 'fallback',
      platform: 'taobao',
      productKey: 'tb:K1',
      rawItemId: 'CARD-K1',
      fetchedAt: instant(-1_800_000),
      source: 'link',
    },
    reparse: vi.fn(async (): Promise<ReparseResult> => ({ kind: 'found', ref })),
  });
  expect(await catalog.takeRawItemId(request)).toEqual({ rawItemId: 'CARD-K1', source: 'link' });
  expect(request.reparse).not.toHaveBeenCalled();
  clock.advanceMs(1);
  expect(await catalog.takeRawItemId(request)).toEqual({
    rawItemId: 'REPARSED-K1',
    source: 'reparse',
  });
  expect(request.reparse).toHaveBeenCalledTimes(1);
});

it('[AC-B1-05c#22] BR-PROD-05 重解析下架、失效、暂时失败分类明确，均不得返回过期原串', async () => {
  const { catalog } = setup(db);
  const old = reference({
    appId: 'failures',
    receivedAt: instant(-1_800_001),
    rawItemId: 'STALE-K1',
  });
  await catalog.registerProductRef(old, enabled);
  for (const [kind, code] of [
    ['off_shelf', 30141],
    ['ref_expired', 30143],
    ['temporary_failure', 50401],
  ] as const) {
    const request = rawRequest({
      appId: 'failures',
      reparse: vi.fn(async (): Promise<ReparseResult> => ({ kind })),
    });
    await expect(catalog.takeRawItemId(request)).rejects.toMatchObject({ code });
    expect(request.reparse).toHaveBeenCalledTimes(1);
    expect(await catalog.readProductRef(old)).toEqual(old);
  }
});

it('[AC-B1-05c#23] BR-PROD-05 重解析得到其他商品或其他应用/平台，按引用失效且不登记', async () => {
  const { catalog } = setup(db);
  for (const ref of [
    reference({ appId: 'mismatch', productKey: 'tb:K9' }),
    reference({ appId: 'mismatch-other' }),
    reference({ appId: 'mismatch', platform: 'jd', productKey: 'jd:K1' }),
  ]) {
    const request = rawRequest({
      appId: 'mismatch',
      reparse: vi.fn(async (): Promise<ReparseResult> => ({ kind: 'found', ref })),
    });
    await expect(catalog.takeRawItemId(request)).rejects.toMatchObject({ code: 30143 });
    expect(await catalog.readProductRef(ref)).toBeNull();
  }
});

it('[AC-B1-05c#24] BR-PROD-01/05 重解析比较先解析别名，不能误判同一商品失效', async () => {
  const { catalog } = setup(db);
  await aliases(db, ['tb:before', 'tb:after']);
  const ref = reference({
    appId: 'alias-raw',
    productKey: 'tb:after',
    rawItemId: 'X-after',
    source: 'parse',
  });
  const request = rawRequest({
    appId: 'alias-raw',
    productKey: 'tb:before',
    reparse: vi.fn(async (): Promise<ReparseResult> => ({ kind: 'found', ref })),
  });
  expect(await catalog.takeRawItemId(request)).toEqual({ rawItemId: 'X-after', source: 'reparse' });
});

it('[AC-B1-05c#25] BR-PROD-05 注入时钟推进会使第二级过期，不以进程墙钟或访问续期', async () => {
  const { catalog, clock } = setup(db);
  const ref = reference({ appId: 'clock' });
  await catalog.registerProductRef(ref, enabled);
  const request = rawRequest({
    appId: 'clock',
    reparse: vi.fn(async (): Promise<ReparseResult> => ({ kind: 'temporary_failure' })),
  });
  clock.advanceMs(1_800_000);
  expect(await catalog.takeRawItemId(request)).toEqual({
    rawItemId: 'X-K1',
    source: 'product_refs',
  });
  clock.advanceMs(1);
  await expect(catalog.takeRawItemId(request)).rejects.toMatchObject({ code: 50401 });
  expect(request.reparse).toHaveBeenCalledTimes(1);
});

it('[AC-B1-05c#31] BR-PROD-05 重解析抛错也不得兜底使用旧原串', async () => {
  const { catalog } = setup(db);
  const ref = reference({
    appId: 'reparse-throw',
    receivedAt: instant(-1_800_001),
    rawItemId: 'OLD-K1',
  });
  await catalog.registerProductRef(ref, enabled);
  const request = rawRequest({
    appId: ref.appId,
    reparse: vi.fn(async () => {
      throw new Error('reparse unavailable');
    }),
  });
  await expect(catalog.takeRawItemId(request)).rejects.toThrow();
  expect(request.reparse).toHaveBeenCalledTimes(1);
  expect(await catalog.readProductRef(ref)).toEqual(ref);
});

it('[AC-B1-05c#32] BR-PROD-05 重解析返回已过期原串仍须拒绝，不能把登记时刻当作取得时刻', async () => {
  const { catalog } = setup(db);
  const ref = reference({
    appId: 'stale-reparse',
    source: 'parse',
    rawFetchedAt: instant(-1_800_001),
    receivedAt: instant(-1_800_001),
  });
  const request = rawRequest({
    appId: ref.appId,
    reparse: vi.fn(async (): Promise<ReparseResult> => ({ kind: 'found', ref })),
  });
  await expect(catalog.takeRawItemId(request)).rejects.toThrow();
  expect(request.reparse).toHaveBeenCalledTimes(1);
});
