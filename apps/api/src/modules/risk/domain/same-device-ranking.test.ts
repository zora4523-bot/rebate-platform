// Unit tests of BR-ID-37's pure ranking (B1-03k). The SQL and the writes run against PostgreSQL in
// the rule tests (test/spec/risk/same-device).
import { expect, it } from 'vitest';
import {
  parseAccountsLimit,
  parseDedupe,
  rankSameDeviceAccounts,
  type SameDeviceLoginRow,
} from './same-device-ranking.ts';

const H = 'a'.repeat(64);
const J = 'b'.repeat(64);

function row(
  user: string,
  at: string,
  id: number,
  extra: Partial<SameDeviceLoginRow> = {},
): SameDeviceLoginRow {
  return {
    device_hash: H,
    user_id: user,
    first_login_at: new Date(at),
    login_log_id: BigInt(id),
    status: 'normal',
    deleted_reason: null,
    merged_into_user_id: null,
    ...extra,
  };
}

const tomb = (target: string) =>
  ({ status: 'deleted', deleted_reason: 'merged', merged_into_user_id: target }) as const;

it('[AC-B1-03k#1] 按窗口内首次登录排序，名次从 1 起', () => {
  const rows = [row('c', '2026-09-20', 3), row('a', '2026-09-01', 1), row('b', '2026-09-10', 2)];
  expect(rankSameDeviceAccounts(rows, 'c', true)).toEqual([{ device_hash: H, rank: 3 }]);
  expect(rankSameDeviceAccounts(rows, 'a', true)).toEqual([{ device_hash: H, rank: 1 }]);
});

it('[AC-B1-03k#4] 同时刻按 login_logs.id 升序', () => {
  const rows = [row('x', '2026-09-10', 9), row('y', '2026-09-10', 7), row('z', '2026-09-10', 8)];
  expect(rankSameDeviceAccounts(rows, 'x', true)).toEqual([{ device_hash: H, rank: 3 }]);
  expect(rankSameDeviceAccounts(rows, 'y', true)).toEqual([{ device_hash: H, rank: 1 }]);
});

it('[AC-B1-03k#5] 去重开启：目标在同设备时源不计，目标取较早时刻与源的 id', () => {
  const rows = [
    row('a', '2026-09-01', 1),
    row('b', '2026-09-10', 2, tomb('z')),
    row('c', '2026-09-10', 3),
    row('z', '2026-09-10', 4),
  ];
  expect(rankSameDeviceAccounts(rows, 'c', true)).toEqual([{ device_hash: H, rank: 3 }]);
  expect(rankSameDeviceAccounts(rows, 'z', true)).toEqual([{ device_hash: H, rank: 2 }]);
  expect(rankSameDeviceAccounts(rows, 'b', true)).toEqual([]);
});

it('[AC-B1-03k#5] 目标不在该设备时源照常计入；每台设备分别判断', () => {
  const rows = [
    row('a', '2026-09-01', 1),
    row('b', '2026-09-02', 2, tomb('a')),
    row('c', '2026-09-03', 3),
    row('z', '2026-09-01', 4, { device_hash: J }),
    row('b', '2026-09-02', 5, { device_hash: J, ...tomb('a') }),
    row('c', '2026-09-03', 6, { device_hash: J }),
  ];
  expect(rankSameDeviceAccounts(rows, 'c', true)).toEqual([
    { device_hash: H, rank: 2 },
    { device_hash: J, rank: 3 },
  ]);
});

it('[AC-B1-03k#5] 只认 deleted 且 merged 的墓碑', () => {
  for (const extra of [
    { status: 'deleted', deleted_reason: 'cancelled', merged_into_user_id: 'a' },
    { status: 'normal', deleted_reason: 'merged', merged_into_user_id: 'a' },
  ]) {
    const rows = [
      row('a', '2026-09-01', 1),
      row('b', '2026-09-02', 2, extra),
      row('c', '2026-09-03', 3),
    ];
    expect(rankSameDeviceAccounts(rows, 'c', true)).toEqual([{ device_hash: H, rank: 3 }]);
  }
});

it('[AC-B1-03k#6] 去重关闭：墓碑占名次，目标不承接源时刻', () => {
  const rows = [
    row('a', '2026-09-01', 1),
    row('b', '2026-09-02', 2, tomb('z')),
    row('c', '2026-09-03', 3),
    row('z', '2026-09-24', 4),
  ];
  expect(rankSameDeviceAccounts(rows, 'z', false)).toEqual([{ device_hash: H, rank: 4 }]);
});

it('[AC-B1-03k#5] 互相指向的墓碑不会死循环', () => {
  const rows = [row('p', '2026-09-01', 1, tomb('q')), row('q', '2026-09-02', 2, tomb('p'))];
  expect(rankSameDeviceAccounts(rows, 'q', true)).toEqual([{ device_hash: H, rank: 1 }]);
});

it('[AC-B1-03k#1] 本人不在的设备不出现', () => {
  expect(rankSameDeviceAccounts([row('a', '2026-09-01', 1)], 'c', true)).toEqual([]);
});

it('[AC-B1-03k#7] limit 只认安全正整数，dedupe 只认 JSON 布尔', () => {
  expect(parseAccountsLimit(2)).toBe(2);
  expect(parseAccountsLimit(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  for (const bad of ['3', 0, -1, 1.5, true, null, {}, [], Number.MAX_SAFE_INTEGER + 1, undefined]) {
    expect(parseAccountsLimit(bad)).toBeNull();
  }
  expect(parseDedupe(false)).toBe(false);
  expect(parseDedupe(true)).toBe(true);
  for (const bad of ['false', 'true', 0, 1, null, {}, [], undefined]) {
    expect(parseDedupe(bad)).toBeNull();
  }
});
