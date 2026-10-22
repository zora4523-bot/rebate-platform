import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import type { GrowthHistory } from '../../growth/index.ts';
import type { UserDeletionStatus, UserDeletionStatusReader } from '../../identity/index.ts';
import { createSnapshotBeneficiaryResolver } from './beneficiary-resolver.ts';

type Level = 'L1' | 'L2' | 'L3';

function fakes(
  parents: Record<string, string>,
  levels: Record<string, Level>,
  statuses: Record<string, UserDeletionStatus>,
) {
  const calls: { kind: string; userIds: readonly string[] }[] = [];
  const growth: GrowthHistory = {
    levelAt(_db, query) {
      calls.push({ kind: 'levelAt', userIds: [query.user_id] });
      const level = levels[query.user_id];
      return Promise.resolve(
        level === undefined ? { level: 'L1', missing: true } : { level, missing: false },
      );
    },
    parentAt(_db, query) {
      calls.push({ kind: 'parentAt', userIds: [query.user_id] });
      return Promise.resolve(parents[query.user_id] ?? null);
    },
  };
  const deletion: UserDeletionStatusReader = {
    read(_executor, input) {
      calls.push({ kind: 'read', userIds: input.user_ids });
      const found = new Map<string, UserDeletionStatus>();
      for (const id of input.user_ids) {
        const status = statuses[id];
        if (status !== undefined) found.set(id, status);
      }
      return Promise.resolve(found);
    },
  };
  return { resolver: createSnapshotBeneficiaryResolver({ growth, deletion }), calls };
}

const trx = {} as Transaction<DB>;
const paidAt = new Date('2026-10-20T02:00:00Z');

it('[AC-B2-03p-UNIT#1] 三层齐全：等级按人取，注销中 / 已注销各自 forfeited，其余 active', async () => {
  const { resolver, calls } = fakes(
    { o: 'd', d: 'i', i: 'x' },
    { o: 'L1', d: 'L2', i: 'L3' },
    { o: 'none', d: 'processing', i: 'done' },
  );
  const result = await resolver.resolve(trx, { appId: 'a', ownerUserId: 'o', paidAt });
  expect(result).toEqual({
    owner: { userId: 'o', level: 'L1', status: 'active', forfeitReason: null },
    direct: { userId: 'd', level: 'L2', status: 'forfeited', forfeitReason: 'deleted' },
    indirect: { userId: 'i', level: 'L3', status: 'forfeited', forfeitReason: 'deleted' },
    warnings: [],
  });
  expect(calls.filter((c) => c.kind === 'read')).toEqual([
    { kind: 'read', userIds: ['o', 'd', 'i'] },
  ]);
  expect(calls.some((c) => c.kind === 'parentAt' && c.userIds[0] === 'i')).toBe(false);
});

it('[AC-B2-03p-UNIT#2] 无直推时不查间推；缺等级日志取 L1 并记告警；查无此人 forfeited', async () => {
  const { resolver, calls } = fakes({}, {}, {});
  const result = await resolver.resolve(trx, { appId: 'a', ownerUserId: 'o', paidAt });
  expect(result).toEqual({
    owner: { userId: 'o', level: 'L1', status: 'forfeited', forfeitReason: 'deleted' },
    direct: null,
    indirect: null,
    warnings: [{ code: 'growth_level_log_missing', userId: 'o' }],
  });
  expect(calls).toEqual([
    { kind: 'parentAt', userIds: ['o'] },
    { kind: 'levelAt', userIds: ['o'] },
    { kind: 'read', userIds: ['o'] },
  ]);
});
