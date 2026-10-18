import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { authorization } from '../../linking/admin-union-bindings/authorization-kit.ts';
import { setup, binding, body, accepted, type Scenario } from './kit.ts';
const h = useHarness();

async function held(s: Scenario, keyShare = false) {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const done = h.db
    .transaction()
    .execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '4s'`.execute(trx);
      const query = trx
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', s.appId)
        .where('id', '=', s.userId);
      await (keyShare ? query.forKeyShare() : query.forNoKeyUpdate()).executeTakeFirstOrThrow();
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      ready.resolve(pid.rows[0]!.pid);
      await release.promise;
    })
    .then(
      () => ({ ok: true }),
      (error: unknown) => {
        ready.reject(error);
        return { ok: false, error };
      },
    );
  return { pid: await ready.promise, release: () => release.resolve(), done };
}
async function waiting(pid: number) {
  const deadline = performance.now() + 2500;
  let seen = false;
  do {
    const result = await sql<{
      query: string;
    }>`SELECT query FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`.execute(
      h.db,
    );
    seen = result.rows.some(
      (row) => /users/i.test(row.query) && /for no key update/i.test(row.query),
    );
    if (seen) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (performance.now() < deadline);
  expect(seen, '后台先取得同一用户 FOR NO KEY UPDATE 锁').toBe(true);
}
async function finalBan(s: Scenario) {
  expect(await s.riskRows()).toMatchObject([{ state: 'banned' }]);
  expect((await s.rows()).filter((row) => ['active', 'invalid'].includes(row.status))).toEqual([]);
}

it.each(['taobao', 'pdd'])(
  '[AC-F1-07d#30] ban 与 %s enable 并发，不留 banned + active/invalid',
  async (platform) => {
    const s = await setup(h);
    const row = await binding(s, { platform, status: 'blocked', blocked_reason: 'admin_disable' });
    const banToken = await s.issue();
    const enableToken = await s.issue();
    const lock = await held(s);
    const ban = s.put(body('ban'), { token: banToken });
    let enable: ReturnType<typeof s.post> | undefined;
    try {
      await waiting(lock.pid);
      // State must still be absent while the user's lock is held elsewhere.
      expect(await s.riskRows()).toEqual([]);
      enable = s.post(
        'enable',
        { reason: '恢复授权', expected_row_version: row.row_version },
        { token: enableToken, platform },
      );
    } finally {
      lock.release();
      await Promise.allSettled([lock.done, ban, ...(enable === undefined ? [] : [enable])]);
    }
    expect(await lock.done).toEqual({ ok: true });
    await accepted(await ban);
    expect((await enable!).json().code).toBe(30154);
    await finalBan(s);
  },
);

for (const platform of ['taobao', 'pdd']) {
  it.each(['released', 'invalid'])(
    `[AC-F1-07d#31] ban 与 ${platform} 用户授权并发，原绑定 %s`,
    async (status) => {
      const s = await setup(h);
      const row = await binding(s, { platform, status });
      const auth = await authorization(s, row.union_account_id);
      if (status === 'invalid')
        auth.exchange.mockResolvedValue({ kind: 'bound', relationId: row.relation_id! });
      const token = await s.issue();
      const lock = await held(s);
      const ban = s.put(body('ban'), { token });
      let bindingRequest: Promise<unknown> | undefined;
      try {
        await waiting(lock.pid);
        bindingRequest = platform === 'taobao' ? auth.bind() : auth.pdd();
      } finally {
        lock.release();
        await Promise.allSettled([
          lock.done,
          ban,
          ...(bindingRequest === undefined ? [] : [bindingRequest]),
        ]);
      }
      expect(await lock.done).toEqual({ ok: true });
      await accepted(await ban);
      await expect(bindingRequest).resolves.toBeDefined();
      await finalBan(s);
    },
  );
}

it('[AC-F1-07d#32] 用户外键 KEY SHARE 不阻塞封禁，避免误用 FOR UPDATE', async () => {
  const s = await setup(h);
  const token = await s.issue();
  const lock = await held(s, true);
  const ban = s.put(body('ban'), { token });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ban,
      new Promise<'blocked'>((resolve) => {
        timer = setTimeout(() => resolve('blocked'), 2500);
      }),
    ]);
    expect(result).not.toBe('blocked');
    if (result !== 'blocked') await accepted(result);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    lock.release();
    await Promise.allSettled([lock.done, ban]);
  }
  await finalBan(s);
});
