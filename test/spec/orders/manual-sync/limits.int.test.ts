import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { DAY, ok, setup, type Limits } from './kit.ts';

const h = useHarness();
// 02 §7.1 table: the farthest look-back of each platform; 01 F-ORD-10: at most 50 order numbers.
const LOOK_BACK_DAYS: Record<string, number> = { taobao: 90, jd: 30, pdd: 90 };

it('[AC-B1-09i#30] limits 每个可同步平台一项：earliest_from 为注入时钟减最远回扫范围，max_order_nos=50；读不写审计', async () => {
  const s = await setup(h);
  const audits = await s.audits();
  const limits = await ok<Limits>(await s.limits(), 'limits');
  const platforms = limits.items.map((item) => item.platform);
  expect(platforms).toContain('pdd');
  expect(new Set(platforms).size).toBe(platforms.length);
  // The fixture clock is fixed days before the wall clock: a wall-clock bound falls outside.
  const now = s.f.clock.now().getTime();
  for (const item of limits.items) {
    expect(Object.keys(LOOK_BACK_DAYS)).toContain(item.platform);
    expect(item.max_order_nos).toBe(50);
    const range = LOOK_BACK_DAYS[item.platform]! * DAY;
    const earliest = Date.parse(item.earliest_from);
    expect(earliest).toBeLessThanOrEqual(now - range);
    expect(earliest).toBeGreaterThan(now - range - DAY);
  }
  expect(await s.audits()).toEqual(audits);
});
