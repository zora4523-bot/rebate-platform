// B1-22i / BR-ATTR-02 / D10-221 A，唯一口径按 D10-231：pid 服务与命令行启用时，同 app × platform ×
// 联盟账号 × pid_scene 已有 active 即拒绝（UnionPidError 'conflict'，命令行打印服务拒绝、退出码 3），
// 数据库 23505 不得原样漏出；跨联盟账号同场景各一条允许（B1-19d 的跨账号告警照旧，见 [AC-B1-19d#4]）。
// outcome() 把抛出的错误包成 { thrown }，拒绝一律按这个形状断言。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  run,
  UNION_PIDS_EXIT,
  type UnionPidCliDeps,
} from '../../../../../apps/api/scripts/union-pids.ts';
import {
  createUnionPidService,
  UnionPidError,
  type PidServiceDeps,
  type UnionPidService,
} from '../../../../../apps/api/src/modules/union/index.ts';
import { databaseFixture, outcome } from '../../../union/pids-by-account/kit.ts';
import {
  audits,
  harness,
  PLATFORMS,
  seedAdmin,
  seedAccount,
  seedPid,
  state,
  storedPid,
  type Harness,
} from '../../../union/pids/kit.ts';

const database = databaseFixture(createTestDatabase);

type Entry = 'service' | 'cli';

function cli(h: Harness, service: UnionPidService) {
  const write = vi.fn<(message: string) => void>();
  const error = vi.fn<(message: string) => void>();
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
  return {
    write,
    error,
    activate: (pidId: string) =>
      run(['activate', '--app', h.appId, '--admin', h.adminId, '--pid-id', pidId], deps),
  };
}

async function expectRefused(entry: Entry, h: Harness, service: UnionPidService, pidId: string) {
  if (entry === 'service') {
    const result = await outcome(() =>
      service.setPidStatus({ ...h.auth, pidId, status: 'active' }),
    );
    expect(result).toMatchObject({ thrown: expect.any(UnionPidError) });
    expect(result).toMatchObject({ thrown: { code: 'conflict' } });
    return;
  }
  const terminal = cli(h, service);
  const result = await terminal.activate(pidId);
  expect(result.exitCode).toBe(UNION_PIDS_EXIT.refused);
  expect(terminal.error).toHaveBeenCalledWith(expect.stringMatching(/服务拒绝（conflict）/));
  expect(terminal.write.mock.calls.flat().join('\n')).not.toContain('完成：activate');
}

async function expectActivated(entry: Entry, h: Harness, service: UnionPidService, pidId: string) {
  if (entry === 'service') {
    const result = await outcome(() =>
      service.setPidStatus({ ...h.auth, pidId, status: 'active' }),
    );
    expect(result).toMatchObject({ id: pidId, status: 'active' });
    return;
  }
  const terminal = cli(h, service);
  const result = await terminal.activate(pidId);
  expect(result.exitCode).toBe(UNION_PIDS_EXIT.ok);
  expect(terminal.write).toHaveBeenCalledWith('完成：activate');
}

