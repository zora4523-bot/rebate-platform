// BR-ATTR-02 / D10-221 A：服务和 CLI 的冲突必须是业务拒绝，不能泄漏 PG 23505。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { run, type UnionPidCliDeps } from '../../../../../apps/api/scripts/union-pids.ts';
import {
  createUnionPidService,
  UnionPidError,
} from '../../../../../apps/api/src/modules/union/index.ts';
import { databaseFixture, outcome } from '../../../union/pids-by-account/kit.ts';
import { harness, seedAdmin, seedAccount, seedPid, state } from '../../../union/pids/kit.ts';

const database = databaseFixture(createTestDatabase);

for (const platform of ['taobao', 'jd', 'pdd'] as const) {
  for (const sameAccount of [true, false]) {
    for (const entry of ['service', 'cli'] as const) {
      it(`[AC-B1-22i#5] ${entry}/${platform}/${sameAccount ? '同' : '跨'}账号: 同场景已有 active 则拒绝且无写入、审计与告警`, async () => {
        const h = harness(database());
        await seedAdmin(h);
        const account = await seedAccount(h, { platform });
        const existing = await seedPid(h, {
          platform,
          union_account_id: account.id,
          status: 'active',
          pid_scene: 'share',
        });
        const target = await seedPid(h, {
          platform,
          ...(sameAccount ? { union_account_id: account.id } : {}),
          pid_scene: 'share',
        });
        expect(target.union_account_id === existing.union_account_id).toBe(sameAccount);
        const warn = vi.fn();
        const service = createUnionPidService({ ...h.deps, logger: { warn } });
        const before = await state(h);
        if (entry === 'service') {
          const result = await outcome(() =>
            service.setPidStatus({
              ...h.auth,
              pidId: target.id,
              status: 'active',
            }),
          );
          expect(result).toBeInstanceOf(UnionPidError);
          expect(result).toMatchObject({ code: 'conflict' });
        } else {
          const write = vi.fn();
          const error = vi.fn();
          const deps: UnionPidCliDeps = {
            service,
            clock: h.clock,
            newIdempotencyKey: () => randomUUID(),
            queries: {
              listAccounts: vi.fn(async () => []),
              listPids: vi.fn(async () => []),
            },
            terminal: {
              isTTY: true,
              readCode: vi.fn(async () => h.auth.code),
              write,
              error,
            },
          };
          const result = await run(
            ['activate', '--app', h.appId, '--admin', h.adminId, '--pid-id', target.id],
            deps,
          );
          expect(result.exitCode).not.toBe(0);
          expect(error).toHaveBeenCalledWith(expect.stringMatching(/服务拒绝（conflict）/));
          expect(write.mock.calls.flat().join('\n')).not.toContain('已照常激活');
        }
        expect(await state(h)).toEqual(before);
        expect(h.append).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      }, 30_000);
    }
  }
}
