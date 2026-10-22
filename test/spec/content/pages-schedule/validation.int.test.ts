import { expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { JOB_QUEUE, type QueueRuntime } from '../../../../apps/api/src/modules/platform/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY,
  cancel,
  conflict,
  detail,
  dueJob,
  fields,
  handler,
  jobs,
  prepared,
  publish,
  rejected,
  save,
  schedule,
  scheduled,
  sections,
  send,
  setup,
  snapshot,
  success,
  version,
  type Setup,
} from './kit.ts';

// 合成域名仅用于验证发布时的 section 检查与到点不重校，非平台录制。
vi.mock('../../../../apps/api/src/modules/platform/specs/link-patterns.ts', () => ({
  getLinkPatterns: () => ({
    version: 'synthetic',
    rules: [
      { platform: 'taobao', category: 'union_host', hosts: ['union-a.test'], path_patterns: [] },
    ],
  }),
}));

const h = useHarness();

async function block(f: Setup, value: boolean) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: f.appId,
      key: 'external_page.union_host_block',
      value: sql`${JSON.stringify(value)}::jsonb`,
      version: 1,
      row_version: 1,
      updated_by: f.actor.username,
      updated_at: f.clock.now(),
    })
    .onConflict((oc) =>
      oc.columns(['app_id', 'key']).doUpdateSet({ value: sql`${JSON.stringify(value)}::jsonb` }),
    )
    .execute();
}

it.each([0, -1, 30 * DAY + 1_000])(
  '[AC-F1-09p#14] publish_at 偏移 %s ms 拒绝且数据库、审计、队列不变',
  async (offset) => {
    const f = await prepared(h);
    const before = await snapshot(h, f.appId);
    const queued = await jobs(h, f.appId);
    await fields(await schedule(f, new Date(f.clock.now().getTime() + offset)), ['publish_at']);
    expect(await snapshot(h, f.appId)).toEqual(before);
    expect(await jobs(h, f.appId)).toEqual(queued);
  },
);

it('[AC-F1-09p#15] 30 天整可定时，延迟恰 2592000 秒；首次全量也可定时', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  const at = new Date(f.clock.now().getTime() + 30 * DAY);
  expect(await success(await schedule(f, at, 1, 100, 1))).toMatchObject({
    current_version: null,
    revision: 2,
    scheduled: { version: 1, publish_at: at.toISOString() },
  });
  expect((await jobs(h, f.appId))[0]?.delay).toBe(2_592_000);
  expect(await version(f)).toMatchObject({ status: 'draft', publish_at: null });
});

it('[AC-F1-09p#16] 无全量版不能灰度定时；相同草稿全量定时成功', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  const before = await snapshot(h, f.appId);
  const at = new Date(f.clock.now().getTime() + 10_000);
  await fields(await schedule(f, at, 1, 10, 1), ['gray_percent']);
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await jobs(h, f.appId)).toHaveLength(0);
  expect(await success(await schedule(f, at, 1, 100, 1))).toMatchObject({
    scheduled: { version: 1 },
    current_version: null,
  });
});

it('[AC-F1-09p#17] 有灰度不能定时；停止灰度后可定时，后续回滚全量保留槽位', async () => {
  const f = await prepared(h);
  await publish(f, 'home', 3, 2, 10);
  await save(f, 'home', 4);
  const at = new Date(f.clock.now().getTime() + 30_000);
  const before = await snapshot(h, f.appId);
  await fields(await schedule(f, at, 5, 100, 3), ['version']);
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await jobs(h, f.appId)).toHaveLength(0);
  await success(await send(f, 'gray', 'home', { expected_revision: 5, gray_percent: 100 }));
  const pending = await success(await schedule(f, at, 6, 100, 3));
  expect(pending.scheduled).toMatchObject({ version: 3 });
  expect(
    await success(await send(f, 'rollback', 'home', { expected_revision: 7, version: 2 })),
  ).toMatchObject({ current_version: 1, revision: 8, scheduled: pending.scheduled });
});

it('[AC-F1-09p#18] 已发布和不存在的版本先报 version，之后才检查时间范围', async () => {
  const f = await prepared(h);
  const before = await snapshot(h, f.appId);
  for (const number of [1, 999]) {
    await fields(await schedule(f, f.clock.now(), 3, 100, number), ['version']);
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await jobs(h, f.appId)).toHaveLength(0);
  expect(await success(await schedule(f, new Date(f.clock.now().getTime() + 1_000)))).toMatchObject(
    { revision: 4, scheduled: { version: 2 } },
  );
});

it('[AC-F1-09p#19] 定时提交时重校 sections，生效时不因配置变化再校验', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  await publish(f, 'home', 1, 1);
  await block(f, false);
  await save(
    f,
    'home',
    2,
    sections('external', { route: 'ExternalPage', params: { url: 'https://union-a.test/' } }),
  );
  const at = new Date(f.clock.now().getTime() + 10_000);
  await block(f, true);
  const before = await snapshot(h, f.appId);
  await fields(await schedule(f, at), ['sections.0.data_source.items.0.action.params.url']);
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await jobs(h, f.appId)).toHaveLength(0);
  await block(f, false);
  expect(await success(await schedule(f, at))).toMatchObject({ scheduled: { version: 2 } });
  await block(f, true);
  f.clock.set(at);
  expect(await detail(f)).toMatchObject({ current_version: 2, revision: 5 });
  const { job } = handler(h, f);
  await job.handle(dueJob(f));
  expect((await snapshot(h, f.appId)).versions.find((v) => v.version === 2)).toMatchObject({
    status: 'published',
    publish_at: at,
  });
});

it('[AC-F1-09p#20] 入队后故障回滚页面、审计与任务，恢复后同 revision 可再提交', async () => {
  const f = await scheduled(h);
  await success(await cancel(f, 4));
  const before = await snapshot(h, f.appId);
  const queued = await jobs(h, f.appId);
  const queue = f.app.get<QueueRuntime>(JOB_QUEUE);
  const original = queue.send.bind(queue);
  let reached = false;
  const spy = vi.spyOn(queue, 'send').mockImplementation(async (...args) => {
    await original(...args);
    reached = true;
    throw new Error('F1-09p synthetic failure after enqueue');
  });
  try {
    await rejected(await schedule(f, f.at, 5), 50001);
    expect(reached).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await jobs(h, f.appId)).toEqual(queued);
  expect(await success(await schedule(f, f.at, 5))).toMatchObject({
    revision: 6,
    scheduled: f.page.scheduled,
  });
});

it('[AC-F1-09p#21] 两次同 revision 的定时发布竞争恰一成功，一条审计和一条到期任务', async () => {
  const f = await prepared(h);
  const before = await snapshot(h, f.appId);
  const at = new Date(f.clock.now().getTime() + 10_000);
  const responses = await Promise.all([schedule(f, at), schedule(f, at)]);
  expect(responses.map((r) => r.response.statusCode).sort()).toEqual([200, 409]);
  const accepted = responses.find((r) => r.response.statusCode === 200)!;
  const refused = responses.find((r) => r.response.statusCode === 409)!;
  expect(await success(accepted)).toMatchObject({ revision: 4, scheduled: { version: 2 } });
  await conflict(refused);
  expect(await jobs(h, f.appId)).toHaveLength(1);
  expect((await snapshot(h, f.appId)).audits.length - before.audits.length).toBe(1);
});
