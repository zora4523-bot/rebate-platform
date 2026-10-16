import { expect, it } from 'vitest';
import {
  createCardAssembler,
  type CardRebateQuoter,
} from '../../../../apps/api/src/modules/catalog/application/card-assembler.ts';
import { APP, item, plan, version, viewer, wiringFixture, withOpenReads } from './kit.ts';

// BR-CALC-20: each open selects from the versions in force at its own pre-read instant.
// Keep the published list unchanged: only Clock moves, so neither assembly-time nor
// first-open-time filtering may hide a version from a later open.
function publishedVersions() {
  const v1 = version();
  const v3 = version({
    rule_version_id: '00000000-0000-4000-8000-000000000003',
    effective_from: new Date('2026-11-01T00:00:00+08:00'),
    rules: v1.rules.map((row) => ({ ...row, r_own_bp: 4500 })),
  });
  const v4 = version({
    rule_version_id: '00000000-0000-4000-8000-000000000004',
    effective_from: new Date('2026-12-01T00:00:00+08:00'),
    rules: v1.rules.map((row) => ({ ...row, r_own_bp: 4000 })),
  });
  return { v1, v3, v4 };
}

function cards(f: ReturnType<typeof wiringFixture>, quoter: CardRebateQuoter) {
  const assembler = createCardAssembler({
    clock: f.clock,
    quoter,
    viewerContext: { current: async () => viewer({ userId: 'viewer-l1' }) },
    registrar: { register: async () => ({ linkId: 'synthetic-prepare-instant-link' }) },
    sourceLinks: { entrySource: async () => 'search' },
    itemRefs: { issue: () => 'synthetic-prepare-instant-item-ref' },
  });
  return (entrySource: 'pool' | 'search') => {
    // JD has the same self quote for both entry sources, without a compare range.
    const product = item({ platform: 'jd', quoted_at: f.clock.now().toISOString() });
    return assembler.assemble({
      item: product,
      ref: {
        appId: APP,
        platform: 'jd',
        productKey: 'jd:synthetic-prepare-instant',
        rawItemId: 'synthetic-product',
        rawFetchedAt: product.quoted_at,
        receivedAt: product.quoted_at,
        canonicalUrl: null,
        title: product.title,
        shopId: null,
        shopType: null,
        source: entrySource,
      },
      entrySource,
      stale: false,
    });
  };
}

it('[AC-B2-03d#17] 装配后才生效的 v3 在首次开放可见，复核卡与同刻开放外搜索卡均报 450 分', async () => {
  const f = wiringFixture();
  f.clock.set('2026-10-01T00:00:00+08:00');
  const { v1, v3, v4 } = publishedVersions();
  f.versions.set(APP, [v1, v3, v4]);
  const { quoter, ports, options, prepare } = await f.live();
  const card = cards(f, quoter);
  expect(await card('search')).toMatchObject({ rebate_min_fen: 500, rebate_max_fen: 500 });

  f.clock.set('2026-11-02T00:00:00+08:00');
  f.publishedVersions.mockClear();
  await withOpenReads(
    () => ports.quoteReads.prepare(plan({ platform: 'jd', callerUserId: 'viewer-l1' })),
    async () => {
      expect(await options.rules.publishedVersions(APP)).toEqual([v1, v3]);
      f.levelOf.mockClear();
      f.configValue.mockClear();
      expect(await card('pool')).toMatchObject({ rebate_min_fen: 450, rebate_max_fen: 450 });
      expect(f.publishedVersions).toHaveBeenCalledExactlyOnceWith(APP);
      expect(f.levelOf).not.toHaveBeenCalled();
      expect(f.configValue).not.toHaveBeenCalled();
    },
  );
  expect(await card('search')).toMatchObject({ rebate_min_fen: 450, rebate_max_fen: 450 });
  expect(f.publishedVersions).toHaveBeenCalledTimes(2);
  expect(prepare).not.toHaveBeenCalled();
});

it('[AC-B2-03d#18] 同一装配两次开放之间跨过 v4 生效点，第二次重新取预读时刻并报 400 分', async () => {
  const f = wiringFixture();
  f.clock.set('2026-10-01T00:00:00+08:00');
  const { v1, v3, v4 } = publishedVersions();
  f.versions.set(APP, [v1, v3, v4]);
  const { quoter, ports, options, prepare } = await f.live();
  const card = cards(f, quoter);

  for (const [at, visible, expected] of [
    ['2026-11-02T00:00:00+08:00', [v1, v3], 450],
    ['2026-12-02T00:00:00+08:00', [v1, v3, v4], 400],
  ] as const) {
    f.clock.set(at);
    f.publishedVersions.mockClear();
    await withOpenReads(
      () => ports.quoteReads.prepare(plan({ platform: 'jd', callerUserId: 'viewer-l1' })),
      async () => {
        expect(await options.rules.publishedVersions(APP)).toEqual(visible);
        f.levelOf.mockClear();
        f.configValue.mockClear();
        expect(await card('pool')).toMatchObject({
          rebate_min_fen: expected,
          rebate_max_fen: expected,
        });
        expect(f.publishedVersions).toHaveBeenCalledExactlyOnceWith(APP);
        expect(f.levelOf).not.toHaveBeenCalled();
        expect(f.configValue).not.toHaveBeenCalled();
      },
    );
    expect(await card('search')).toMatchObject({
      rebate_min_fen: expected,
      rebate_max_fen: expected,
    });
    expect(f.publishedVersions).toHaveBeenCalledTimes(2);
  }
  expect(prepare).not.toHaveBeenCalled();
});
