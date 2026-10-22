import { createTestDatabase } from '@couli/db/testing';
// BR-ID-42 / BR-ID-33; CT-24k and B1-34e's task notes define worker-specific boundaries.
// Download/retry HTTP authorization and account-disable wiring belong to later tasks.
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import * as domain from '@couli/domain';
import {
  auditText,
  csv,
  databaseHarness,
  DAY,
  fixture,
  parseCsv,
  running,
  seedAdmin,
  START,
  userRow,
} from './kit.ts';

const h = databaseHarness(createTestDatabase);

it('[AC-B1-34e#1] pending → running → done uses generated transitions and the injected completion clock', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const task = await f.task();
  const transition = vi.spyOn(domain, 'transitionExportTask');
  const original = f.page.getMockImplementation()!;
  f.page.mockImplementation(async (query) => {
    expect(await f.read(task.id)).toMatchObject({ status: 'running' });
    f.clock.advanceMs(120_000);
    return original(query);
  });
  try {
    await worker.handle(f.job(task.id));
    const row = await f.read(task.id);
    expect(row).toMatchObject({
      status: 'done',
      progress: 100,
      row_count: 3,
      failure_reason: null,
      generated_at: f.clock.now(),
      updated_at: f.clock.now(),
    });
    expect(row.row_version).toBeGreaterThan(task.row_version);
    expect(row.expires_at?.getTime()).toBe(f.clock.now().getTime() + DAY);
    expect(row.expires_at?.getTime()).not.toBe(new Date(START).getTime() + DAY);
    expect(transition).toHaveBeenCalledWith('pending', 'START');
    expect(transition).toHaveBeenCalledWith('running', 'COMPLETE');
    const records = parseCsv(await csv(f, task.id));
    expect(records).toHaveLength(4);
    expect(records[0]).toHaveLength(6);
    for (const source of f.rows) {
      expect(records.slice(1)).toEqual(
        expect.arrayContaining([expect.arrayContaining(Object.values(source))]),
      );
    }
    expect(f.configValue).toHaveBeenCalledWith(f.appId, 'admin.export.max_rows');
    expect(f.configValue).toHaveBeenCalledWith(f.appId, 'admin.export.max_running_per_admin');
  } finally {
    transition.mockRestore();
  }
});

it('[AC-B1-34e#2] CSV has BOM, RFC 4180 quoting and protects each formula prefix', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const names = ['=1+1', '+SUM(A1)', '-1+2', '@SUM(A1)', '逗号,和"引号"\r\n换行', '普通中文'];
  f.rows.splice(0, f.rows.length, ...names.map((nickname, i) => ({ ...userRow(i), nickname })));
  const task = await f.task();
  await worker.handle(f.job(task.id));
  const text = await csv(f, task.id);
  const records = parseCsv(text);
  expect(records).toHaveLength(names.length + 1);
  const values = records.slice(1).flat();
  for (const name of names.slice(0, 4)) {
    expect(values).toContain(`'${name}`);
    expect(values).not.toContain(name);
  }
  expect(values).toContain(names[4]);
  expect(values).toContain(names[5]);
  expect(text).toContain('"逗号,和""引号""\r\n换行"');
  expect(records.every((row) => row.length === records[0]!.length)).toBe(true);
});

it('[AC-B1-34e#3] masked tasks forward filters/app and never request plaintext or write unmasked audit', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const task = await f.task({ filters: { risk_state: 'frozen' } });
  await worker.handle(f.job(task.id));
  expect(f.page).toHaveBeenCalledWith(
    expect.objectContaining({ appId: f.appId, riskState: 'frozen', masked: true }),
  );
  const cells = parseCsv(await csv(f, task.id)).flat();
  expect(cells).toContain('138****5678');
  expect(await f.audits()).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ action: 'export_unmasked' })]),
  );
});

