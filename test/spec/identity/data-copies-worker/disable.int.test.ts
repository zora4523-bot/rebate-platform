// B1-27h（08 BR-ID-40 细则「重新登记与登记人停用」、BR-ID-43；brief §9 ⑥）：超级管理员停用后台账号时，在
// admin-account-writes 的停用事务里（导出取消 cancelByCreator 旁），把该账号登记、还没交付的企业微信路径请求
// （pending / running / ready）置为 failed 并各写一条审计（记停用操作人）；已交付的、站内信路径的、别的
// 登记人的请求不受影响。停用回滚时这些也一并回滚。停用事务拿不到存储：置为失败的请求留下的文件由到期的
// expire 作业删除。生成进行中被停用的，生成的运行完成前校验令牌，请求停在 failed，不留下无人记录的文件。
// admin 的 createAdminAccountWrites 与 createExportCanceller 照 admin 入口的装配直接构造（运行时导入），
// 依赖不变：identity 这一步只能经 identity/index.ts 接进停用事务。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Clock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { settledOrWaiting } from '../deletion-processing/kit.ts';
import {
  DAY_MS,
  EXPIRE,
  GENERATE,
  HOUR_MS,
  MINUTE_MS,
  ROOT,
  SECOND_MS,
  admin,
  at,
  close,
  fixture,
  open,
  text,
  type Base,
  type CopyRow,
  type Fixture,
} from './kit.ts';

const TIMEOUT = 120_000;
let database: TestDatabase | undefined;
let base: Base | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  base = await open(database);
}, TIMEOUT);

afterAll(async () => {
  try {
    await close(base);
  } finally {
    await database?.drop();
  }
});

function harness(): Base {
  if (base === undefined) throw new Error('the test database is not open');
  return base;
}

interface Revocations {
  voidBefore(account: { appId: string; adminId: string }, atMs: number): Promise<void>;
  voidedAt(account: { appId: string; adminId: string }): Promise<number | null>;
}

interface AccountWrites {
  disable(input: {
    readonly appId: string;
    readonly actor: string;
    readonly ip: string | null;
    readonly adminId: string;
    readonly reason: string;
  }): Promise<{ readonly kind: string }>;
}

interface AdminWritesApi {
  createAdminAccountWrites(deps: {
    readonly db: Kysely<DB>;
    readonly clock: Clock;
    readonly sensitiveKeys: readonly string[];
    readonly exports: unknown;
    readonly revocations: Revocations;
  }): AccountWrites;
}

interface CancellerApi {
  createExportCanceller(options: { readonly clock: Clock }): unknown;
}

const WORKING: Revocations = {
  voidBefore: async () => undefined,
  voidedAt: async () => null,
};

const BROKEN: Revocations = {
  voidBefore: async () => {
    throw new Error('revocation store unavailable');
  },
  voidedAt: async () => null,
};

/** admin's account writes as the admin entry assembles them (dependencies unchanged). */
async function accountWrites(f: Fixture, revocations: Revocations): Promise<AccountWrites> {
  const writes = (await import(
    new URL('apps/api/src/modules/admin/infra/admin-account-writes.ts', ROOT).href
  )) as AdminWritesApi;
  const exportWorker = (await import(
    new URL('apps/api/src/modules/admin/application/export-worker.ts', ROOT).href
  )) as CancellerApi;
  return writes.createAdminAccountWrites({
    db: f.db.withSchema('app'),
    clock: f.clock,
    sensitiveKeys: [],
    exports: exportWorker.createExportCanceller({ clock: f.clock }),
    revocations,
  });
}

function disabling(f: Fixture, actor: string) {
  return {
    appId: f.appId,
    actor,
    ip: '192.0.2.10',
    adminId: f.registrant,
    reason: '客服离职交接',
  };
}

async function adminStatus(f: Fixture, id: string): Promise<string> {
  const row = await f.db
    .withSchema('app')
    .selectFrom('admin_users')
    .select('status')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.status;
}

