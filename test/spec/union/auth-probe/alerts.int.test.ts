import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  createSiteAuthAlertPort,
  type SiteAuthAlertPlan,
  type TemplateSmsSender,
} from '../../../../apps/api/src/modules/notification/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { memoryLogger } from '../../platform/queue/kit.ts';
import {
  account,
  cryptoDouble,
  EXPIRES,
  NOW,
  notifications,
  PHONE_CONTEXT,
  PHONES,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);
function fixture() {
  const db = database();
  const appId = `auth-sms-${randomUUID()}`;
  const clock = new FixedClock(NOW);
  const { logger, lines } = memoryLogger('worker');
  const send = vi.fn<TemplateSmsSender['send']>(async () => 'accepted');
  const port = createSiteAuthAlertPort({ db, clock, logger, sms: { send } });
  const crypto = cryptoDouble();
  const phones = PHONES.map((phone) => ({
    phone,
    phoneId: crypto.blindIndex(phone, PHONE_CONTEXT),
  }));
  const plan: SiteAuthAlertPlan = {
    appId,
    unionAccountId: randomUUID(),
    platform: 'taobao',
    authExpiresAt: new Date(EXPIRES),
    stage: 'd14',
    code: 'UNION_AUTH_EXPIRING',
    phoneIds: phones.map((p) => p.phoneId),
  };
  return { db, appId, clock, logger, lines, send, port, phones, plan };
}

it('[AC-S1-64#20] 同事务每号一行 queued，user_id 空，HMAC 去重键，无明文号码', async () => {
  const h = fixture();
  await account(h, { id: h.plan.unionAccountId });
  const added = await h.db.transaction().execute(async (trx) => {
    const first = await h.port.plan(trx, h.plan);
    const second = await h.port.plan(trx, h.plan);
    return [first, second];
  });
  expect(added).toEqual([2, 0]);
  const rows = await notifications(h.db, h.appId);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.dedupe_key).sort()).toEqual(
    h.phones.map((p) => `union_auth:${h.plan.unionAccountId}:${EXPIRES}:d14:${p.phoneId}`).sort(),
  );
  for (const row of rows)
    expect(row).toMatchObject({
      user_id: null,
      channel: 'sms',
      code: 'UNION_AUTH_EXPIRING',
      status: 'queued',
      planned_at: h.clock.now(),
      sent_at: null,
    });
  for (const phone of PHONES) expect(JSON.stringify(rows) + h.lines.join('')).not.toContain(phone);
});

it('[AC-S1-64#21] 并发重复登记由唯一约束兜底，到期时间/阶段/账号/app 互不串号', async () => {
  const h = fixture();
  await account(h, { id: h.plan.unionAccountId });
  const added = await Promise.all(
    Array.from({ length: 4 }, () => h.db.transaction().execute((trx) => h.port.plan(trx, h.plan))),
  );
  expect(added.reduce((a, b) => a + b, 0)).toBe(2);
  const other = await account(h);
  const tenant = { ...h, appId: `auth-sms-${randomUUID()}` };
  const tenantAccount = await account(tenant);
  for (const plan of [
    { ...h.plan, stage: 'd7' },
    { ...h.plan, authExpiresAt: new Date('2027-03-29T16:00:00Z') },
    { ...h.plan, unionAccountId: other.id },
    { ...h.plan, appId: tenant.appId, unionAccountId: tenantAccount.id },
  ])
    expect(await h.db.transaction().execute((trx) => h.port.plan(trx, plan))).toBe(2);
  expect(await notifications(h.db, h.appId)).toHaveLength(8);
  expect(await notifications(h.db, tenant.appId)).toHaveLength(2);
});

it('[AC-S1-64#22] 计划随调用方事务回滚；auth_expires_at 空用 none 编码', async () => {
  const h = fixture();
  await account(h, { id: h.plan.unionAccountId });
  const plan = {
    ...h.plan,
    authExpiresAt: null,
    stage: 'expired',
    code: 'UNION_AUTH_EXPIRED' as const,
  };
  await expect(
    h.db.transaction().execute(async (trx) => {
      await h.port.plan(trx, plan);
      throw new Error('abort-after-plan');
    }),
  ).rejects.toThrow('abort-after-plan');
  expect(await notifications(h.db, h.appId)).toEqual([]);
  await h.db.transaction().execute((trx) => h.port.plan(trx, plan));
  expect((await notifications(h.db, h.appId)).map((r) => r.dedupe_key).sort()).toEqual(
    h.phones.map((p) => `union_auth:${h.plan.unionAccountId}:none:expired:${p.phoneId}`).sort(),
  );
});