for (const platform of PLATFORMS) {
  for (const entry of ['service', 'cli'] as const) {
    it(`[AC-B1-22i#5] ${entry}/${platform}/同账号: 同账号同场景已有 active 时启用被拒，无写入、审计与告警`, async () => {
      const h = harness(database());
      await seedAdmin(h);
      const account = await seedAccount(h, { platform });
      h.clock.advanceMs(1_000);
      await seedPid(h, {
        platform,
        union_account_id: account.id,
        status: 'active',
        pid_scene: 'share',
      });
      h.clock.advanceMs(1_000);
      const target = await seedPid(h, {
        platform,
        union_account_id: account.id,
        pid_scene: 'share',
      });
      h.clock.advanceMs(1_000);
      const warn = vi.fn();
      const service = createUnionPidService({ ...h.deps, logger: { warn } });
      const before = await state(h);
      await expectRefused(entry, h, service, target.id);
      expect(await state(h)).toEqual(before);
      expect(h.append).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    }, 30_000);

    it(`[AC-B1-22i#5] ${entry}/${platform}/跨账号: 其他联盟账号同场景已有 active 时照常启用，本账号第二条被拒`, async () => {
      const h = harness(database());
      await seedAdmin(h);
      const a = await seedAccount(h, { platform });
      h.clock.advanceMs(1_000);
      const b = await seedAccount(h, { platform });
      h.clock.advanceMs(1_000);
      const existing = await seedPid(h, {
        platform,
        union_account_id: a.id,
        status: 'active',
        pid_scene: 'share',
      });
      h.clock.advanceMs(1_000);
      const target = await seedPid(h, { platform, union_account_id: b.id, pid_scene: 'share' });
      h.clock.advanceMs(1_000);
      const second = await seedPid(h, { platform, union_account_id: b.id, pid_scene: 'share' });
      h.clock.advanceMs(1_000);
      const warn = vi.fn();
      const service = createUnionPidService({ ...h.deps, logger: { warn } });

      await expectActivated(entry, h, service, target.id);
      expect(await storedPid(h, target.id)).toMatchObject({ status: 'active' });
      expect(await storedPid(h, existing.id)).toEqual(existing);

      // 跨账号放行之后，账号 b 同场景第二条仍须拒绝；旧实现也必须在本用例中先红。
      const warned = warn.mock.calls.length;
      h.append.mockClear();
      h.clock.advanceMs(1_000);
      const before = await state(h);
      await expectRefused(entry, h, service, second.id);
      expect(await state(h)).toEqual(before);
      expect(h.append).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(warned);
    }, 30_000);
  }
}

/**
 * Holds the first audit append (inside its command transaction, after its status write) until
 * another backend of this test database waits on a lock, so the peer's activation really
 * overlaps an uncommitted active row instead of running after the commit. Gives up after about
 * 5 s (an implementation that never blocks); the outcome assertions decide either way.
 */
async function untilPeerWaits(db: Kysely<DB>): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const waiting = await sql<{ count: number }>`
      SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
    `.execute(db);
    if ((waiting.rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

for (const platform of PLATFORMS) {
  it(`[AC-B1-22i#6] ${platform}: 同账号同场景两条并发启用只成功一条，另一条是 UnionPidError conflict 而非数据库 23505`, async () => {
    const h = harness(database());
    await seedAdmin(h);
    const account = await seedAccount(h, { platform });
    h.clock.advanceMs(1_000);
    const first = await seedPid(h, { platform, union_account_id: account.id, pid_scene: 'share' });
    h.clock.advanceMs(1_000);
    const second = await seedPid(h, {
      platform,
      union_account_id: account.id,
      pid_scene: 'share',
    });
    h.clock.advanceMs(1_000);
    let held = false;
    const deps: PidServiceDeps = {
      ...h.deps,
      auditWriter: (trx) => {
        const inner = h.deps.auditWriter(trx);
        return {
          append: async (input) => {
            if (!held) {
              held = true;
              await untilPeerWaits(h.db);
            }
            await inner.append(input);
          },
        };
      },
    };
    const service = createUnionPidService(deps);
    const rows = [first, second];
    const results = await Promise.all(
      rows.map((row) =>
        outcome(() => service.setPidStatus({ ...h.auth, pidId: row.id, status: 'active' })),
      ),
    );
    const refused = results.filter((result) => 'thrown' in result);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ thrown: expect.any(UnionPidError) });
    expect(refused[0]).toMatchObject({ thrown: { code: 'conflict' } });
    const winner = results.findIndex((result) => !('thrown' in result));
    expect(results[winner]).toMatchObject({ id: rows[winner]!.id, status: 'active' });
    const loser = rows[1 - winner]!;
    expect(await storedPid(h, rows[winner]!.id)).toMatchObject({ status: 'active' });
    expect(await storedPid(h, loser.id)).toEqual(loser);
    const written = await audits(h);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: 'union.pid.activate',
      target: `union_pids:${rows[winner]!.id}`,
    });
  }, 30_000);
}
