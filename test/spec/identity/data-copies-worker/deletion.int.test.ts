// B1-27h（08 BR-ID-40 细则「副本请求与注销状态」、BR-ID-28；brief §9 ⑦）：账号进入注销 processing 后，
// deletion-processing 的清理事务把该用户未结束的副本请求（pending / running / ready）置为 cancelled（与清理
// 同提交、同回滚），并删除该用户的全部副本文件（已交付、还没过期的也删，object_key 清空）；删除失败只记
// 日志，清理照常完成，文件仍记在 object_key 上、由到期的 expire 作业兜底删除。别的用户、冷静期用户与已结束
// 请求的状态不动。装配版：worker 入口的注销定时任务（app.module 传的选项）拿到私有导出存储并照此删除。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DeletionCleanupPortName } from '../../../../apps/api/src/modules/identity/ports/deletion-cleanup.ts';
import type { ExportStore } from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import {
  capturedWorkerOptions,
  identity as deletionApi,
  ports,
  request,
  seedRequest,
  settledOrWaiting,
} from '../deletion-processing/kit.ts';
import {
  DAY_MS,
  EXPIRE,
  GENERATE,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  SENTINEL,
  at,
  close,
  fixture,
  identity,
  nestContext,
  open,
  warnings,
  type Base,
  type CopyRow,
  type CopySeed,
  type Fixture,
  type IdentityCopyApi,
  type Member,
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

/** identity's deletion processing over no-op owner ports (a port can be made to throw). */
interface ProcessingControls {
  readonly store?: Pick<ExportStore, 'delete'>;
  readonly failing?: DeletionCleanupPortName;
}

function processing(f: Fixture, api: IdentityCopyApi, options: ProcessingControls = {}) {
  const port = (name: DeletionCleanupPortName) => async () => {
    if (options.failing === name) throw new Error('cleanup port failed');
  };
  return api.createDeletionProcessing({
    db: f.db,
    clock: f.clock,
    logger: f.logger,
    cleanup: {
      linking: port('linking'),
      growth: port('growth'),
      notification: port('notification'),
      agent: port('agent'),
      catalog: port('catalog'),
    },
    funds: { closingAdjustmentState: async () => 'none_needed' },
    withdrawals: { hasSucceeded: async () => false },
    apple: { revoke: async () => undefined },
    ...(options.store === undefined ? {} : { dataCopyStore: options.store }),
  });
}

const GENERATED = {
  generatedAt: at(-HOUR_MS),
  expiresAt: at(DAY_MS - HOUR_MS),
  rowVersion: 1,
} as const;

/** A copy with a stored file recorded in object_key. */
async function withFile(f: Fixture, seed: Omit<CopySeed, 'appId' | 'requestedBy'>) {
  const row = await f.copy({ ...GENERATED, ...seed });
  const key = await f.storedObject(row.id);
  await f.db
    .withSchema('app')
    .updateTable('personal_data_copies')
    .set({ object_key: key })
    .where('id', '=', row.id)
    .execute();
  return { row: await f.row(row.id), key };
}

/** A member whose deletion is processing. */
async function deleting(f: Fixture) {
  const m = await f.user('deleting');
  const req = await seedRequest(f.db, m, { status: 'processing' });
  return { m, req };
}

it('[AC-B1-27h#28] 清理把 processing 用户的 pending / running / ready 请求置 cancelled（row_version 加一、updated_at 为清理时刻）；该用户已结束的请求、别的用户与冷静期用户的请求不动；没有存储时文件仍记在 object_key 上', async () => {
  const f = await fixture(harness());
  const api = await identity();
  const opened: { row: CopyRow; status: string }[] = [];
  const members: Member[] = [];
  for (const status of ['pending', 'running', 'ready'] as const) {
    const { m } = await deleting(f);
    members.push(m);
    const generated = status === 'ready';
    const row = await f.copy({
      userId: m.uid,
      delivery: generated ? 'wecom_session' : 'in_app_sms',
      status,
      rowVersion: status === 'pending' ? 0 : 1,
      updatedAt: at(-MINUTE_MS),
      generatedAt: generated ? GENERATED.generatedAt : null,
      expiresAt: generated ? GENERATED.expiresAt : null,
      objectKey: generated ? `seeded/${m.uid}.zip` : null,
    });
    opened.push({ row, status });
  }
  const owner = members[0]!;
  const finished = [
    await f.copy({
      ...GENERATED,
      userId: owner.uid,
      status: 'delivered',
      deliveredAt: at(-MINUTE_MS),
      objectKey: `seeded/${owner.uid}-delivered.zip`,
    }),
    await f.copy({ ...GENERATED, userId: owner.uid, status: 'expired' }),
    await f.copy({ userId: owner.uid, status: 'failed', failureReason: '演示失败' }),
  ];
  const normal = await f.user();
  const cooling = await f.user();
  await seedRequest(f.db, cooling, { status: 'cooling' });
  const untouched = [
    await f.copy({ userId: normal.uid }),
    await f.copy({ userId: cooling.uid, delivery: 'wecom_session' }),
  ];

  await processing(f, api).runOnce();

  for (const { row, status } of opened) {
    const after = await f.row(row.id);
    expect(after.status, status).toBe('cancelled');
    expect(after.row_version, status).toBeGreaterThan(row.row_version);
    expect(after.updated_at, status).toEqual(f.clock.now());
    expect(after.delivered_at).toBeNull();
    expect(after.object_key, status).toBe(row.object_key);
  }
  for (const row of [...finished, ...untouched]) {
    expect(await f.row(row.id), `${row.status} ${row.user_id}`).toEqual(row);
  }
});

it('[AC-B1-27h#29] 取消与清理同一事务：清理回滚（某个属主端口抛错）时请求不变；下一轮清理成功时才取消', async () => {
  const f = await fixture(harness());
  const api = await identity();
  const { m, req } = await deleting(f);
  const row = await f.copy({ userId: m.uid, delivery: 'in_app_sms' });
  await processing(f, api, { failing: 'catalog' }).runOnce();
  expect(await f.row(row.id)).toEqual(row);
  expect((await request(f.db, req.id)).cleaned_at).toBeNull();
  await processing(f, api).runOnce();
  expect((await f.row(row.id)).status).toBe('cancelled');
});

it('[AC-B1-27h#30] 有存储时清理删除该用户全部副本文件（ready 取消后的与已交付未过期的），object_key 清空、已交付的状态不变；别的用户的文件不动', async () => {
  const f = await fixture(harness());
  const api = await identity();
  const { m } = await deleting(f);
  const ready = await withFile(f, { userId: m.uid, delivery: 'wecom_session', status: 'ready' });
  const delivered = await withFile(f, {
    userId: m.uid,
    delivery: 'in_app_sms',
    status: 'delivered',
    deliveredAt: at(-MINUTE_MS),
  });
  const other = await f.user();
  const kept = await withFile(f, { userId: other.uid, delivery: 'wecom_session', status: 'ready' });

  await processing(f, api, { store: f.store }).runOnce();

  const readyAfter = await f.row(ready.row.id);
  expect(readyAfter).toMatchObject({ status: 'cancelled', object_key: null });
  const deliveredAfter = await f.row(delivered.row.id);
  expect(deliveredAfter).toMatchObject({
    status: 'delivered',
    object_key: null,
    delivered_at: delivered.row.delivered_at,
  });
  expect(f.store.get(ready.key)).toBeUndefined();
  expect(f.store.get(delivered.key)).toBeUndefined();
  expect(await f.row(kept.row.id)).toEqual(kept.row);
  expect(f.store.get(kept.key)).toBeDefined();
});

it('[AC-B1-27h#31] 删除文件失败只记日志：清理照常完成、请求照常取消，文件仍记在 object_key 上，到期的 expire 作业兜底删除', async () => {
  const f = await fixture(harness());
  const api = await identity();
  const { m, req } = await deleting(f);
  const ready = await withFile(f, { userId: m.uid, delivery: 'wecom_session', status: 'ready' });
  const broken: Pick<ExportStore, 'delete'> = {
    delete: async () => {
      throw new Error(SENTINEL);
    },
  };

  await processing(f, api, { store: broken }).runOnce();

  expect((await request(f.db, req.id)).cleaned_at).not.toBeNull();
  const after = await f.row(ready.row.id);
  expect(after.status).toBe('cancelled');
  expect(after.object_key).toBe(ready.key);
  expect(f.store.get(ready.key)).toBeDefined();
  expect(warnings(f).length).toBeGreaterThan(0);
  expect(f.lines.join('\n')).not.toContain(SENTINEL);

  const worker = await f.worker();
  f.clock.set(new Date(after.expires_at!.getTime() + SECOND_MS));
  await worker.handle(f.job(EXPIRE, ready.row.id));
  expect(f.store.get(ready.key)).toBeUndefined();
  expect(await f.row(ready.row.id)).toMatchObject({ status: 'cancelled', object_key: null });
});

it('[AC-B1-27h#32] 装配版：worker 入口的注销定时任务（app.module 传的选项，私有导出存储在 EXPORT_STORE）一轮就取消 processing 用户的请求并删除其文件', async () => {
  const f = await fixture(harness());
  const { m } = await deleting(f);
  const ready = await withFile(f, { userId: m.uid, delivery: 'wecom_session', status: 'ready' });
  const api = await deletionApi();
  const p = await ports();
  const options = await capturedWorkerOptions(api, p);
  vi.restoreAllMocks();
  const context = await nestContext(api.IdentityDeletionExpiryModule.forWorker(options as never), [
    { provide: p.platform.CLOCK, useValue: f.clock },
    { provide: p.platform.ROOT_LOGGER, useValue: f.logger },
    { provide: p.platform.APP_CONFIG, useValue: p.platform.loadConfig({ APP_ENV: 'test' }) },
    { provide: p.platform.DB, useValue: f.db },
    { provide: p.platform.FIELD_CRYPTO, useValue: f.crypto },
    { provide: p.platform.EXPORT_STORE, useValue: f.store },
  ]);
  try {
    const runner = context.get(api.deletionExpiryToken()) as { runOnce(): Promise<unknown> };
    await runner.runOnce();
    expect(await f.row(ready.row.id)).toMatchObject({ status: 'cancelled', object_key: null });
    expect(f.store.get(ready.key)).toBeUndefined();
  } finally {
    await context.close();
  }
}, 60_000);

it('[AC-B1-27h#33] 生成进行中账号的注销清理取消了请求：请求停在 cancelled（不会再变成 delivered），不发短信、不写站内信、不记交付；留下的文件必须记在 object_key 上，并由到期的 expire 作业删除', async () => {
  const f = await fixture(harness());
  const api = await identity();
  const worker = await f.worker();
  f.useCopy();
  const m = await f.user();
  const row = await f.copy({ userId: m.uid, delivery: 'in_app_sms' });
  const hold = f.holdRead();
  const run = worker.handle(f.job(GENERATE, row.id));
  const settled = run.catch(() => undefined);
  // An implementation may also end the run before reading the content: do not wait on the read only.
  await Promise.race([hold.entered, settled]);
  // The account enters processing while generation is reading the content.
  await f.db
    .withSchema('app')
    .updateTable('users')
    .set({ status: 'deleting' })
    .where('app_id', '=', m.appId)
    .where('id', '=', m.uid)
    .execute();
  const req = await seedRequest(f.db, m, { status: 'processing' });
  const cleanup = processing(f, api, { store: f.store }).runOnce();
  await settledOrWaiting(f.db, cleanup);
  hold.release();
  await Promise.all([settled, cleanup]);

  expect((await request(f.db, req.id)).cleaned_at).not.toBeNull();
  const after = await f.row(row.id);
  expect(after.status).toBe('cancelled');
  expect(after.delivered_at).toBeNull();
  expect(f.sms.outbox).toEqual([]);
  expect(await f.inbox(m.uid)).toEqual([]);
  expect(f.liveKeys()).toEqual(after.object_key === null ? [] : [after.object_key]);
  if (after.object_key !== null) {
    expect(after.expires_at).not.toBeNull();
    f.clock.set(new Date(after.expires_at!.getTime() + SECOND_MS));
    await worker.handle(f.job(EXPIRE, row.id));
    expect(f.liveKeys()).toEqual([]);
    expect((await f.row(row.id)).object_key).toBeNull();
  }
  await worker.handle(f.job(GENERATE, row.id));
  expect((await f.row(row.id)).status).toBe('cancelled');
  expect(f.sms.outbox).toEqual([]);
}, 60_000);