for (const result of ['accepted', 'unknown', 'rejected'] as const) {
  it(`[AC-S1-64#23] 短信 ${result} 持久化结果，重复交付不重发，失败只记录脱敏号`, async () => {
    const h = fixture();
    await account(h, { id: h.plan.unionAccountId });
    h.send.mockResolvedValue(result);
    await h.db.transaction().execute((trx) => h.port.plan(trx, h.plan));
    await h.port.deliver(h.appId, h.plan.unionAccountId, h.phones);
    await h.port.deliver(h.appId, h.plan.unionAccountId, h.phones);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls.map(([m]) => m.phone).sort()).toEqual([...PHONES].sort());
    for (const [message] of h.send.mock.calls)
      expect(message).toMatchObject({
        appId: h.appId,
        template: 'UNION_AUTH_EXPIRING',
        params: { platform_name: '淘宝', expires_at: '2026-12-30 00:00' },
      });
    for (const row of await notifications(h.db, h.appId))
      expect(row).toMatchObject({
        status: result === 'rejected' ? 'failed' : 'success',
        sent_at: result === 'rejected' ? null : h.clock.now(),
      });
    const failures = h.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'union_auth_sms_failed');
    expect(failures).toHaveLength(result === 'rejected' ? 2 : 0);
    if (result === 'rejected') {
      expect(failures.every((line) => line.level === 50)).toBe(true);
      expect(JSON.stringify(failures)).toContain('138****8000');
      expect(JSON.stringify(failures)).toContain('139****9000');
    }
    for (const phone of PHONES) expect(h.lines.join('')).not.toContain(phone);
  });
}

it('[AC-S1-64#24] 只交付本 app、本账号 queued；期间删号记 failed，新增号不补发', async () => {
  const h = fixture();
  await account(h, { id: h.plan.unionAccountId });
  const other = await account(h);
  const tenant = { ...h, appId: `auth-sms-${randomUUID()}` };
  const tenantAccount = await account(tenant);
  for (const plan of [
    h.plan,
    { ...h.plan, unionAccountId: other.id },
    { ...h.plan, appId: tenant.appId, unionAccountId: tenantAccount.id },
  ]) {
    await h.db.transaction().execute((trx) => h.port.plan(trx, plan));
  }
  await h.port.deliver(h.appId, h.plan.unionAccountId, [
    h.phones[0]!,
    { phone: '13700137000', phoneId: 'new-phone-id' },
  ]);
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.send.mock.calls[0]?.[0].phone).toBe(PHONES[0]);
  const rows = await notifications(h.db, h.appId);
  expect(
    rows
      .filter((r) => r.dedupe_key.includes(h.plan.unionAccountId))
      .map((r) => r.status)
      .sort(),
  ).toEqual(['failed', 'success']);
  expect(rows.filter((r) => r.dedupe_key.includes(other.id)).map((r) => r.status)).toEqual([
    'queued',
    'queued',
  ]);
  expect((await notifications(h.db, tenant.appId)).map((r) => r.status)).toEqual([
    'queued',
    'queued',
  ]);
});

it('[AC-S1-64#25] 运维短信不查用户开关，不受免打扰阻断；三个平台中文名及 +08 时间准确', async () => {
  const h = fixture();
  h.clock.set('2026-12-16T16:30:00Z');
  await h.db
    .insertInto('config_items')
    .values({
      app_id: h.appId,
      key: 'notify.quiet_hours',
      updated_by: 'synthetic-fixture',
      value: { start: '00:00', end: '23:59' },
      version: 1,
    })
    .execute();
  for (const [platform, name] of [
    ['taobao', '淘宝'],
    ['jd', '京东'],
    ['pdd', '拼多多'],
  ] as const) {
    const a = await account(h, { platform });
    await h.db.transaction().execute((trx) =>
      h.port.plan(trx, {
        ...h.plan,
        unionAccountId: a.id,
        platform,
        authExpiresAt: new Date('2026-12-31T16:05:00Z'),
      }),
    );
    await h.port.deliver(h.appId, a.id, h.phones);
    expect(h.send.mock.calls.slice(-2).map(([m]) => m.params)).toEqual([
      { platform_name: name, expires_at: '2027-01-01 00:05' },
      { platform_name: name, expires_at: '2027-01-01 00:05' },
    ]);
  }
  expect(h.send).toHaveBeenCalledTimes(6);
});
