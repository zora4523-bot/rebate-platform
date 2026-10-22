import { expect, it, vi } from 'vitest';
import * as pageVersionStatus from '../../../../apps/api/src/modules/content/domain/pages/version-status.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  detail,
  dueJob,
  handler,
  jobs,
  prepared,
  schedule,
  scheduled,
  scheduleAudit,
  send,
  snapshot,
  success,
  version,
  viewer,
  type PageList,
  type VersionList,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-09p#1] 定时全量只写槽位与一条审计，同事务入队且草稿及当前指针不变', async () => {
  const f = await prepared(h);
  const before = await snapshot(h, f.appId);
  const at = new Date(f.clock.now().getTime() + 10_001);
  const result = await success(await schedule(f, at));
  const slot = { version: 2, gray_percent: 100, publish_at: at.toISOString() };
  expect(result).toMatchObject({
    current_version: 1,
    gray_version: null,
    gray_percent: 0,
    revision: 4,
    scheduled: { ...slot, scheduled_by: f.actor.username },
  });
  const after = await snapshot(h, f.appId);
  expect(after.versions).toEqual(before.versions);
  expect(after.pages[0]).toMatchObject({
    current_version: 1,
    revision: 4,
    scheduled_version: 2,
    scheduled_gray_percent: 100,
    scheduled_at: at,
    scheduled_by_admin_id: f.actor.id,
    updated_by_admin_id: f.actor.id,
    updated_at: f.clock.now(),
  });
  expect(await version(f, 'home', 2)).toMatchObject({
    status: 'draft',
    publish_at: null,
    publisher: null,
  });
  await scheduleAudit(h, f, before, 'page_publish_schedule', null, slot);
  const queued = await jobs(h, f.appId);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({
    name: 'page-schedule',
    delay: 11,
    data: { name: 'page-schedule.due', payload: { app_id: f.appId, page_key: 'home' } },
  });
});

it('[AC-F1-09p#2] 恰到点且不跑任务：缓存公共读与后台四读立即呈现有效版本，不写库', async () => {
  const f = await scheduled(h);
  const before = await snapshot(h, f.appId);
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(1);
  expect((await detail(f)).scheduled).toEqual(f.page.scheduled);
  expect((await success<PageList>(await send(f, 'list'))).items[0]?.scheduled).toEqual(
    f.page.scheduled,
  );
  f.clock.set(new Date(f.at.getTime() - 1));
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(1);
  f.clock.advanceMs(1);
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(2);
  const expected = {
    current_version: 2,
    gray_version: null,
    gray_percent: 0,
    revision: 5,
    scheduled: null,
    updated_at: f.at.toISOString(),
    updated_by: f.actor.username,
  };
  expect(await detail(f)).toMatchObject(expected);
  expect((await success<PageList>(await send(f, 'list'))).items[0]).toMatchObject(expected);
  const published = {
    version: 2,
    status: 'published',
    publish_at: f.at.toISOString(),
    publisher: f.actor.username,
  };
  expect(await version(f, 'home', 2)).toMatchObject(published);
  const versions = await success<VersionList>(await send(f, 'versions'));
  expect(versions.items.find((v) => v.version === 2)).toMatchObject(published);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-09p#3] 延迟物化用计划时刻和定时人；重复投递不增 revision、不加审计', async () => {
  const f = await scheduled(h);
  f.clock.set(new Date(f.at.getTime() + 45_000));
  const effective = await detail(f);
  const before = await snapshot(h, f.appId);
  const { job } = handler(h, f);
  const input = dueJob(f);
  await job.handle(input);
  const after = await snapshot(h, f.appId);
  expect(after.pages[0]).toMatchObject({
    current_version: 2,
    revision: 5,
    scheduled_version: null,
    scheduled_gray_percent: null,
    scheduled_at: null,
    scheduled_by_admin_id: null,
    updated_at: f.at,
    updated_by_admin_id: f.actor.id,
  });
  expect(after.versions.find((v) => v.version === 2)).toMatchObject({
    status: 'published',
    publish_at: f.at,
    publisher: f.actor.id,
  });
  expect(after.audits).toEqual(before.audits);
  expect(await detail(f)).toEqual(effective);
  await job.handle({ ...input, attempt: 2 });
  expect(await snapshot(h, f.appId)).toEqual(after);
});

it('[AC-F1-09p#4] 提前收到任务按剩余时间向上取整再入队，页行与审计保持原样', async () => {
  const f = await scheduled(h);
  const before = await snapshot(h, f.appId);
  f.clock.set(new Date(f.at.getTime() - 1_001));
  const { job, send: enqueue } = handler(h, f);
  await job.handle(dueJob(f));
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(
    'page-schedule',
    'page-schedule.due',
    { app_id: f.appId, page_key: 'home' },
    { trx: expect.objectContaining({ isTransaction: true }), delaySeconds: 2 },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await jobs(h, f.appId)).toHaveLength(2);
  enqueue.mockClear();
  f.clock.set(new Date(f.at.getTime() - 1));
  await job.handle(dueJob(f));
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(
    'page-schedule',
    'page-schedule.due',
    { app_id: f.appId, page_key: 'home' },
    { trx: expect.objectContaining({ isTransaction: true }), delaySeconds: 1 },
  );
});

it('[AC-F1-09p#5] 同名页面按 app_id 隔离，重复并发消费只物化一次', async () => {
  const a = await scheduled(h);
  const b = await scheduled(h);
  const untouched = await snapshot(h, b.appId);
  a.clock.set(a.at);
  const { job } = handler(h, a);
  const input = dueJob(a);
  await Promise.all([job.handle(input), job.handle({ ...input, attempt: 2 })]);
  expect((await snapshot(h, a.appId)).pages[0]).toMatchObject({ current_version: 2, revision: 5 });
  expect(await snapshot(h, b.appId)).toEqual(untouched);
});

it('[AC-F1-09p#30] 物化使用 pageVersionChange 的 PUBLISH 迁移，不自行绕过状态机', async () => {
  const f = await scheduled(h);
  f.clock.set(f.at);
  const change = vi.spyOn(pageVersionStatus, 'pageVersionChange');
  try {
    await handler(h, f).job.handle(dueJob(f));
    expect(change).toHaveBeenCalledWith('draft', 'PUBLISH');
    expect((await snapshot(h, f.appId)).versions.find((v) => v.version === 2)?.status).toBe(
      'published',
    );
  } finally {
    change.mockRestore();
  }
});

it('[AC-F1-09p#31] 槽位状态 CAS 失败视为程序错误，不切指针、不清槽位、不写审计', async () => {
  const f = await scheduled(h);
  // 合成不一致行，触发 WHERE status = draft 更新不到的错误路径。
  await h.db
    .updateTable('page_versions')
    .set({
      status: 'published',
      publish_at: f.clock.now(),
      publisher: f.actor.id,
    })
    .where('app_id', '=', f.appId)
    .where('page_key', '=', 'home')
    .where('version', '=', 2)
    .execute();
  const before = await snapshot(h, f.appId);
  f.clock.set(f.at);
  await expect(handler(h, f).job.handle(dueJob(f))).rejects.toThrow();
  expect(await snapshot(h, f.appId)).toEqual(before);
});
