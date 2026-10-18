import { expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { setup, binding, seedState, type Action } from './kit.ts';
import { command, service, serviceOptions, userSessions } from './service-kit.ts';
const h = useHarness();

for (const action of ['ban', 'unban'] satisfies Action[]) {
  it.each(['sessions', 'bindings', 'audit', 'event'] as const)(
    `[AC-F1-07d#19] ${action} 在 %s 故障时整体回滚`,
    async (failure) => {
      const s = await setup(h);
      if (action === 'unban') await seedState(s, 'banned');
      await binding(s, action === 'unban' ? { status: 'blocked', blocked_reason: 'ban' } : {});
      await userSessions(s);
      const before = await s.snapshot();
      const deps = serviceOptions(s);
      const abort = new Error('synthetic-transaction-failure');
      // Unban has no session side effect: this variant fails at its binding port instead.
      const selected = failure === 'sessions' && action === 'unban' ? 'bindings' : failure;
      const revoke = vi.fn(async (...args: Parameters<typeof deps.revokeSessions>) => {
        const result = await deps.revokeSessions(...args);
        if (selected === 'sessions') throw abort;
        return result;
      });
      const link = vi.fn(async (...args: Parameters<typeof deps.blockForBan>) => {
        await (action === 'ban' ? deps.blockForBan : deps.restoreAfterUnban)(...args);
        if (selected === 'bindings') throw abort;
      });
      const publish = vi.spyOn(deps.events, 'publish');
      if (selected === 'event') publish.mockRejectedValueOnce(abort);
      try {
        const sut = service(s, {
          ...deps,
          revokeSessions: revoke,
          blockForBan: link,
          restoreAfterUnban: link,
          auditOn: (trx) => ({
            append: async (input) => {
              await deps.auditOn(trx).append(input);
              if (selected === 'audit') throw abort;
            },
          }),
        });
        await expect(sut.apply(command(s, action, action === 'ban' ? null : 7))).rejects.toBe(
          abort,
        );
        expect(await s.snapshot()).toEqual(before);
        if (action === 'unban') expect(revoke).not.toHaveBeenCalled();
      } finally {
        publish.mockRestore();
      }
    },
  );
}

it('[AC-F1-07d#20] 会话、绑定、状态、审计和事件使用同一个真实事务', async () => {
  const s = await setup(h);
  await binding(s);
  await userSessions(s);
  const deps = serviceOptions(s);
  const transactions: unknown[] = [];
  const set = vi.spyOn(deps.riskState, 'setRiskState');
  const publish = vi.spyOn(deps.events, 'publish');
  try {
    const sut = service(s, {
      ...deps,
      revokeSessions: async (trx, input) => {
        transactions.push(trx);
        expect(input).toEqual({ app_id: s.appId, user_id: s.userId, reason: 'banned' });
        return deps.revokeSessions(trx, input);
      },
      blockForBan: async (trx, input) => {
        transactions.push(trx);
        return deps.blockForBan(trx, input);
      },
      auditOn: (trx) => {
        transactions.push(trx);
        return deps.auditOn(trx);
      },
    });
    expect(await sut.apply(command(s))).toMatchObject({ state: 'banned' });
    expect(set).toHaveBeenCalledTimes(1);
    const trx = set.mock.calls[0]![0];
    expect(trx.isTransaction).toBe(true);
    expect(set.mock.calls[0]![1]).toMatchObject({ expected_row_version: null });
    expect(transactions).toHaveLength(3);
    for (const item of transactions) expect(item).toBe(trx);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toBe(trx);
    expect(await s.riskAudits()).toHaveLength(1);
    expect(await s.events()).toHaveLength(1);
  } finally {
    publish.mockRestore();
    set.mockRestore();
  }
});
