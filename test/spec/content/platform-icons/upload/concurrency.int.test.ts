import type { DatabaseConnection, QueryResult } from 'kysely';
import { expect, it, vi } from 'vitest';
import { factory, useHarness } from '../../../admin/auth/kit.ts';
import { icon } from '../read/kit.ts';
import {
  REGISTERED,
  create,
  mark,
  pending,
  rejected,
  setup,
  snapshot,
  success,
  type Version,
} from './kit.ts';

const h = useHarness();

it.each([false, true])(
  '[AC-F1-06x#19] 同一 upload 并发保存仅一版本、一审计，所有请求返回同一结果（已有标识=%s）',
  async (existing) => {
    const f = await setup(h);
    if (existing) await icon(h, f.actor, 'jd', null, 9);
    const row = await pending(h, f);
    const before = await snapshot(h, f.appId);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => create(f, { upload_id: row.id, ...REGISTERED })),
    );
    const versions = await Promise.all(responses.map((r) => success<Version>(r, 'versions')));
    expect(versions).toEqual(Array.from({ length: 6 }, () => versions[0]));
    expect(versions[0]).toMatchObject({ version: 1, revision: 1 });
    const after = await snapshot(h, f.appId);
    expect(after.versions).toHaveLength(1);
    expect(after.audits.filter((a) => !before.audits.some((b) => b.id === a.id))).toMatchObject([
      { action: 'version_create' },
    ]);
    expect(after.uploads).toEqual(before.uploads);
    expect(await mark(h, f.appId)).toMatchObject({
      revision: existing ? 9 : 0,
      current_version: null,
    });
  },
);

it.each([false, true])(
  '[AC-F1-06x#20] 不同 upload 并发得到连续且唯一版本号（已有标识=%s），摘要相同仍是不同版本',
  async (existing) => {
    const f = await setup(h);
    if (existing) await icon(h, f.actor, 'jd', null, 4);
    const rows = await Promise.all(Array.from({ length: 6 }, () => pending(h, f)));
    const before = await snapshot(h, f.appId);
    const responses = await Promise.all(rows.map((row) => create(f, { upload_id: row.id })));
    const versions = await Promise.all(responses.map((r) => success<Version>(r, 'versions')));
    expect(versions.map((v) => v.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const after = await snapshot(h, f.appId);
    expect(after.versions).toHaveLength(6);
    expect(new Set(after.versions.map((v) => v.upload_id))).toEqual(new Set(rows.map((r) => r.id)));
    expect(after.audits.filter((a) => !before.audits.some((b) => b.id === a.id))).toHaveLength(6);
    expect(after.audits.filter((a) => a.action === 'version_create')).toHaveLength(6);
    expect(after.uploads).toEqual(before.uploads);
    expect(await mark(h, f.appId)).toMatchObject({
      revision: existing ? 4 : 0,
      current_version: null,
    });
  },
);

it('[AC-F1-06x#21] 受限角色下先插入并锁标识再写版本，不锁仅 SELECT/INSERT 授权的 upload', async () => {
  const f = await setup(h);
  const row = await pending(h, f);
  await h.db.connection().execute(async (db) => {
    const connection = await db.getExecutor().provideConnection(async (value) => value);
    const app = await (
      await factory()
    )('admin', {
      ...f.overrides,
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    const statements: string[] = [];
    const execute = connection.executeQuery.bind(connection);
    const spy = vi
      .spyOn(connection, 'executeQuery')
      .mockImplementation(
        async <R>(
          ...args: Parameters<DatabaseConnection['executeQuery']>
        ): Promise<QueryResult<R>> => {
          statements.push(args[0].sql);
          return execute<R>(...args);
        },
      );
    try {
      await app.init();
      const result = await success<Version>(
        await create({ ...f, app }, { upload_id: row.id }),
        'versions',
      );
      expect(result.version).toBe(1);
      const insertMark = statements.findIndex((s) => /insert into .*"platform_icons"/i.test(s));
      const lockMark = statements.findIndex((s) => /from .*"platform_icons".*for update/i.test(s));
      const insertVersion = statements.findIndex((s) =>
        /insert into .*"platform_icon_versions"/i.test(s),
      );
      const begin = statements.findIndex((s) => /^begin\b/i.test(s));
      const commit = statements.findIndex((s, i) => i > insertVersion && /^commit\b/i.test(s));
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(insertMark).toBeGreaterThan(begin);
      expect(statements[insertMark]).toMatch(/on conflict.*do nothing/i);
      expect(lockMark).toBeGreaterThan(insertMark);
      expect(insertVersion).toBeGreaterThan(lockMark);
      expect(commit).toBeGreaterThan(insertVersion);
      expect(
        statements.filter((s) => /platform_icon_uploads.*for (?:no key )?update/i.test(s)),
      ).toEqual([]);
    } finally {
      spy.mockRestore();
      await app.close();
    }
  });
});

it.each([false, true])(
  '[AC-F1-06x#22] 审计写入失败时版本与标识更新全部回滚，upload 保留供重试（已有标识=%s）',
  async (existing) => {
    const f = await setup(h);
    if (existing) await icon(h, f.actor, 'jd', null, 8);
    const row = await pending(h, f);
    const before = await snapshot(h, f.appId);
    let faultReached = false;
    const db = h.db.withPlugin({
      transformQuery(args) {
        if (
          args.node.kind === 'InsertQueryNode' &&
          JSON.stringify(args.node.into).includes('audit_logs')
        ) {
          faultReached = true;
          throw new Error('injected version_create audit failure');
        }
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const app = await (
      await factory()
    )('admin', {
      ...f.overrides,
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    h.apps.push(app);
    await app.init();
    await rejected(await create({ ...f, app }, { upload_id: row.id }), 'versions', 50001);
    expect(faultReached).toBe(true);
    expect(await snapshot(h, f.appId)).toEqual(before);
    const recovered = await success<Version>(await create(f, { upload_id: row.id }), 'versions');
    expect(recovered.version).toBe(1);
    expect(
      (await snapshot(h, f.appId)).audits.filter((a) => a.action === 'version_create'),
    ).toHaveLength(1);
  },
);
