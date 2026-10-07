import { expect, it } from 'vitest';
import {
  buildDefaultLinkJump,
  noRebateProductUrl,
} from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { EXPIRES } from './kit.ts';

// Independent oracle transcribed from SPEC_REF BR-ATTR-27, lines 792–796.
// Paths are unmistakable synthetic values, not platform payloads or verified launch evidence.
const paths = {
  scheme: 'synthetic://example.test/buy',
  universalLink: 'https://example.test/universal',
  h5: 'https://example.test/browser',
};
const s = { type: 'scheme', value: paths.scheme };
const u = { type: 'universal_link', value: paths.universalLink };
const h = { type: 'h5', value: paths.h5 };
const rows = [
  { platform: 'jd', client: 'ios', installed: 'true', steps: [s, u, h] },
  { platform: 'jd', client: 'android', installed: 'true', steps: [s, u, h] },
  { platform: 'jd', client: 'harmony', installed: 'true', steps: [s, h] },
  { platform: 'pdd', client: 'ios', installed: 'true', steps: [s, h] },
  { platform: 'pdd', client: 'android', installed: 'true', steps: [s, h] },
  { platform: 'pdd', client: 'harmony', installed: 'true', steps: [s, h] },
] as const;

it.each(rows)('[AC-B1-06e#9] BR-ATTR-27 默认矩阵 $platform × $client：已装按指定顺序', (row) => {
  const result = buildDefaultLinkJump({ ...row, paths, expireAt: EXPIRES });
  expect([result.primary, ...result.fallbacks]).toEqual(row.steps);
  expect(result.expire_at).toBe(EXPIRES);
});

it.each(rows)(
  '[AC-B1-06e#10] BR-ATTR-27 $platform × $client：未安装直接走浏览器，不先试 scheme',
  (row) => {
    const result = buildDefaultLinkJump({ ...row, installed: 'false', paths, expireAt: EXPIRES });
    expect([result.primary, ...result.fallbacks]).toEqual([h]);
  },
);

it.each(rows)(
  '[AC-B1-06e#11] BR-ATTR-27 $platform × $client：unknown/缺省保留已装顺序并以未装路径收尾',
  (row) => {
    for (const installed of ['unknown', undefined] as const) {
      const result = buildDefaultLinkJump({
        platform: row.platform,
        client: row.client,
        ...(installed === undefined ? {} : { installed }),
        paths,
        expireAt: EXPIRES,
      });
      const steps = [result.primary, ...result.fallbacks];
      expect(steps.slice(0, row.steps.length)).toEqual(row.steps);
      expect(steps.at(-1)).toEqual(h);
      // A repeated final h5 step may be deduplicated without changing the ordered paths.
      expect(
        steps
          .slice(row.steps.length)
          .every((step) => step.type === 'h5' && step.value === paths.h5),
      ).toBe(true);
    }
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06e#12] BR-ATTR-27 %s H5 固定 unknown，不受客户端 installed 值影响',
  (platform) => {
    const baseline = buildDefaultLinkJump({
      platform,
      client: 'h5',
      installed: 'unknown',
      paths,
      expireAt: EXPIRES,
    });
    expect(baseline.primary.value).toBeTruthy();
    expect(
      [...baseline.fallbacks, baseline.primary].some(
        (step) => step.type === 'h5' && step.value === paths.h5,
      ),
    ).toBe(true);
    for (const installed of ['true', 'false'] as const) {
      expect(
        buildDefaultLinkJump({ platform, client: 'h5', installed, paths, expireAt: EXPIRES }),
      ).toEqual(baseline);
    }
  },
);

it.each([
  ['jd:12345', 'item.jd.com', '/12345.html', ''],
  ['pdd:67890', 'mobile.yangkeduo.com', '/goods.html', '?goods_id=67890'],
] as const)(
  '[AC-B1-06e#13] BR-PRICE-08 %s：无返利目标只由商品键生成，没有推广参数',
  (productKey, host, path, search) => {
    const result = noRebateProductUrl(productKey);
    const url = new URL(result);
    expect({
      protocol: url.protocol,
      host: url.host,
      path: url.pathname,
      search: url.search,
      hash: url.hash,
    }).toEqual({ protocol: 'https:', host, path, search, hash: '' });
  },
);

it.each([
  'https://example.test/other?pid=untrusted',
  'jd:12?pid=untrusted',
  'pdd:12/redirect',
  'jd:',
  'unknown:123',
])('[AC-B1-06e#14] BR-PRICE-08 非商品键 %s 不能当作无返利购买地址', (value) => {
  // Skeleton failure must not itself satisfy a negative assertion.
  let result: unknown;
  try {
    result = noRebateProductUrl(value);
  } catch (error) {
    result = error;
  }
  expect(result).toBeInstanceOf(Error);
  expect(String(result)).not.toContain('NotImplemented');
});
