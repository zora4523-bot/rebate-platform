import { expect, it } from 'vitest';
import {
  loadStatusMap,
  mapPlatformStatus,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { DEMO_CSV, HEADER, requiredStatusCsv } from './fixtures.ts';

it.each([
  ['demo-deposit', 'PLATFORM_DEPOSIT_PAID'],
  ['demo-paid', 'PLATFORM_PAID'],
  ['demo-received', 'PLATFORM_RECEIVED'],
  ['demo-settled', 'PLATFORM_SETTLED'],
  ['demo-invalid', 'PLATFORM_INVALID'],
  ['demo-punish', 'PLATFORM_PUNISH'],
  ['demo-rights', 'PLATFORM_RIGHTS'],
])('[AC-B1-08f#5] BR-FUND-02：演示表支持 %s → %s', (rawCode, event) => {
  const map = loadStatusMap('demo', DEMO_CSV);
  expect(mapPlatformStatus(map, rawCode)).toEqual({ kind: 'event', event, verified: false });
});

it('[AC-B1-08f#6] BR-FUND-02：演示 CSV 资产可加载且含有可映射的演示码', () => {
  const csv = requiredStatusCsv('demo');
  expect(csv.split(/\r?\n/)[0]).toBe(HEADER);
  const map = loadStatusMap('demo', csv);
  expect(map.platform).toBe('demo');
  expect(map.entries.size).toBeGreaterThan(0);
  for (const [rawCode, row] of map.entries) {
    expect(mapPlatformStatus(map, rawCode)).toEqual({
      kind: 'event',
      event: row.event,
      verified: row.verified,
    });
  }
});

it('[AC-B1-08f#7] BR-FUND-02：事件和 verified 取自传入 CSV，不硬编码平台码义或共享其他表', () => {
  // 故意使用与文档表不同的合成映射，验证函数只认本次加载的表。
  const first = loadStatusMap('pdd', `${HEADER}\n5,PLATFORM_PAID,demo,false,合成表一\n`);
  const second = loadStatusMap('pdd', `${HEADER}\n5,PLATFORM_RIGHTS,demo,true,合成表二\n`);
  expect(mapPlatformStatus(first, '5')).toEqual({
    kind: 'event',
    event: 'PLATFORM_PAID',
    verified: false,
  });
  expect(mapPlatformStatus(second, '5')).toEqual({
    kind: 'event',
    event: 'PLATFORM_RIGHTS',
    verified: true,
  });
  expect(mapPlatformStatus(first, '10')).toEqual({ kind: 'unmapped', rawCode: '10' });
  expect(mapPlatformStatus(second, '0')).toEqual({ kind: 'unmapped', rawCode: '0' });
});

it.each([null, '', 'unknown', 'constructor', '__proto__', 'toString', 'DEMO-PAID'])(
  '[AC-B1-08f#8] BR-FUND-02：演示表外码 %s 不猜测事件，且查询不污染已加载的表',
  (rawCode) => {
    const map = loadStatusMap('demo', DEMO_CSV);
    const before = [...map.entries];
    expect(mapPlatformStatus(map, rawCode)).toEqual({ kind: 'unmapped', rawCode });
    expect([...map.entries]).toEqual(before);
    expect(mapPlatformStatus(map, 'demo-paid')).toEqual({
      kind: 'event',
      event: 'PLATFORM_PAID',
      verified: false,
    });
  },
);
