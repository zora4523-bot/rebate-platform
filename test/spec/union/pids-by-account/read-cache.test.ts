import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  openScopedPids,
  withOpenReads,
} from '../../../../apps/api/src/modules/linking/application/link-open-reads.ts';
import type { ActivePidInput } from '../../../../apps/api/src/modules/union/index.ts';
import { pid } from '../../linking/register/kit.ts';
import { outcome } from '../../linking/open-pdd-auth/kit.ts';

for (const first of ['unscoped', 'account-a'] as const) {
  it(`[AC-B1-19d#10] ${first} 先预读：账号条件进入缓存键，事务内不会混用账号或再次查库`, async () => {
    const a = randomUUID();
    const b = randomUUID();
    const query = {
      appId: 'synthetic-cache-app',
      platform: 'pdd' as const,
      pidScene: 'share' as const,
      purpose: 'convert' as const,
    };
    const rowA = { ...pid(query), union_account_id: a, pid: 'synthetic-a' };
    const rowB = {
      ...pid(query),
      id: randomUUID(),
      union_account_id: b,
      pid: 'synthetic-b',
      created_at: new Date(rowA.created_at.getTime() + 1_000),
      updated_at: new Date(rowA.updated_at.getTime() + 1_000),
    };
    // 本用例只测预读键；读取服务的真实账号过滤由 queries.int.test.ts 覆盖。
    const getActivePid = vi.fn(async (input: ActivePidInput & { unionAccountId?: string }) =>
      input.unionAccountId === a ? rowA : rowB,
    );
    const reader = openScopedPids({ getActivePid });
    const scopedA = { ...query, unionAccountId: a };
    const scopedB = { ...query, unionAccountId: b };
    const result = await outcome(() =>
      withOpenReads(
        async () => {
          const ordered =
            first === 'unscoped' ? [query, scopedA, scopedB] : [scopedA, scopedB, query];
          for (const input of ordered) await reader.getActivePid(input);
          getActivePid.mockClear();
        },
        async () => [
          await reader.getActivePid(scopedA),
          await reader.getActivePid(scopedB),
          await reader.getActivePid(query),
        ],
      ),
    );
    expect(result).toEqual([rowA, rowB, rowB]);
    expect(getActivePid).not.toHaveBeenCalled();
  }, 10_000);
}