it('[AC-B1-34e#4] unmasked generation appends row_count to a new audit, preserving the creation reason without PII', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const task = await f.task({ masked: false });
  const reason = '演示核对导出';
  // Plaintext is synthesized at runtime, never stored as a readable fixture literal.
  const plain = ['138', '2468', '5678'].join('');
  f.rows.splice(0, f.rows.length, { ...userRow(1), phone: plain });
  await f.audit(f.admin.id, 'export_unmasked', `export_tasks:${task.public_id}`, {
    resource: 'users',
    reason,
  });
  const before = await f.audits();
  await worker.handle(f.job(task.id));
  expect(f.page).toHaveBeenCalledWith(expect.objectContaining({ masked: false, appId: f.appId }));
  expect(parseCsv(await csv(f, task.id)).flat()).toContain(plain);
  const after = await f.audits();
  expect(after).toEqual(expect.arrayContaining(before));
  const appended = after.filter((row) => !before.some((old) => old.id === row.id));
  expect(appended.filter((row) => row.action === 'export_unmasked')).toHaveLength(1);
  expect(appended).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'export_unmasked',
        admin_id: f.admin.id,
        app_id: f.appId,
        after: expect.objectContaining({ resource: 'users', reason, row_count: 1 }),
      }),
    ]),
  );
  expect(auditText(after)).not.toContain(plain);
  expect(f.logs.join('')).not.toContain(plain);
});

it('[AC-B1-34e#5] max_rows override allows equality and rejects overflow without publishing truncated data', async () => {
  const f = await fixture(h.db(), { maxRows: 3 });
  const worker = await f.worker();
  const exact = await f.task();
  await worker.handle(f.job(exact.id));
  expect(await f.read(exact.id)).toMatchObject({ status: 'done', row_count: 3 });
  f.rows.push(userRow(4));
  const overflow = await f.task();
  const transition = vi.spyOn(domain, 'transitionExportTask');
  try {
    await worker.handle(f.job(overflow.id));
    expect(await f.read(overflow.id)).toMatchObject({
      status: 'failed',
      object_key: null,
      expires_at: null,
      failure_reason: expect.stringMatching(/上限|超出|超过|limit|maximum/i),
    });
    expect(f.store.get(`${f.appId}/${overflow.public_id}.csv`)).toBeUndefined();
    expect(transition).toHaveBeenCalledWith('running', 'FAIL');
  } finally {
    transition.mockRestore();
  }
});

it('[AC-B1-34e#6] actual rows, not just a stale total estimate, enforce max_rows', async () => {
  const f = await fixture(h.db(), { maxRows: 2 });
  const worker = await f.worker();
  f.page.mockResolvedValue({ items: f.rows, total: 1 });
  const task = await f.task();
  await worker.handle(f.job(task.id));
  expect(await f.read(task.id)).toMatchObject({
    status: 'failed',
    failure_reason: expect.any(String),
  });
  expect(f.store.get(`${f.appId}/${task.public_id}.csv`)).toBeUndefined();
});

it('[AC-B1-34e#7] empty source produces a downloadable header-only CSV', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  f.rows.splice(0);
  const task = await f.task();
  await worker.handle(f.job(task.id));
  expect(await f.read(task.id)).toMatchObject({ status: 'done', row_count: 0, progress: 100 });
  expect(parseCsv(await csv(f, task.id))).toHaveLength(1);
});

it('[AC-B1-34e#8] multiple pages advance bounded progress and preserve every source row once', async () => {
  const f = await fixture(h.db(), { maxRows: 2000 });
  const worker = await f.worker();
  const task = await f.task();
  f.rows.splice(0, f.rows.length, ...Array.from({ length: 1201 }, (_, i) => userRow(i)));
  const progress: number[] = [];
  f.page.mockImplementation(async (query) => {
    const row = await f.read(task.id);
    expect(row.status).toBe('running');
    expect(row.progress).toEqual(expect.any(Number));
    progress.push(row.progress!);
    const size = query.pageSize;
    return {
      total: f.rows.length,
      items: f.rows.slice((query.page - 1) * size, query.page * size),
    };
  });
  await worker.handle(f.job(task.id));
  expect(f.page.mock.calls.length).toBeGreaterThan(1);
  expect(progress.every((p, i) => p >= 0 && p < 100 && (i === 0 || p >= progress[i - 1]!))).toBe(
    true,
  );
  expect(progress.some((p) => p > 0)).toBe(true);
  const records = parseCsv(await csv(f, task.id));
  expect(records).toHaveLength(1202);
  const cells = records.flat();
  for (const row of f.rows) expect(cells.filter((value) => value === row.user_id)).toHaveLength(1);
  expect(await f.read(task.id)).toMatchObject({ progress: 100, row_count: 1201 });
});

