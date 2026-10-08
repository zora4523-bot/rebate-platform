import { afterEach, expect, it, vi } from 'vitest';
import { CatalogError } from '../../../../apps/api/src/modules/catalog/index.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { fixture, observed } from '../search/kit.ts';

afterEach(() => vi.restoreAllMocks());

it('[AC-B1-05g#21] 物料业务与依赖错误仍为空列表，程序缺陷必须传播为失败', async () => {
  vi.spyOn(platform, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic',
    channels: [
      {
        platform: 'taobao',
        channel_id: 'synthetic-feed',
        name: 'synthetic',
        sort_basis: 'sales',
        selectable: true,
        source: 'synthetic',
      },
    ],
  });
  const f = fixture();
  for (const failure of [
    new UnionError('item_unavailable', 'synthetic delisted', 'taobao'),
    new UnionError('upstream_rejected', 'synthetic refusal', 'taobao'),
    new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'),
    new UnionError('rate_limited', 'synthetic throttled', 'taobao'),
    new CatalogError(30131, 'synthetic unsupported'),
    ...(['invalid_policy', 'timeout', 'circuit_open', 'quota_exceeded'] as const).map(
      (code) => new platform.GovernanceError(code, 'union.materialFeed', 'synthetic governance'),
    ),
  ]) {
    f.materialFeed.mockRejectedValue(failure);
    expect(await observed(() => f.run())).toMatchObject({
      kind: 'returned',
      value: { items: [], fallback_items: [] },
    });
  }
  const defect = new TypeError('synthetic programming defect');
  f.materialFeed.mockRejectedValue(defect);
  const result = await observed(() => f.run());
  // Compare only the discriminant first: red-check must see an assertion, not an uncaught defect.
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') expect(result.error).toBe(defect);
  expect(f.register).not.toHaveBeenCalled();
});