it('[AC-B1-27h#25] 停用登记人：其未交付的企业微信路径请求（pending / running / ready）置 failed 并各写一条审计（停用操作人）；已交付的、站内信路径的、别人登记的不动；停用失败回滚时一个也不改', async () => {
  const f = await fixture(harness());
  const actor = await admin(f.db, f.appId, true);
  const colleague = await admin(f.db, f.appId);
  const seed = async (
    delivery: 'in_app_sms' | 'wecom_session',
    status: 'pending' | 'running' | 'ready' | 'delivered',
    requestedBy = f.registrant,
  ): Promise<CopyRow> => {
    const u = await f.user();
    const generated = status === 'ready' || status === 'delivered';
    return f.copy({
      userId: u.uid,
      delivery,
      status,
      requestedBy,
      rowVersion: status === 'pending' ? 0 : 1,
      updatedAt: at(-MINUTE_MS),
      generatedAt: generated ? at(-HOUR_MS) : null,
      expiresAt: generated ? at(DAY_MS - HOUR_MS) : null,
      deliveredAt: status === 'delivered' ? at(-MINUTE_MS) : null,
      objectKey: generated ? `seeded/${u.uid}.zip` : null,
    });
  };
  const failing = [
    await seed('wecom_session', 'pending'),
    await seed('wecom_session', 'running'),
    await seed('wecom_session', 'ready'),
  ];
  const kept = [
    await seed('wecom_session', 'delivered'),
    await seed('in_app_sms', 'pending'),
    await seed('in_app_sms', 'running'),
    await seed('wecom_session', 'ready', colleague),
  ];

  await expect((await accountWrites(f, BROKEN)).disable(disabling(f, actor))).rejects.toThrow();
  expect(await adminStatus(f, f.registrant)).toBe('active');
  for (const row of [...failing, ...kept]) expect(await f.row(row.id)).toEqual(row);

  f.clock.advanceMs(MINUTE_MS);
  const result = await (await accountWrites(f, WORKING)).disable(disabling(f, actor));
  expect(result.kind).toBe('written');
  expect(await adminStatus(f, f.registrant)).toBe('disabled');
  for (const row of failing) {
    const after = await f.row(row.id);
    expect(after.status, row.status).toBe('failed');
    expect(after.failure_reason, row.status).toEqual(expect.any(String));
    expect(after.failure_reason!.trim()).not.toBe('');
    expect(after.delivered_at).toBeNull();
    expect(after.updated_at).toEqual(f.clock.now());
    expect(after.row_version).toBeGreaterThan(row.row_version);
    const audits = await f.audits(row.id);
    expect(audits, row.status).toHaveLength(1);
    expect(audits[0]!.admin_id).toBe(actor);
    expect(text(audits[0])).toContain('failed');
  }
  for (const row of kept) {
    expect(await f.row(row.id), `${row.delivery} ${row.status}`).toEqual(row);
    expect(await f.audits(row.id)).toEqual([]);
  }
});

it('[AC-B1-27h#26] 停用时 ready 的企业微信副本置 failed 后，文件由到期的 expire 作业删除、object_key 清空，状态仍是 failed', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const actor = await admin(f.db, f.appId, true);
  const u = await f.user();
  const row = await f.copy({
    userId: u.uid,
    delivery: 'wecom_session',
    status: 'ready',
    rowVersion: 1,
    generatedAt: at(-HOUR_MS),
    expiresAt: at(DAY_MS - HOUR_MS),
  });
  const key = await f.storedObject(row.id);
  await f.db
    .withSchema('app')
    .updateTable('personal_data_copies')
    .set({ object_key: key })
    .where('id', '=', row.id)
    .execute();
  expect((await (await accountWrites(f, WORKING)).disable(disabling(f, actor))).kind).toBe(
    'written',
  );
  expect((await f.row(row.id)).status).toBe('failed');

  f.clock.set(at(DAY_MS - HOUR_MS + SECOND_MS));
  await worker.handle(f.job(EXPIRE, row.id));
  const after = await f.row(row.id);
  expect(after.status).toBe('failed');
  expect(after.object_key).toBeNull();
  expect(f.store.get(key)).toBeUndefined();
  expect(f.liveKeys()).toEqual([]);
});

it('[AC-B1-27h#27] 生成进行中被停用：请求停在 failed（不会再变成 ready），不发短信；留下的文件必须记在 object_key 上，并由到期的 expire 作业删除', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const actor = await admin(f.db, f.appId, true);
  const u = await f.user();
  const row = await f.copy({ userId: u.uid, delivery: 'wecom_session' });
  const hold = f.holdRead();
  const run = worker.handle(f.job(GENERATE, row.id));
  await hold.entered;
  const disable = (await accountWrites(f, WORKING)).disable(disabling(f, actor));
  await settledOrWaiting(f.db, disable);
  hold.release();
  const [, result] = await Promise.all([run.catch(() => undefined), disable]);
  expect(result.kind).toBe('written');

  const after = await f.row(row.id);
  expect(after.status).toBe('failed');
  expect(after.delivered_at).toBeNull();
  expect(f.sms.outbox).toEqual([]);
  expect(f.liveKeys()).toEqual(after.object_key === null ? [] : [after.object_key]);
  if (after.object_key !== null) {
    expect(after.expires_at).not.toBeNull();
    f.clock.set(new Date(after.expires_at!.getTime() + SECOND_MS));
    await worker.handle(f.job(EXPIRE, row.id));
    expect(f.liveKeys()).toEqual([]);
    expect((await f.row(row.id)).object_key).toBeNull();
  }
  await worker.handle(f.job(GENERATE, row.id));
  expect((await f.row(row.id)).status).toBe('failed');
});
