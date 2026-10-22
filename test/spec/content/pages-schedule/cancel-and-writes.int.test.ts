import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  cancel,
  conflict,
  detail,
  dueJob,
  fields,
  handler,
  jobs,
  member,
  rejected,
  save,
  schedule,
  scheduled,
  scheduleAudit,
  sections,
  send,
  snapshot,
  success,
  version,
  viewer,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-09p#6] 到点前撤销清四列并审计；旧任务重放及过原时刻均不得发布', async () => {
  const f = await scheduled(h);
  const before = await snapshot(h, f.appId);
  const queued = await jobs(h, f.appId);
  f.clock.advanceMs(1);
  expect(await success(await cancel(f, 4))).toMatchObject({
    revision: 5,
    current_version: 1,
    scheduled: null,
  });
  const slot = { version: 2, gray_percent: 100, publish_at: f.at.toISOString() };
  await scheduleAudit(h, f, before, 'page_schedule_cancel', slot, null);
  const after = await snapshot(h, f.appId);
  expect(after.pages[0]).toMatchObject({
    scheduled_version: null,
    scheduled_gray_percent: null,
    scheduled_at: null,
    scheduled_by_admin_id: null,
    updated_by_admin_id: f.actor.id,
    updated_at: f.clock.now(),
  });
  expect(after.versions).toEqual(before.versions);
  expect(await jobs(h, f.appId)).toEqual(queued);
  f.clock.set(new Date(f.at.getTime() + 60_001));
  const { job, send: enqueue } = handler(h, f);
  await job.handle(dueJob(f));
  expect(enqueue).not.toHaveBeenCalled();
  expect(await snapshot(h, f.appId)).toEqual(after);
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(1);
  await rejected(await cancel(f, 5), 30701);
  // 已无槽位时也先 CAS，不能把旧 revision 误报成无槽位。
  await conflict(await cancel(f, 4));
  await rejected(await cancel(f, 999, 'custom:missing'), 30701);
});

it('[AC-F1-09p#7] 到点后旧 revision 撤销报 CAS 且惰性物化一起回滚；有效视图仍为新版', async () => {
  const f = await scheduled(h);
  const before = await snapshot(h, f.appId);
  f.clock.set(f.at);
  await conflict(await cancel(f, 4));
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await detail(f)).toMatchObject({ revision: 5, current_version: 2, scheduled: null });
  expect(await version(f, 'home', 2)).toMatchObject({
    status: 'published',
    publisher: f.actor.username,
  });
  await rejected(await cancel(f, 5), 30701);
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(2);
});

it('[AC-F1-09p#8] 到点后回滚先物化定时版，再回到原全量版，定时人与回滚人分开', async () => {
  const f = await scheduled(h);
  const other = await member(h, f, ['content.page']);
  const before = await snapshot(h, f.appId);
  f.clock.set(new Date(f.at.getTime() + 1_000));
  const effective = await detail(f);
  expect(effective.revision).toBe(5);
  expect(
    await success(
      await send(
        f,
        'rollback',
        'home',
        {
          version: 2,
          expected_revision: effective.revision,
        },
        { token: other.token },
      ),
    ),
  ).toMatchObject({ current_version: 1, revision: 6, scheduled: null });
  expect(await version(f, 'home', 2)).toMatchObject({
    status: 'rolled_back',
    publish_at: f.at.toISOString(),
    publisher: f.actor.username,
  });
  const after = await snapshot(h, f.appId);
  expect(after.pages[0]).toMatchObject({
    updated_by_admin_id: other.account.id,
    updated_at: f.clock.now(),
  });
  const added = after.audits.filter((a) => !before.audits.some((b) => b.id === a.id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    action: 'page_rollback',
    admin_id: other.account.id,
    before: { current_version: 2, revision: 5, scheduled: null },
    after: { current_version: 1, revision: 6, scheduled: null },
  });
});

it('[AC-F1-09p#9] 已有槽位时立即或定时发布均拒绝；CAS 优先且无库或队列副作用', async () => {
  const f = await scheduled(h);
  const before = await snapshot(h, f.appId);
  const queued = await jobs(h, f.appId);
  for (const at of [undefined, new Date(f.at.getTime() + 1_000)]) {
    const body = {
      version: 999,
      gray_percent: 100,
      ...(at === undefined ? {} : { publish_at: at.toISOString() }),
    };
    await conflict(await send(f, 'publish', 'home', { ...body, expected_revision: 3 }));
    await fields(await send(f, 'publish', 'home', { ...body, expected_revision: 4 }), [
      'publish_at',
    ]);
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await jobs(h, f.appId)).toEqual(queued);
});

