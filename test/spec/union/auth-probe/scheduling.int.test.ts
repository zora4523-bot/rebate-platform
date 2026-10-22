import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  createSiteAuthAlertPort,
  type TemplateSmsSender,
} from '../../../../apps/api/src/modules/notification/index.ts';
import { createSiteAuthMonitor } from '../../../../apps/api/src/modules/union/index.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { account, EXPIRES, harness, jobs, notifications, stored } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-S1-64#51] seed 按配置的 +08 每日时刻排队，重复 seed 使用相同 singleton，handle 执行巡检并续排', async () => {
  const h = harness(database());
  const a = await account(h);
  h.settings.set('union.auth_probe_cron', '15 10 * * *');
  await h.monitor.seed();
  const scheduled = h.send.mock.calls.filter(
    ([queue, , , o]) => queue === 'union-auth' && o.delaySeconds === 4500,
  );
  expect(scheduled.length).toBeGreaterThan(0);
  expect(h.configValue).toHaveBeenCalledWith(h.appId, 'union.auth_probe_cron');
  const first = scheduled[0]!;
  expect(first[3].singletonKey).toEqual(expect.any(String));
  await h.monitor.seed();
  const sameSlot = h.send.mock.calls.filter(
    ([queue, name, payload, o]) =>
      queue === first[0] &&
      name === first[1] &&
      JSON.stringify(payload) === JSON.stringify(first[2]) &&
      o.delaySeconds === 4500,
  );
  expect(new Set(sameSlot.map(([, , , o]) => o.singletonKey))).toEqual(
    new Set([first[3].singletonKey]),
  );
  h.clock.set('2026-12-16T02:15:00.000Z');
  h.send.mockClear();
  await h.monitor.handle({
    id: randomUUID(),
    queue: first[0],
    name: first[1],
    payload: first[2],
    attempt: 1,
  });
  expect(h.probe.mock.calls.filter(([p]) => p.unionAccountId === a.id)).toHaveLength(1);
  expect(
    h.send.mock.calls.some(([queue, , , o]) => queue === 'union-auth' && o.delaySeconds === 86_400),
  ).toBe(true);
});

for (const [expiry, delay] of [
  ['2026-12-17T01:00:00.000Z', 86_400],
  ['2026-12-17T01:00:00.001Z', null],
] as const) {
  it(`[AC-S1-64#52] 24小时到期窗口边界 ${expiry}，远期不排到期任务`, async () => {
    const h = harness(database());
    const a = await account(h, { auth_expires_at: expiry });
    await h.monitor.dailyCheck();
    const expiryJobs = jobs(h, a.id).filter(([, , payload]) =>
      JSON.stringify(payload).includes(expiry),
    );
    if (delay === null) expect(expiryJobs).toEqual([]);
    else {
      expect(expiryJobs).toHaveLength(1);
      expect(expiryJobs[0]?.[3].delaySeconds).toBe(delay);
      expect(expiryJobs[0]?.[3].singletonKey).toContain(a.id);
    }
  });
}

it('[AC-S1-64#53] 探测重试任务通过 handle 执行，已到期优先过期且不调用探测', async () => {
  const h = harness(database());
  const expiry = '2026-12-16T01:10:00.000Z';
  const a = await account(h, { auth_expires_at: expiry });
  h.probe.mockResolvedValue({ kind: 'transient', error: 'timeout' });
  await h.monitor.dailyCheck();
  const job = jobs(h, a.id).find(([, , , o]) => o.delaySeconds === 1800);
  expect(job).toBeDefined();
  h.clock.advanceMs(1_800_000);
  h.probe.mockClear();
  await h.monitor.handle({
    id: randomUUID(),
    queue: job![0],
    name: job![1],
    payload: job![2],
    attempt: 1,
  });
  expect(h.probe.mock.calls.filter(([p]) => p.unionAccountId === a.id)).toEqual([]);
  expect(await stored(h, a.id)).toMatchObject({ auth_status: 'expired', alert_stage: 'expired' });
});

it('[AC-S1-64#54] 重启 heal 找回未发告警任务，重建实例后依旧只发每号一次', async () => {
  const h = harness(database());
  const a = await account(h);
  const send = vi.fn<TemplateSmsSender['send']>(async () => 'accepted');
  const alerts = createSiteAuthAlertPort({
    db: h.db,
    clock: h.clock,
    logger: h.logger,
    sms: { send },
  });
  await h.db.transaction().execute((trx) =>
    alerts.plan(trx, {
      appId: h.appId,
      unionAccountId: a.id,
      platform: 'taobao',
      authExpiresAt: new Date(EXPIRES),
      stage: 'd14',
      code: 'UNION_AUTH_EXPIRING',
      phoneIds: ['13800138000', '13900139000'].map((phone) =>
        h.crypto.blindIndex(phone, 'union.auth_alert_phones'),
      ),
    }),
  );
  await h.db
    .updateTable('union_accounts')
    .set({ alert_stage: 'd14', auth_status: 'expiring' })
    .where('app_id', '=', h.appId)
    .where('id', '=', a.id)
    .execute();
  const monitor = createSiteAuthMonitor({ ...h.options, alerts });
  await monitor.heal();
  const recovered = jobs(h, a.id);
  expect(recovered.length).toBeGreaterThan(0);
  for (const [queue, name, payload] of recovered) {
    await monitor.handle({ id: randomUUID(), queue, name, payload, attempt: 1 });
  }
  expect((await notifications(h.db, h.appId)).map((r) => r.status)).toEqual(['success', 'success']);
  const restarted = createSiteAuthMonitor({ ...h.options, alerts });
  await restarted.deliverAlerts(h.appId, a.id);
  expect(send).toHaveBeenCalledTimes(2);
});