for (const cap of [1, 2]) {
  it(`[AC-B1-34e#9] creator advisory lock + CAS enforces configured capacity ${cap} across independent workers`, async () => {
    const f = await fixture(h.db(), { maxRunning: cap });
    const workers = [await f.worker(), await f.worker(), await f.worker()];
    const tasks = await Promise.all(workers.map(() => f.task()));
    const release = Promise.withResolvers<void>();
    const entered: number[] = [];
    f.page.mockImplementation(async () => {
      entered.push(await running(f.db, f.appId, f.admin.id));
      await release.promise;
      return { items: f.rows, total: f.rows.length };
    });
    const work = workers.map((worker, index) => worker.handle(f.job(tasks[index]!.id)));
    const outcomes = Promise.allSettled(work);
    try {
      await vi.waitFor(() => expect(f.page).toHaveBeenCalledTimes(cap));
      expect(await running(f.db, f.appId, f.admin.id)).toBe(cap);
      const states = await Promise.all(tasks.map((task) => f.read(task.id)));
      expect(states.filter((row) => row.status === 'pending')).toHaveLength(3 - cap);
      expect(entered.every((n) => n <= cap)).toBe(true);
      expect(f.queries.some((query) => query.includes('pg_advisory_xact_lock'))).toBe(true);
    } finally {
      release.resolve();
      await outcomes;
    }
    const results = await outcomes;
    const remaining = await Promise.all(tasks.map((task) => f.read(task.id)));
    for (const [index, row] of remaining.entries()) {
      if (row.status === 'pending') {
        expect(
          results[index]?.status === 'rejected' ||
            f.sent.some((job) => job.name === 'generate' && job.payload['taskId'] === row.id),
        ).toBe(true);
        await workers[index]!.handle(f.job(row.id));
      }
    }
    expect(
      (await Promise.all(tasks.map((task) => f.read(task.id)))).every(
        (row) => row.status === 'done',
      ),
    ).toBe(true);
  });
}

it('[AC-B1-34e#10] a running export of another creator does not use this creator capacity', async () => {
  const f = await fixture(h.db(), { maxRunning: 1 });
  const worker = await f.worker();
  const other = await seedAdmin(f.db, f.appId);
  await f.task({ created_by: other.id, status: 'running' });
  const task = await f.task();
  await worker.handle(f.job(task.id));
  expect(await f.read(task.id)).toMatchObject({ status: 'done' });
});

it('[AC-B1-34e#11] duplicate generate delivery claims once and never rewrites a terminal task', async () => {
  const f = await fixture(h.db(), { maxRunning: 2 });
  const workers = [await f.worker(), await f.worker()];
  const task = await f.task();
  await Promise.allSettled(workers.map((worker) => worker.handle(f.job(task.id))));
  expect(await f.read(task.id)).toMatchObject({ status: 'done', row_count: 3 });
  expect(f.put).toHaveBeenCalledTimes(1);
  const done = await f.read(task.id);
  await workers[0]!.handle(f.job(task.id));
  expect(await f.read(task.id)).toEqual(done);
  expect(f.put).toHaveBeenCalledTimes(1);
  for (const status of ['failed', 'expired', 'cancelled']) {
    const terminal = await f.task({ status });
    await workers[0]!.handle(f.job(terminal.id));
    expect(await f.read(terminal.id)).toEqual(terminal);
  }
});

