import { expect, it } from 'vitest';
import {
  loadStatusMap,
  mapPlatformStatus,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { DEMO_CSV, HEADER } from './fixtures.ts';

it('[AC-B1-08f#9] BR-FUND-02：CSV 支持 UTF-8 备注、引号转义、CRLF，布尔值不按字符串真值读取', () => {
  const csv = [
    HEADER,
    'a,PLATFORM_PUNISH,demo,false,"演示处罚,含逗号与""引号"""',
    'b,PLATFORM_RECEIVED,demo,true,演示收货',
    '',
  ].join('\r\n');
  const map = loadStatusMap('demo', csv);
  expect(map.entries.get('a')).toEqual({
    event: 'PLATFORM_PUNISH',
    source: 'demo',
    verified: false,
    note: '演示处罚,含逗号与"引号"',
  });
  expect(mapPlatformStatus(map, 'a')).toEqual({
    kind: 'event',
    event: 'PLATFORM_PUNISH',
    verified: false,
  });
  expect(mapPlatformStatus(map, 'b')).toEqual({
    kind: 'event',
    event: 'PLATFORM_RECEIVED',
    verified: true,
  });
});

it.each([
  ['没有表头', 'x,PLATFORM_PAID,demo,false,演示'],
  ['空文件', ''],
  ['缺列', 'raw_code,event,source,verified\nx,PLATFORM_PAID,demo,false'],
  ['错列', 'status,event,source,verified,note\nx,PLATFORM_PAID,demo,false,演示'],
  ['调换列顺序', 'event,raw_code,source,verified,note\nPLATFORM_PAID,x,demo,false,演示'],
  ['未知事件', `${HEADER}\nx,PLATFORM_REFUND,demo,false,演示`],
  ['内部状态冒充事件', `${HEADER}\nx,SETTLED,demo,false,演示`],
  ['空事件', `${HEADER}\nx,,demo,false,演示`],
  ['相同码相同事件', `${HEADER}\nx,PLATFORM_PAID,demo,false,演示\nx,PLATFORM_PAID,demo,false,重复`],
  [
    '相同码不同事件',
    `${HEADER}\nx,PLATFORM_PAID,demo,false,演示\nx,PLATFORM_PUNISH,demo,true,冲突`,
  ],
  ...['TRUE', 'FALSE', '1', '0', 'yes', ''].map((value) => [
    `verified=${value}`,
    `${HEADER}\nx,PLATFORM_PAID,demo,${value},演示`,
  ]),
])('[AC-B1-08f#10] BR-FUND-02：拒绝无效 CSV（%s），不能悄悄跳过坏行或覆盖重复码', (_label, csv) => {
  // 先要求合法输入成功：抛任何错误的骨架不得满足下面的拒绝断言。
  const valid = loadStatusMap('demo', DEMO_CSV);
  expect(mapPlatformStatus(valid, 'demo-paid')).toEqual({
    kind: 'event',
    event: 'PLATFORM_PAID',
    verified: false,
  });
  expect(() => loadStatusMap('demo', csv)).toThrow();
});
