import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { publishedPlatformIcons } from '../../../../../apps/api/src/modules/content/index.ts';
import { createKyselyPlatformIconStore } from '../../../../../apps/api/src/modules/content/infra/kysely-platform-icon-store.ts';
import { seed } from '../../../admin/accounts/kit.ts';
import { useHarness } from '../../../admin/auth/kit.ts';
import {
  BASE,
  icon,
  readSetup,
  REGISTERED,
  setup,
  snapshot,
  success,
  version,
  write,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-06y#20] 下发只含已发布键、清洗 URL/hash/版本，隔离 app，空应用返回空对象且不写库', async () => {
  const f = await readSetup(h);
  const own = await version(h, f.actor, 'jd', 1, {
    ...REGISTERED,
    ever_published: true,
    format: 'png',
  });
  await icon(h, f.actor, 'jd', 1, 4);
  await version(h, f.actor, 'jd', 2, REGISTERED); // Newer saved draft never leaks.
  await version(h, f.actor, 'taobao', 1, REGISTERED);
  await icon(h, f.actor, 'taobao', null, 0);
  await version(h, f.actor, 'wechat', 1, { ...REGISTERED, ever_published: true });
  await icon(h, f.actor, 'wechat', null, 5);
  const other = await seed(h, `f1-06y-read-${randomUUID()}`, { isSuper: true });
  const foreign = await version(h, other, 'jd', 1, { ...REGISTERED, ever_published: true });
  await icon(h, other, 'jd', 1, 2);
  const before = await snapshot(h, f.appId);
  const reader = publishedPlatformIcons.bind(undefined, { db: h.db, mediaPublicBaseUrl: BASE });
  expect(await reader(f.appId)).toEqual({
    jd: {
      url: `https://icons.example.invalid/media/${own.sha256}.png`,
      sha256: own.sha256,
      version: 1,
    },
  });
  expect(await reader(other.appId)).toEqual({
    jd: {
      url: `https://icons.example.invalid/media/${foreign.sha256}.svg`,
      sha256: foreign.sha256,
      version: 1,
    },
  });
  expect(await reader(`empty-${randomUUID()}`)).toEqual({});
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-06y#21] 同一读口两次调用之间直接改库，立即读取新版本和恢复内置结果，不用进程缓存', async () => {
  const f = await readSetup(h);
  const first = await version(h, f.actor, 'jd', 1, { ...REGISTERED, ever_published: true });
  const second = await version(h, f.actor, 'jd', 2, { ...REGISTERED, ever_published: true });
  await icon(h, f.actor, 'jd', 1, 4);
  const reader = publishedPlatformIcons.bind(undefined, { db: h.db, mediaPublicBaseUrl: BASE });
  expect(await reader(f.appId)).toEqual({
    jd: { url: first.url, sha256: first.sha256, version: 1 },
  });
  await h.db
    .updateTable('platform_icons')
    .set({ current_version: 2, revision: 5 })
    .where('app_id', '=', f.appId)
    .where('key', '=', 'jd')
    .execute();
  expect(await reader(f.appId)).toEqual({
    jd: { url: second.url, sha256: second.sha256, version: 2 },
  });
  await h.db
    .updateTable('platform_icons')
    .set({ current_version: null, revision: 6 })
    .where('app_id', '=', f.appId)
    .where('key', '=', 'jd')
    .execute();
  expect(await reader(f.appId)).toEqual({});
});

it('[AC-F1-06y#22] HTTP 发布、回滚、恢复成功后的下一次公开读取即变化', async () => {
  const f = await setup(h);
  const first = await version(h, f.actor, 'jd', 1, REGISTERED);
  const second = await version(h, f.actor, 'jd', 2, REGISTERED);
  const reader = publishedPlatformIcons.bind(undefined, { db: h.db, mediaPublicBaseUrl: BASE });
  expect(await reader(f.appId)).toEqual({});
  await success(await write(f, 'publish', { version: 2, expected_revision: 0 }), 'publish');
  expect(await reader(f.appId)).toEqual({
    jd: { url: second.url, sha256: second.sha256, version: 2 },
  });
  await success(await write(f, 'publish', { version: 1, expected_revision: 1 }), 'publish');
  expect(await reader(f.appId)).toEqual({
    jd: { url: first.url, sha256: first.sha256, version: 1 },
  });
  await success(await write(f, 'restore', { expected_revision: 2 }), 'restore');
  expect(await reader(f.appId)).toEqual({});
});

it('[AC-F1-06y#23] icons 读取中间发生发布，current_version 与 current 始终来自同一快照', async () => {
  const f = await readSetup(h);
  await version(h, f.actor, 'jd', 1, { ...REGISTERED, ever_published: true });
  await version(h, f.actor, 'jd', 2, { ...REGISTERED, ever_published: true });
  await icon(h, f.actor, 'jd', 1, 4);
  // Deterministically commit a concurrent publish after the first marks SELECT returns its
  // rows, before a possible second SELECT. A JOIN or repeatable-read snapshot is consistent.
  const markQueries = new Set<unknown>();
  let switched = false;
  const db = h.db.withPlugin({
    transformQuery(args) {
      if (
        args.node.kind === 'SelectQueryNode' &&
        JSON.stringify(args.node).includes('platform_icons')
      )
        markQueries.add(args.queryId);
      return args.node;
    },
    async transformResult(args) {
      if (!switched && markQueries.has(args.queryId)) {
        switched = true;
        await h.db
          .updateTable('platform_icons')
          .set({ current_version: 2, revision: 5 })
          .where('app_id', '=', f.appId)
          .where('key', '=', 'jd')
          .execute();
      }
      return args.result;
    },
  });
  const rows = await createKyselyPlatformIconStore(db).icons(f.appId);
  expect(switched).toBe(true);
  expect(rows).toHaveLength(1);
  const mark = rows[0]!;
  expect(mark.current).not.toBeNull();
  expect(mark.currentVersion).toBe(mark.current?.version);
  expect([
    [1, 4],
    [2, 5],
  ]).toContainEqual([mark.currentVersion, mark.revision]);
});