it('[AC-B1-34e#12] done and delayed expiry are one transaction; standard queue options omit singletonKey', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const task = await f.task();
  f.send.mockImplementation(async (queue, name, payload, options) => {
    expect(queue).toBe('export');
    expect(name).toBe('expire');
    expect(payload).toEqual({ appId: f.appId, taskId: task.id });
    expect(options.trx).not.toBeNull();
    expect(options).not.toHaveProperty('singletonKey');
    const inside = await options
      .trx!.withSchema('app')
      .selectFrom('export_tasks')
      .selectAll()
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
    expect(inside.status).toBe('done');
    expect(inside.expires_at!.getTime() - inside.generated_at!.getTime()).toBe(DAY);
    expect(options.delaySeconds).toBe(
      Math.ceil((inside.expires_at!.getTime() - f.clock.now().getTime()) / 1000),
    );
    expect((await f.read(task.id)).status).toBe('running');
    return randomUUID();
  });
  await worker.handle(f.job(task.id));
  expect(f.send).toHaveBeenCalledTimes(1);
  expect((await f.read(task.id)).status).toBe('done');
});

it('[AC-B1-34e#13] enqueue failure cannot commit done or expose an un-expiring file', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const task = await f.task();
  f.send.mockRejectedValue(new Error('synthetic queue failure'));
  await Promise.allSettled([worker.handle(f.job(task.id))]);
  expect(f.send).toHaveBeenCalled();
  const row = await f.read(task.id);
  expect(row.status).not.toBe('done');
  expect(row.expires_at).toBeNull();
  expect(row.object_key).toBeNull();
});

it('[AC-B1-34e#14] expiry respects the exact injected deadline, CASes once and deletes the object idempotently', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const task = await f.task();
  await worker.handle(f.job(task.id));
  const done = await f.read(task.id);
  const transition = vi.spyOn(domain, 'transitionExportTask');
  try {
    f.clock.set(new Date(done.expires_at!.getTime() - 1));
    await worker.handle(f.job(task.id, 'expire'));
    expect(await f.read(task.id)).toEqual(done);
    expect(f.store.get(done.object_key!)).toBeDefined();
    f.clock.advanceMs(1);
    await Promise.all([
      worker.handle(f.job(task.id, 'expire')),
      worker.handle(f.job(task.id, 'expire')),
    ]);
    const expired = await f.read(task.id);
    expect(expired).toMatchObject({ status: 'expired', updated_at: f.clock.now() });
    expect(expired.row_version).toBe(done.row_version + 1);
    expect(transition).toHaveBeenCalledWith('done', 'EXPIRE');
    expect(f.store.get(done.object_key!)).toBeUndefined();
    await worker.handle(f.job(task.id, 'expire'));
    expect(await f.read(task.id)).toEqual(expired);
  } finally {
    transition.mockRestore();
  }
});

it('[AC-B1-34e#15] failed object deletion can be retried without leaving a retained export behind', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const task = await f.task();
  await worker.handle(f.job(task.id));
  const done = await f.read(task.id);
  f.clock.set(done.expires_at!);
  f.remove.mockRejectedValueOnce(new Error('synthetic delete failure'));
  await expect(worker.handle(f.job(task.id, 'expire'))).rejects.toThrow();
  await worker.handle(f.job(task.id, 'expire'));
  expect((await f.read(task.id)).status).toBe('expired');
  expect(f.store.get(done.object_key!)).toBeUndefined();
});

it('[AC-B1-34e#16] source/storage failure becomes failed with a safe reason and no expiry job', async () => {
  for (const failure of ['source', 'storage']) {
    const f = await fixture(h.db());
    const worker = await f.worker();
    const task = await f.task();
    const secret = ['138', '2468', '5678'].join('');
    if (failure === 'source') f.page.mockRejectedValue(new Error(`provider included ${secret}`));
    else f.put.mockRejectedValue(new Error(`provider included ${secret}`));
    await worker.handle(f.job(task.id));
    const row = await f.read(task.id);
    expect(row).toMatchObject({
      status: 'failed',
      failure_reason: expect.any(String),
      object_key: null,
      expires_at: null,
    });
    expect(row.failure_reason!.length).toBeGreaterThan(0);
    expect(row.failure_reason).not.toContain(secret);
    expect(f.logs.join('')).not.toContain(secret);
    expect(f.sent.filter((job) => job.name === 'expire')).toHaveLength(0);
  }
});

