// B2-08e · audit of a quarterly tax export (规划/08 BR-WDR-21「每次导出记审计（导出人、行数、用途）」;
// contract adminCreateExport, Audit; task §9.10). Records are read back from the real audit_logs table
// as the real entries wrote them.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { OLD, OTHER, user } from '../../identity/admin-realname/kit.ts';
import { ok, type View } from '../exports/kit.ts';
import { FULL, FULL_POINT, harness, MASKED, paid, person, PURPOSE, started } from './kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B2-08e#27] 脱敏版：export_create 记任务、季度；生成时 export_generated 记任务、resource、行数、导出人，无用途', async () => {
  const f = await started(h);
  const member = await person(h, f.appId, OLD);
  await paid(h, member);
  await paid(h, await person(h, f.appId, OTHER));
  const view = await ok<View>(await f.create(MASKED));
  const createdAt = f.clock.now();
  f.clock.advanceMs(60_000);
  const row = await f.generate(view.id);
  expect(row).toMatchObject({ status: 'done', row_count: 2 });
  const audits = await f.audits();
  expect(audits.map((audit) => audit.action)).toEqual(['export_create', 'export_generated']);
  expect(audits[0]).toMatchObject({
    admin_id: f.actor.id,
    at: createdAt,
    after: expect.objectContaining({
      task_id: view.id,
      resource: 'tax_withdrawals',
      filters: { quarter: '2026-Q4' },
      masked: true,
    }),
  });
  expect(audits[1]).toMatchObject({
    admin_id: f.actor.id,
    at: row.generated_at,
    after: expect.objectContaining({
      task_id: view.id,
      resource: 'tax_withdrawals',
      row_count: 2,
    }),
  });
  expect(audits[1]!.after).not.toHaveProperty('reason');
  // A repeated delivery changes nothing: one generation, one record.
  await f.generate(view.id);
  expect(await f.audits()).toEqual(audits);
});

it('[AC-B2-08e#28] 全量版：创建时 export_unmasked 记用途，生成后记行数与用途，不写 export_generated', async () => {
  const f = await started(h, [FULL_POINT]);
  await paid(h, await person(h, f.appId, OLD));
  const view = await ok<View>(await f.create(FULL, await f.token()));
  const created = await f.audits();
  expect(created.map((audit) => audit.action)).toEqual(['export_create', 'export_unmasked']);
  expect(created[1]).toMatchObject({
    admin_id: f.actor.id,
    after: expect.objectContaining({
      task_id: view.id,
      resource: 'tax_withdrawals',
      reason: PURPOSE,
    }),
  });
  expect(await f.generate(view.id)).toMatchObject({ status: 'done', row_count: 1 });
  const audits = await f.audits();
  expect(audits.map((audit) => audit.action)).not.toContain('export_generated');
  expect(audits.filter((audit) => audit.action === 'export_unmasked').at(-1)).toMatchObject({
    admin_id: f.actor.id,
    after: expect.objectContaining({
      task_id: view.id,
      resource: 'tax_withdrawals',
      reason: PURPOSE,
      row_count: 1,
    }),
  });
});

it('[AC-B2-08e#29] 全量版失败不记行数：export_unmasked 只有创建那一条', async () => {
  const f = await started(h, [FULL_POINT]);
  await paid(h, await user(h, f.appId));
  const view = await ok<View>(await f.create(FULL, await f.token()));
  expect((await f.generate(view.id)).status).toBe('failed');
  const audits = await f.audits();
  expect(audits.map((audit) => audit.action)).toEqual(['export_create', 'export_unmasked']);
  expect(audits[1]!.after).not.toHaveProperty('row_count');
});
