import { expect, it } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import type { TaobaoPriceWarning } from '../../domain/taobao-price.ts';
import type { CallCtx, RegisteredPlatform } from '../../domain/types.ts';
import { DemoUnionAdapter } from './demo-adapter.ts';

// Local unit-test identifiers; synthetic demo data only.
const ctx: CallCtx = { appId: 'unit-app', requestId: 'unit-request', purpose: 'online' };

function adapter(platform: RegisteredPlatform, warnings: TaobaoPriceWarning[] = []) {
  return new DemoUnionAdapter({
    platform,
    seed: 'unit-seed',
    clock: new FixedClock('2031-02-03T04:05:06.789Z'),
    environment: 'test',
    warn: (warning) => warnings.push(warning),
  });
}

it('[AC-B1-04r-UNIT#1] 淘宝普通读价不产生告警，价格场景把告警交给注入的出口', async () => {
  const warnings: TaobaoPriceWarning[] = [];
  const port = adapter('taobao', warnings);
  const page = await port.searchItems({ keyword: '演示' }, ctx);
  expect(page.items.length).toBeGreaterThan(0);
  expect(warnings).toEqual([]);
  const item = page.items[0]!;
  await port.getItem(item, { ...ctx, scenario: 'price_anomaly' });
  expect(warnings).toEqual([{ code: 'PRICE_CALC_DIFF' }]);
  warnings.length = 0;
  await port.getItem(item, { ...ctx, scenario: 'unknown_promo' });
  expect(warnings).toEqual([{ code: 'PRICE_PROMO_UNKNOWN', title: '演示清单外优惠' }]);
});

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-04r-UNIT#2] %s 不接受淘宝专用的价格场景',
  async (platform) => {
    const port = adapter(platform);
    for (const scenario of ['price_anomaly', 'unknown_promo']) {
      await expect(
        port.searchItems({ keyword: '演示' }, { ...ctx, scenario }),
      ).rejects.toMatchObject({ code: 'demo_unknown_scenario' });
    }
  },
);
