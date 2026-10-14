import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { createUnionPidService } from '../../../../apps/api/src/modules/union/index.ts';
import { audits, harness, seedAccount, seedAdmin, seedPid, storedPid } from '../pids/kit.ts';
import { databaseFixture, outcome } from './kit.ts';

const database = databaseFixture(createTestDatabase);

// 选 logger 方案：PidServiceDeps.logger.warn(fields, message)，每个冲突一条平铺事件。
// 字段只含事件名、应用、平台、场景及双方行 ID / 账号 ID；不打印整行或鉴权信息。
for (const platform of ['taobao', 'pdd', 'jd'] as const) {
  it(`[AC-B1-19d#4] ${platform}: 激活跨账号同场景只告警，忽略非冲突行且保持审计形状`, async () => {
    const h = harness(database());
    await seedAdmin(h);
    const warn = vi.fn<(fields: Readonly<Record<string, unknown>>, message: string) => void>();
    const deps = { ...h.deps, logger: { warn } };
    const service = createUnionPidService(deps);
    const a = await seedAccount(h, { platform });
    h.clock.advanceMs(1_000);
    const b = await seedAccount(h, { platform });
    h.clock.advanceMs(1_000);
    const c = await seedAccount(h, { platform });
    h.clock.advanceMs(1_000);
    await seedPid(h, { platform, union_account_id: a.id, status: 'active', pid_scene: 'share' });
    h.clock.advanceMs(1_000);
    await seedPid(h, { platform, union_account_id: b.id, status: 'active', pid_scene: 'self_buy' });
    h.clock.advanceMs(1_000);
    await seedPid(h, { platform, union_account_id: b.id, status: 'retired', pid_scene: 'share' });
    h.clock.advanceMs(1_000);
    await seedPid(h, { platform, union_account_id: c.id, status: 'pending', pid_scene: 'share' });
    h.clock.advanceMs(1_000);
    await seedPid(h, {
      platform: platform === 'pdd' ? 'jd' : 'pdd',
      status: 'active',
      pid_scene: 'share',
    });
    h.clock.advanceMs(1_000);
    await seedPid(
      { ...h, appId: `${h.appId}-foreign` },
      {
        platform,
        status: 'active',
        pid_scene: 'share',
      },
    );
    h.clock.advanceMs(1_000);
    const first = await seedPid(h, { platform, union_account_id: a.id, pid_scene: 'share' });
    h.clock.advanceMs(1_000);
    const normal = await outcome(() =>
      service.setPidStatus({ ...h.auth, pidId: first.id, status: 'active' }),
    );
    expect(normal).toMatchObject({ id: first.id, status: 'active' });
    expect(warn).not.toHaveBeenCalled();
    const [normalAudit] = await audits(h);
    expect(normalAudit).toMatchObject({
      action: 'union.pid.activate',
      target: `union_pids:${first.id}`,
    });

    const conflicts = [];
    for (const account of [b, c]) {
      h.clock.advanceMs(1_000);
      conflicts.push(
        await seedPid(h, {
          platform,
          union_account_id: account.id,
          status: 'active',
          pid_scene: 'share',
        }),
      );
    }
    h.clock.advanceMs(1_000);
    const target = await seedPid(h, { platform, union_account_id: a.id, pid_scene: 'share' });
    h.clock.advanceMs(1_000);
    const result = await outcome(() =>
      service.setPidStatus({ ...h.auth, pidId: target.id, status: 'active' }),
    );
    const stored = await storedPid(h, target.id);
    expect(result).toEqual(stored);
    expect(stored).toMatchObject({ status: 'active', row_version: target.row_version + 1 });
    const allAudits = await audits(h);
    expect(allAudits).toHaveLength(2);
    const conflictAudit = allAudits.find((row) => row.target === `union_pids:${target.id}`);
    expect(conflictAudit).toMatchObject({
      app_id: h.appId,
      admin_id: h.adminId,
      action: 'union.pid.activate',
      before: JSON.parse(JSON.stringify(target)) as unknown,
      after: JSON.parse(JSON.stringify(stored)) as unknown,
    });
    expect(Object.keys(conflictAudit!).sort()).toEqual(Object.keys(normalAudit!).sort());
    for (const conflict of conflicts)
      expect((await storedPid(h, conflict.id)).status).toBe('active');
    expect(warn).toHaveBeenCalledTimes(2);
    const fields = warn.mock.calls.map(([entry]) => entry);
    expect(fields).toEqual(
      expect.arrayContaining(
        conflicts.map((conflict) => ({
          event: 'union.pid.cross_account_active',
          app_id: h.appId,
          platform,
          pid_scene: 'share',
          pid_id: target.id,
          union_account_id: a.id,
          conflict_pid_id: conflict.id,
          conflict_union_account_id: conflict.union_account_id,
        })),
      ),
    );
    for (const [, message] of warn.mock.calls) {
      expect(typeof message).toBe('string');
      expect(message).not.toContain(h.auth.code);
      expect(message).not.toContain(target.hjy_ignore_evidence_path!);
    }
    warn.mockClear();
    const retired = await outcome(() =>
      service.setPidStatus({ ...h.auth, pidId: target.id, status: 'retired' }),
    );
    expect(retired).toMatchObject({ id: target.id, status: 'retired' });
    expect(warn).not.toHaveBeenCalled();
  }, 30_000);
}