it('[AC-F1-09p#10] 存稿保留未到点槽位，到点存稿按有效 revision 物化后再加一次', async () => {
  const f = await scheduled(h);
  await save(f, 'home', 4, sections('third'));
  expect(await detail(f)).toMatchObject({ revision: 5, scheduled: f.page.scheduled });
  f.clock.set(f.at);
  const before = await snapshot(h, f.appId);
  await conflict(
    await send(f, 'save', 'home', { sections: sections('fourth'), expected_revision: 5 }),
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  await success(
    await send(f, 'save', 'home', { sections: sections('fourth'), expected_revision: 6 }),
  );
  const after = await snapshot(h, f.appId);
  expect(after.pages[0]).toMatchObject({
    current_version: 2,
    revision: 7,
    scheduled_version: null,
  });
  expect(after.versions.find((v) => v.version === 2)).toMatchObject({
    status: 'published',
    publish_at: f.at,
  });
  expect(after.audits.length - before.audits.length).toBe(1);
});

it('[AC-F1-09p#11] 到点灰度先物化，调至全量不改原发布时刻及定时人', async () => {
  const f = await scheduled(h, 10);
  const other = await member(h, f, ['content.page']);
  f.clock.set(new Date(f.at.getTime() + 2_000));
  const before = await snapshot(h, f.appId);
  await conflict(await send(f, 'gray', 'home', { expected_revision: 4, gray_percent: 100 }));
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(
    await success(
      await send(
        f,
        'gray',
        'home',
        { expected_revision: 5, gray_percent: 100 },
        { token: other.token },
      ),
    ),
  ).toMatchObject({ current_version: 2, gray_version: null, revision: 6, scheduled: null });
  expect(await version(f, 'home', 2)).toMatchObject({
    status: 'published',
    publish_at: f.at.toISOString(),
    publisher: f.actor.username,
  });
  expect((await snapshot(h, f.appId)).audits.length - before.audits.length).toBe(1);
});

it('[AC-F1-09p#12] publish 与撤销均要求 content.page，已有权限无需 step-up', async () => {
  const f = await scheduled(h);
  const denied = await member(h, f, []);
  const before = await snapshot(h, f.appId);
  await rejected(await cancel(f, 4, 'home', denied.token), 10403);
  await rejected(
    await send(
      f,
      'publish',
      'home',
      {
        version: 2,
        gray_percent: 100,
        expected_revision: 4,
        publish_at: f.at.toISOString(),
      },
      { token: denied.token },
    ),
    10403,
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  // scheduled() 与此撤销只带普通登录 token，没有 step-up 凭据。
  expect(await success(await cancel(f, 4))).toMatchObject({ revision: 5, scheduled: null });
  expect(await success(await schedule(f, f.at, 5))).toMatchObject({
    revision: 6,
    scheduled: f.page.scheduled,
  });
});

it('[AC-F1-09p#13] 撤销后再定时，旧任务只能按最新槽位判定，不得提前发布', async () => {
  const f = await scheduled(h);
  const old = dueJob(f);
  await success(await cancel(f, 4));
  const later = new Date(f.at.getTime() + 60_000);
  await success(await schedule(f, later, 5));
  f.clock.set(f.at);
  const before = await snapshot(h, f.appId);
  const { job, send: enqueue } = handler(h, f);
  await job.handle(old);
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(
    'page-schedule',
    'content.page_schedule_due',
    { app_id: f.appId, page_key: 'home' },
    { trx: expect.objectContaining({ isTransaction: true }), delaySeconds: 60 },
  );
  f.clock.set(later);
  await job.handle(old);
  expect((await snapshot(h, f.appId)).pages[0]).toMatchObject({
    revision: 7,
    current_version: 2,
    scheduled_version: null,
  });
});

it('[AC-F1-09p#32] 到点后立即发布其他草稿先物化原定时版，两个发布戳各自正确', async () => {
  const f = await scheduled(h);
  await save(f, 'home', 4, sections('third'));
  const other = await member(h, f, ['content.page']);
  f.clock.set(new Date(f.at.getTime() + 500));
  const before = await snapshot(h, f.appId);
  await conflict(
    await send(
      f,
      'publish',
      'home',
      {
        expected_revision: 5,
        version: 3,
        gray_percent: 100,
      },
      { token: other.token },
    ),
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(
    await success(
      await send(
        f,
        'publish',
        'home',
        {
          expected_revision: 6,
          version: 3,
          gray_percent: 100,
        },
        { token: other.token },
      ),
    ),
  ).toMatchObject({ current_version: 3, revision: 7, scheduled: null });
  expect(await version(f, 'home', 2)).toMatchObject({
    status: 'published',
    publisher: f.actor.username,
    publish_at: f.at.toISOString(),
  });
  expect(await version(f, 'home', 3)).toMatchObject({
    status: 'published',
    publisher: other.account.username,
    publish_at: f.clock.now().toISOString(),
  });
  expect((await snapshot(h, f.appId)).audits.length - before.audits.length).toBe(1);
});
