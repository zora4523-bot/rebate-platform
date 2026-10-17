import { expect, it } from 'vitest';
import {
  loadStatusMap,
  mapPlatformStatus,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { SYNTHETIC_CSV, HEADER } from './fixtures.ts';

it.each([
  ['x-deposit', 'PLATFORM_DEPOSIT_PAID'],
  ['x-paid', 'PLATFORM_PAID'],
  ['x-received', 'PLATFORM_RECEIVED'],
  ['x-settled', 'PLATFORM_SETTLED'],
  ['x-invalid', 'PLATFORM_INVALID'],
  ['x-punish', 'PLATFORM_PUNISH'],
  ['x-rights', 'PLATFORM_RIGHTS'],
])('[AC-B1-08f#5] BR-FUND-02：合成 CSV 覆盖事件编码 %s → %s', (rawCode, event) => {
  const map = loadStatusMap('pdd', SYNTHETIC_CSV);
  expect(mapPlatformStatus(map, rawCode)).toEqual({ kind: 'event', event, verified: false });
});

it('[AC-B1-08f#6] BR-FUND-02：合成 CSV 明列的处罚码映射为 PLATFORM_PUNISH，不得映射为失效', () => {
  const map = loadStatusMap('pdd', `${HEADER}\nx-punish,PLATFORM_PUNISH,synthetic,true,合成处罚\n`);
  expect(map.platform).toBe('pdd');
  expect(mapPlatformStatus(map, 'x-punish')).toEqual({
    kind: 'event',
    event: 'PLATFORM_PUNISH',
    verified: true,
  });
});

it('[AC-B1-08f#7] BR-FUND-02：事件和 verified 取自传入 CSV，不硬编码平台码义或共享其他表', () => {
  // 故意使用与文档表不同的合成映射，验证函数只认本次加载的表。
  const first = loadStatusMap('pdd', `${HEADER}\n5,PLATFORM_PAID,synthetic,false,合成表一\n`);
  const second = loadStatusMap('pdd', `${HEADER}\n5,PLATFORM_RIGHTS,synthetic,true,合成表二\n`);
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

it.each([null, '', 'unknown', 'constructor', '__proto__', 'toString', 'X-PAID'])(
  '[AC-B1-08f#8] BR-FUND-02：合成表外码 %s 不猜测事件，且查询不污染已加载的表',
  (rawCode) => {
    const map = loadStatusMap('pdd', SYNTHETIC_CSV);
    const before = [...map.entries];
    expect(mapPlatformStatus(map, rawCode)).toEqual({ kind: 'unmapped', rawCode });
    expect([...map.entries]).toEqual(before);
    expect(mapPlatformStatus(map, 'x-paid')).toEqual({
      kind: 'event',
      event: 'PLATFORM_PAID',
      verified: false,
    });
  },
);