it('[AC-B1-34e#17] cancellation changes only creator pending/running tasks, with audit and idempotence', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const other = await seedAdmin(f.db, f.appId);
  const untouched = [
    await f.task({ created_by: other.id }),
    ...(await Promise.all(
      ['done', 'failed', 'expired', 'cancelled'].map((status) => f.task({ status })),
    )),
  ];
  const active = [await f.task(), await f.task({ status: 'running' })];
  const transition = vi.spyOn(domain, 'transitionExportTask');
  try {
    await worker.cancelByCreator({ appId: f.appId, adminId: f.admin.id });
    for (const task of active)
      expect(await f.read(task.id)).toMatchObject({
        status: 'cancelled',
        row_version: task.row_version + 1,
      });
    for (const task of untouched) expect(await f.read(task.id)).toEqual(task);
    expect(transition).toHaveBeenCalledWith('pending', 'CANCEL');
    expect(transition).toHaveBeenCalledWith('running', 'CANCEL');
    const audit = await f.audits();
    expect(audit.length).toBeGreaterThan(0);
    for (const task of active)
      expect(auditText(audit)).toMatch(new RegExp(`${task.id}|${task.public_id}`));
    await worker.cancelByCreator({ appId: f.appId, adminId: f.admin.id });
    expect(await f.audits()).toEqual(audit);
    for (const task of active) {
      await worker.handle(f.job(task.id));
      expect((await f.read(task.id)).status).toBe('cancelled');
    }
    expect(f.put).not.toHaveBeenCalled();
  } finally {
    transition.mockRestore();
  }
});

it('[AC-B1-34e#18] cancellation during object upload wins over completion and removes plaintext', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const task = await f.task({ masked: false });
  f.rows.splice(0, f.rows.length, { ...userRow(1), phone: ['138', '2468', '5678'].join('') });
  await f.audit(f.admin.id, 'export_unmasked', `export_tasks:${task.public_id}`, {
    resource: 'users',
    reason: '演示取消测试',
  });
  f.put.mockRestore();
  const original = f.store.put.bind(f.store);
  vi.spyOn(f.store, 'put').mockImplementation(async (input) => {
    await worker.cancelByCreator({ appId: f.appId, adminId: f.admin.id });
    await original(input);
  });
  await worker.handle(f.job(task.id));
  expect(await f.read(task.id)).toMatchObject({ status: 'cancelled', expires_at: null });
  expect(f.store.get(`${f.appId}/${task.public_id}.csv`)).toBeUndefined();
  expect(f.sent.filter((job) => job.name === 'expire')).toHaveLength(0);
  expect((await f.audits()).filter((row) => row.action === 'export_unmasked')).toHaveLength(1);
});

it('[AC-B1-34e#19] forged app_id cannot generate, expire or cancel a foreign task', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const task = await f.task();
  await worker.handle(f.job(task.id, 'generate', 'foreign_app'));
  await worker.cancelByCreator({ appId: 'foreign_app', adminId: f.admin.id });
  expect(await f.read(task.id)).toEqual(task);
  expect(f.page).not.toHaveBeenCalled();
  expect(f.put).not.toHaveBeenCalled();
  await worker.handle(f.job(task.id));
  const done = await f.read(task.id);
  f.clock.set(done.expires_at!);
  await worker.handle(f.job(task.id, 'expire', 'foreign_app'));
  expect(await f.read(task.id)).toEqual(done);
  expect(f.store.get(done.object_key!)).toBeDefined();
});

