import { expect, it } from 'vitest';
import {
  loadStatusMap,
  mapPlatformStatus,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { HEADER } from '../status-map/fixtures.ts';
import { jdStatusMap, MAPPED, requiredJdCsv, UNMAPPED } from './kit.ts';

it('[AC-B1-04zg#1] D10-529：jd.csv 恰好是定表的码，全部 doc、未实测，备注非空，过 loadStatusMap', () => {
  const csv = requiredJdCsv();
  const [header, ...lines] = csv.trimEnd().split(/\r?\n/);
  expect(header).toBe(HEADER);
  // 独立检查资产，避免加载器硬编码正确结果时掩盖 CSV 的错码或错误来源标记。
  expect(lines).toHaveLength(MAPPED.length);
  for (const [code, event] of MAPPED) {
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^${code},${event},doc,false,\\S`)),
      ]),
    );
  }
  const map = loadStatusMap('jd', csv);
  expect(map.platform).toBe('jd');
  expect([...map.entries.keys()].sort()).toEqual(MAPPED.map(([code]) => code).sort());
  for (const [code, event] of MAPPED) {
    expect(map.entries.get(code)).toEqual({
      event,
      source: 'doc',
      verified: false,
      note: expect.stringMatching(/\S/),
    });
  }
});

it.each(MAPPED)(
  '[AC-B1-04zg#2] D10-529：京东 validCode %s → %s，保留未验证标记',
  (rawCode, event) => {
    expect(mapPlatformStatus(jdStatusMap(), rawCode)).toEqual({
      kind: 'event',
      event,
      verified: false,
    });
  },
);

it.each(UNMAPPED)('[AC-B1-04zg#3] D10-529：京东码 %s 不进表，保留原码走表外码流程', (rawCode) => {
  const map = jdStatusMap();
  expect(map.entries.has(rawCode)).toBe(false);
  expect(mapPlatformStatus(map, rawCode)).toEqual({ kind: 'unmapped', rawCode });
});

it('[AC-B1-04zg#4] D10-529：表里只有付款、定金、完成、失效四种事件，没有已结算、处罚、维权', () => {
  const events = new Set([...jdStatusMap().entries.values()].map((entry) => entry.event));
  expect([...events].sort()).toEqual([
    'PLATFORM_DEPOSIT_PAID',
    'PLATFORM_INVALID',
    'PLATFORM_PAID',
    'PLATFORM_RECEIVED',
  ]);
});

it.each(['016', '16 ', ' 16', '16.0', '+16', '', 'PLATFORM_PAID', null])(
  '[AC-B1-04zg#5] D10-529：码 %s 不做归一，按表外码保留原文',
  (rawCode) => {
    expect(mapPlatformStatus(jdStatusMap(), rawCode)).toEqual({ kind: 'unmapped', rawCode });
  },
);
