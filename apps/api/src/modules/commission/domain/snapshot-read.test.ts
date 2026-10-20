import { expect, it } from 'vitest';
import {
  assertCommissionVersion,
  assertCurrentVersion,
  parseSnapshotBeneficiaries,
  parseSnapshotRole,
} from './snapshot-read.ts';

const stored = [
  {
    user_id: 'u-1',
    role: 'share',
    ratio_bp: 5000,
    level: 'L1',
    initial_status: 'active',
    forfeit_reason: null,
  },
  {
    user_id: 'u-2',
    role: 'direct',
    ratio_bp: 1000,
    level: 'L2',
    initial_status: 'forfeited',
    forfeit_reason: 'deleted',
  },
];

it('[AC-B2-04i-UNIT#1] 受益人 jsonb 原样转为快照值，保持写入顺序与初始没收原因', () => {
  expect(parseSnapshotBeneficiaries(stored)).toEqual([
    {
      userId: 'u-1',
      role: 'share',
      ratioBp: 5000,
      level: 'L1',
      initialStatus: 'active',
      forfeitReason: null,
    },
    {
      userId: 'u-2',
      role: 'direct',
      ratioBp: 1000,
      level: 'L2',
      initialStatus: 'forfeited',
      forfeitReason: 'deleted',
    },
  ]);
});

it('[AC-B2-04i-UNIT#2] 受益人 jsonb 缺字段、取值非法或重复 user_id+role 时抛错，不跳过不补默认', () => {
  const first = stored[0]!;
  expect(() => parseSnapshotBeneficiaries([])).toThrow(TypeError);
  expect(() => parseSnapshotBeneficiaries({})).toThrow(TypeError);
  expect(() => parseSnapshotBeneficiaries([null])).toThrow(TypeError);
  expect(() => parseSnapshotBeneficiaries([{ ...first, user_id: '' }])).toThrow(TypeError);
  expect(() => parseSnapshotBeneficiaries([{ ...first, role: 'owner' }])).toThrow(TypeError);
  expect(() => parseSnapshotBeneficiaries([{ ...first, ratio_bp: 50.5 }])).toThrow(TypeError);
  expect(() => parseSnapshotBeneficiaries([{ ...first, ratio_bp: '5000' }])).toThrow(TypeError);
  expect(() => parseSnapshotBeneficiaries([{ ...first, ratio_bp: 10001 }])).toThrow(TypeError);
  expect(() => parseSnapshotBeneficiaries([{ ...first, level: 'L4' }])).toThrow(TypeError);
  expect(() => parseSnapshotBeneficiaries([{ ...first, initial_status: 'held' }])).toThrow(
    TypeError,
  );
  expect(() => parseSnapshotBeneficiaries([{ ...first, forfeit_reason: 1 }])).toThrow(TypeError);
  expect(() => parseSnapshotBeneficiaries([first, { ...first, ratio_bp: 1 }])).toThrow(TypeError);
  expect(parseSnapshotBeneficiaries([first, { ...first, role: 'direct' }])).toHaveLength(2);
});

it('[AC-B2-04i-UNIT#3] 只认最大版本：缺版本、两表最大版本不一致、期望版本不是最大版本都抛错', () => {
  expect(assertCurrentVersion(3, 3, 3)).toBe(3);
  expect(() => assertCurrentVersion(1, null, null)).toThrow(/no amount version/);
  expect(() => assertCurrentVersion(1, 1, null)).toThrow(/no amount version/);
  expect(() => assertCurrentVersion(2, 2, 1)).toThrow(/differ/);
  expect(() => assertCurrentVersion(2, 3, 3)).toThrow(/not the current version/);
  expect(() => assertCurrentVersion(4, 3, 3)).toThrow(/not the current version/);
});

it('[AC-B2-04i-UNIT#4] 期望版本须为正安全整数；角色只认四种', () => {
  expect(() => assertCommissionVersion(1)).not.toThrow();
  for (const bad of [0, -1, 1.5, Number.NaN, '1', 2 ** 53]) {
    expect(() => assertCommissionVersion(bad)).toThrow(TypeError);
  }
  expect(parseSnapshotRole('indirect', 'x')).toBe('indirect');
  expect(() => parseSnapshotRole('platform', 'x')).toThrow(TypeError);
});
