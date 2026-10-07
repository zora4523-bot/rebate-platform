import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  countDeviceRegistrations,
  type DeviceRegistrationRecord,
} from '../../../../apps/api/src/modules/identity/application/registration.ts';

const now = new Date('2026-10-06T12:00:00Z');
const windowMs = 30 * 24 * 60 * 60 * 1000;
const scope = { app_id: 'couli', device_hash: randomBytes(32).toString('hex') };
function row(
  id: string,
  target: string | null = null,
  overrides: Partial<DeviceRegistrationRecord> = {},
): DeviceRegistrationRecord {
  return {
    ...scope,
    user_id: id,
    merged_into_user_id: target,
    created_at: new Date(now.getTime() - 60_000),
    ...overrides,
  };
}

it('[BR-ID-05] 滑动 30×24 小时只计算本 App、本设备窗口内记录，前后各留一分钟', () => {
  const rows = [
    row('recent'),
    row('inside', null, { created_at: new Date(now.getTime() - windowMs + 60_000) }),
    row('outside', null, { created_at: new Date(now.getTime() - windowMs - 60_000) }),
    row('other-app', null, { app_id: 'other' }),
    row('other-device', null, { device_hash: randomBytes(32).toString('hex') }),
  ];
  expect(countDeviceRegistrations(rows, scope, now, true)).toBe(2);
});

it('[AC-S1-59 ⑥] A/U9 成对只算一条，X/Y 依次占名额，关闭去重后恢复原条数', () => {
  const pair = [row('A'), row('U9', 'A')];
  expect(countDeviceRegistrations(pair, scope, now, true)).toBe(1);
  expect(countDeviceRegistrations([...pair, row('X')], scope, now, true)).toBe(2);
  expect(countDeviceRegistrations([...pair, row('X'), row('Y')], scope, now, true)).toBe(3);
  expect(countDeviceRegistrations(pair, scope, now, false)).toBe(2);
  expect(countDeviceRegistrations([...pair, row('X')], scope, now, false)).toBe(3);
});

it('[AC-S1-59 ⑦] 跨设备三个并号墓碑全部计入，两台设备都不退名额', () => {
  const otherHash = randomBytes(32).toString('hex');
  const rows = [
    row('A1', null, { device_hash: otherHash }),
    row('A2', null, { device_hash: otherHash }),
    row('A3', null, { device_hash: otherHash }),
    row('B1', 'A1'),
    row('B2', 'A2'),
    row('B3', 'A3'),
  ];
  expect(countDeviceRegistrations(rows, scope, now, true)).toBe(3);
  expect(countDeviceRegistrations(rows, { ...scope, device_hash: otherHash }, now, true)).toBe(3);
});

it('[BR-ID-05] 多个源号并入同一在窗口内的目标号，整体只计一个', () => {
  const rows = [row('A'), row('wechat', 'A'), row('apple', 'A'), row('huawei', 'A')];
  expect(countDeviceRegistrations(rows, scope, now, true)).toBe(1);
  expect(countDeviceRegistrations([...rows].reverse(), scope, now, true)).toBe(1);
  expect(countDeviceRegistrations(rows, scope, now, false)).toBe(4);
});

it('[BR-ID-05] 目标滑出窗口或不在本 App/设备，源号照常计数且不互相配对', () => {
  for (const target of [
    row('A', null, { created_at: new Date(now.getTime() - windowMs - 60_000) }),
    row('A', null, { app_id: 'other' }),
    row('A', null, { device_hash: randomBytes(32).toString('hex') }),
  ]) {
    expect(countDeviceRegistrations([target, row('B', 'A'), row('C', 'A')], scope, now, true)).toBe(
      2,
    );
  }
}, 30_000);

it('[BR-ID-05] 已滑出窗口的源号不参与配对，未配对墓碑不因存在 merged_into 而消失', () => {
  expect(
    countDeviceRegistrations(
      [
        row('A'),
        row('B', 'A', {
          created_at: new Date(now.getTime() - windowMs - 60_000),
        }),
        row('C', 'missing'),
      ],
      scope,
      now,
      true,
    ),
  ).toBe(2);
});
