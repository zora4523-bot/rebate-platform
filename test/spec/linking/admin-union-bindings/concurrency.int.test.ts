import { sql, type Transaction } from 'kysely';
import type { DB } from '@couli/db';
import { expect, it } from 'vitest';
import { blockForBan, restoreAfterUnban } from '../../../../apps/api/src/modules/linking/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { authorization } from './authorization-kit.ts';
import { setup, binding, risk, current, REASON, rejected, accepted, type Scenario } from './kit.ts';

const h = useHarness();

async function lock(trx: Transaction<DB>, s: Scenario) {
  await trx
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', s.appId)
    .where('id', '=', s.userId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
}
async function writeBan(trx: Transaction<DB>, s: Scenario) {
  await trx
    .insertInto('user_risk_state')
    .values({
      app_id: s.appId,
      user_id: s.userId,
      state: 'banned',
      reason_category: 'other',
      changed_by: 'synthetic-ban',
      changed_at: s.f.clock.now(),
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({ state: 'banned', reason_category: 'other' }),
    )
    .execute();
  await blockForBan(trx, { appId: s.appId, userId: s.userId, clock: s.f.clock });
}

/** A controlled transaction holds the shared lock; no sleeps or scheduler race decide order. */
async function held(s: Scenario, finish: (trx: Transaction<DB>) => Promise<void>) {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const done = h.db
    .transaction()
    .execute(async (trx) => {
      // A broken locking implementation must fail an assertion, never hang the suite.
      await sql`SET LOCAL lock_timeout = '4s'`.execute(trx);
      await lock(trx, s);
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      ready.resolve(pid.rows[0]!.pid);
      await release.promise;
      await finish(trx);
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
async function pollUntilTrue(check: () => boolean | Promise<boolean>, interval: number) {
  const deadline = performance.now() + 2500;
  let last = false;
  do {
    last = await check();
    if (last) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
  } while (performance.now() < deadline);
  expect(last).toBe(true);
}
async function waitingOnUser(pid: number) {
  await pollUntilTrue(async () => {
    const result = await sql<{ query: string }>`SELECT query FROM pg_stat_activity
      WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`.execute(h.db);
    return result.rows.some(
      (row) => /users/i.test(row.query) && /for no key update/i.test(row.query),
    );
  }, 20);
}
async function bannedWithoutActive(s: Scenario) {
  expect(
    await h.db
      .selectFrom('user_risk_state')
      .select('state')
      .where('app_id', '=', s.appId)
      .where('user_id', '=', s.userId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ state: 'banned' });
  expect((await s.rows()).filter((row) => ['active', 'invalid'].includes(row.status))).toEqual([]);
}

it.each(['taobao', 'pdd'])(
  '[AC-F1-07c#19] 封禁持用户锁时 %s enable 等待，提交后无 banned + invalid / active',
  async (platform) => {
    const s = await setup(h);
    const row = await binding(s, { platform, status: 'blocked', blocked_reason: 'admin_disable' });
    const token = await s.issue();
    const ban = await held(s, (trx) => writeBan(trx, s));
    const response = s.post(
      'enable',
      { reason: REASON, expected_row_version: row.row_version },
      { token, platform },
    );
    try {
      await waitingOnUser(ban.pid);
    } finally {
      ban.release();
      await Promise.allSettled([ban.done, response]);
    }
    expect(await ban.done).toEqual({ ok: true });
    await rejected(await response, 30154);
    await bannedWithoutActive(s);
    expect(await current(s, row.id)).toMatchObject({
      status: 'blocked',
      blocked_reason: 'admin_disable',
    });
    expect(await s.audits()).toEqual([]);
  },
);

for (const platform of ['taobao', 'pdd']) {
  for (const status of ['released', 'invalid']) {
    it(`[AC-F1-07c#20] 封禁与 ${platform}/${status} 普通授权争用同一用户锁，提交后无 banned + active`, async () => {
      const s = await setup(h);
      const row = await binding(s, { platform, status });
      // Deliberately no risk-state row: users is the lock anchor even on first risk write.
      const auth = await authorization(s, row.union_account_id);
      if (status === 'invalid')
        auth.exchange.mockResolvedValue({ kind: 'bound', relationId: row.relation_id! });
      const ban = await held(s, (trx) => writeBan(trx, s));
      const request = (platform === 'taobao' ? auth.bind() : auth.pdd()).then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      try {
        await waitingOnUser(ban.pid);
      } finally {
        ban.release();
        await Promise.allSettled([ban.done, request]);
      }
      expect(await ban.done).toEqual({ ok: true });
      expect(await request).toMatchObject({ ok: true });
      await bannedWithoutActive(s);
      expect(await current(s, row.id)).toMatchObject({
        status: status === 'released' ? 'released' : 'blocked',
      });
    });
  }
}

it('[AC-F1-07c#21] 淘宝换凭据期间不持用户锁，换完后重查已提交封禁', async () => {
  const s = await setup(h);
  const row = await binding(s, { status: 'released' });
  const auth = await authorization(s, row.union_account_id);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  auth.exchange.mockImplementation(async () => {
    entered.resolve();
    await resume.promise;
    return { kind: 'bound', relationId: 'synthetic-new-relation' };
  });
  const request = auth.bind();
  // Bound polling also exposes early errors without hanging on an unreached exchange barrier.
  try {
    await pollUntilTrue(() => auth.exchange.mock.calls.length === 1, 50);
    await entered.promise;
    const ban = h.db
      .transaction()
      .execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
        await lock(trx, s);
        await writeBan(trx, s);
      })
      .then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
    expect(await ban).toEqual({ ok: true });
  } finally {
    resume.resolve();
    await Promise.allSettled([request]);
  }
  expect((await request).envelope.code).not.toBe(0);
  await bannedWithoutActive(s);
});

it.each([blockForBan, restoreAfterUnban])(
  '[AC-F1-07c#22] 联动端口 %s 自己取得用户锁',
  async (port) => {
    const s = await setup(h);
    await binding(
      s,
      port === restoreAfterUnban ? { status: 'blocked', blocked_reason: 'ban' } : {},
    );
    await risk(s, 'normal');
    const holder = await held(s, async () => undefined);
    const operation = h.db
      .transaction()
      .execute((trx) =>
        port(trx, {
          appId: s.appId,
          userId: s.userId,
          clock: s.f.clock,
        }),
      )
      .then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
    try {
      await waitingOnUser(holder.pid);
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, operation]);
    }
    expect(await operation).toEqual({ ok: true });
    expect((await s.rows())[0]?.status).toBe(port === restoreAfterUnban ? 'invalid' : 'blocked');
  },
);

it.each(['reset', 'disable'] as const)(
  '[AC-F1-07c#24] 后台 %s 也取得同一把用户锁后才改绑定',
  async (action) => {
    const s = await setup(h);
    const row = await binding(s);
    const token = await s.issue();
    const holder = await held(s, async () => undefined);
    const response = s.post(
      action,
      { reason: REASON, expected_row_version: row.row_version },
      { token },
    );
    try {
      await waitingOnUser(holder.pid);
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, response]);
    }
    await accepted(await response);
    expect(await current(s, row.id)).toMatchObject({
      status: action === 'reset' ? 'released' : 'blocked',
      row_version: row.row_version + 1,
    });
  },
);