it('[AC-B1-34e#20] audit exports reuse the reader and force own records, including conflicting actor filters', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const other = await seedAdmin(f.db, f.appId);
  await f.audit(f.admin.id, 'admin.login', 'admin_users:SELF_MARKER', {
    detail: 'DETAIL_NOT_A_LIST_COLUMN',
  });
  await f.audit(other.id, 'admin.login', 'admin_users:OTHER_MARKER');
  const task = await f.task({ resource: 'audit_logs' });
  await worker.handle(f.job(task.id));
  expect(f.auditList).toHaveBeenCalledWith(
    expect.objectContaining({ appId: f.appId, adminId: f.admin.id, isSuper: false }),
    expect.any(Object),
  );
  expect(await csv(f, task.id)).toContain('SELF_MARKER');
  expect(await csv(f, task.id)).not.toContain('OTHER_MARKER');
  expect(await csv(f, task.id)).not.toContain('DETAIL_NOT_A_LIST_COLUMN');
  expect(parseCsv(await csv(f, task.id))[0]).toHaveLength(9);
  expect(f.page).not.toHaveBeenCalled();
  const empty = await f.task({ resource: 'audit_logs', filters: { actor_id: other.id } });
  await worker.handle(f.job(empty.id));
  expect(await f.read(empty.id)).toMatchObject({ status: 'done', row_count: 0 });
  expect(parseCsv(await csv(f, empty.id))).toHaveLength(1);
});

it('[AC-B1-34e#21] audit.view_all widens only the current app, retaining the source-list filters', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  const other = await seedAdmin(f.db, f.appId);
  await f.db
    .insertInto('admin_permissions')
    .values({
      app_id: f.appId,
      admin_id: f.admin.id,
      permission_key: 'audit.view_all',
      granted_by: f.admin.id,
      granted_at: START,
    })
    .execute();
  await f.audit(other.id, 'admin.login', 'admin_users:MATCH');
  await f.audit(other.id, 'admin.login', 'admin_users:EXCLUDED');
  const filters = {
    actor_id: other.id,
    target_type: 'admin_user',
    target_id: 'MATCH',
    from: START,
    to: '2026-10-23T00:00:00.000Z',
  };
  const task = await f.task({ resource: 'audit_logs', filters });
  await worker.handle(f.job(task.id));
  expect(f.auditList).toHaveBeenCalledWith(
    expect.objectContaining({ appId: f.appId }),
    expect.objectContaining({
      actorId: other.id,
      targetType: 'admin_user',
      targetId: 'MATCH',
      from: filters.from,
      to: filters.to,
    }),
  );
  expect(await f.read(task.id)).toMatchObject({ status: 'done', row_count: 1 });
  expect(await csv(f, task.id)).toContain('MATCH');
  expect(await csv(f, task.id)).not.toContain('EXCLUDED');
});

it('[AC-B1-34e#28] super audit export sees all creators but no foreign-app rows', async () => {
  const f = await fixture(h.db(), { isSuper: true });
  const worker = await f.worker();
  const other = await seedAdmin(f.db, f.appId);
  const foreign = await seedAdmin(f.db, 'foreign_audit_app');
  await f.audit(f.admin.id, 'admin.login', 'admin_users:SELF_MARKER');
  await f.audit(other.id, 'admin.login', 'admin_users:OTHER_MARKER');
  await f.db
    .insertInto('audit_logs')
    .values({
      app_id: foreign.app_id,
      admin_id: foreign.id,
      action: 'admin.login',
      target: 'admin_users:FOREIGN_MARKER',
      before: null,
      after: null,
      ip: null,
      at: START,
    })
    .execute();
  const task = await f.task({ resource: 'audit_logs' });
  await worker.handle(f.job(task.id));
  const text = await csv(f, task.id);
  expect(text).toContain('SELF_MARKER');
  expect(text).toContain('OTHER_MARKER');
  expect(text).not.toContain('FOREIGN_MARKER');
  expect(f.auditList).toHaveBeenCalledWith(
    expect.objectContaining({ isSuper: true }),
    expect.any(Object),
  );
});

it('[AC-B1-34e#29] expire delivery ignores non-done tasks, even with an old deadline', async () => {
  const f = await fixture(h.db());
  const worker = await f.worker();
  for (const status of ['pending', 'running', 'failed', 'cancelled']) {
    const task = await f.task({ status, expires_at: START });
    await worker.handle(f.job(task.id, 'expire'));
    expect(await f.read(task.id)).toEqual(task);
  }
  expect(f.remove).not.toHaveBeenCalled();
});
