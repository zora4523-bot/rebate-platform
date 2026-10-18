import type { DatabaseConnection, QueryResult } from 'kysely';
import { expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  audit,
  conflict,
  detail,
  publish,
  rejected,
  save,
  sections,
  send,
  setup,
  snapshot,
  success,
  version,
  WRITES,
  type Version,
} from './kit.ts';
import { onConnection, orderedRace, type Attempt } from './ordered-race.ts';

const h = useHarness();

it.each([false, true])(
  '[AC-F1-09f#19] 同 revision 并发存稿恰一成一败且版本连续（已有页面=%s）',
  async (existing) => {
    const f = await setup(h);
    if (existing) await save(f, 'home', 0, sections('original'));
    const revision = existing ? 1 : 0;
    const before = await snapshot(h, f.appId);
    f.clock.advanceMs(1000);
    const result = await orderedRace(
      h,
      f,
      'home',
      { op: 'save', body: { expected_revision: revision, sections: sections('first_loser') } },
      { op: 'save', body: { expected_revision: revision, sections: sections('second_winner') } },
      existing,
    );
    await conflict(result.first);
    expect(await success<Version>(result.second)).toMatchObject({
      version: revision + 1,
      sections: sections('second_winner'),
    });
    await audit(h, f, before, 'save', 'home', revision + 1);
    expect(await detail(f)).toMatchObject({ revision: revision + 1, latest_version: revision + 1 });
    const state = await snapshot(h, f.appId);
    expect(state.versions.map((v) => v.version)).toEqual(existing ? [1, 2] : [1]);
    if (existing) expect(state.versions[0]).toEqual(before.versions[0]);
    expect(await save(f, 'home', revision + 1)).toMatchObject({ version: revision + 2 });
  },
);

it('[AC-F1-09f#20] 保存和发布共享同一个页级 CAS，失败存稿不留下新版本', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1000);
  const result = await orderedRace(
    h,
    f,
    'home',
    { op: 'save', body: { expected_revision: 1, sections: sections('loser') } },
    { op: 'publish', body: { expected_revision: 1, version: 1, gray_percent: 100 } },
    true,
  );
  await conflict(result.first);
  expect(await success(result.second)).toMatchObject({
    revision: 2,
    current_version: 1,
    latest_version: 1,
  });
  await audit(h, f, before, 'publish', 'home', 1);
  expect((await snapshot(h, f.appId)).versions).toHaveLength(1);
});

it.each(['publish', 'gray', 'rollback'] as const)(
  '[AC-F1-09f#21] %s 与另一写并发也只能一方成功，状态错误不能掩盖 CAS',
  async (op) => {
    const f = await setup(h);
    await save(f, 'home', 0);
    await publish(f, 'home', 1, 1);
    await save(f, 'home', 2);
    if (op !== 'publish') await publish(f, 'home', 3, 2, 10);
    const revision = op === 'publish' ? 3 : 4;
    const first: Attempt =
      op === 'publish'
        ? { op, body: { expected_revision: revision, version: 2, gray_percent: 100 } }
        : op === 'gray'
          ? { op, body: { expected_revision: revision, gray_percent: 50 } }
          : { op, body: { expected_revision: revision, version: 2 } };
    const before = await snapshot(h, f.appId);
    f.clock.advanceMs(1000);
    const result = await orderedRace(
      h,
      f,
      'home',
      first,
      { op: 'save', body: { expected_revision: revision, sections: sections('winner') } },
      true,
    );
    await conflict(result.first);
    expect(await success<Version>(result.second)).toMatchObject({ version: 3 });
    await audit(h, f, before, 'save', 'home', 3);
    expect((await snapshot(h, f.appId)).versions.slice(0, 2)).toEqual(before.versions);
  },
);

it.each(WRITES)('[AC-F1-09f#22] %s 审计落库失败必须回滚整笔写入，首存不残留空页面', async (op) => {
  const f = await setup(h);
  if (op !== 'save') {
    await save(f, 'home', 0);
    if (op !== 'publish') {
      await publish(f, 'home', 1, 1);
      await save(f, 'home', 2);
      await publish(f, 'home', 3, 2, 10);
    }
  }
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1000);
  const body =
    op === 'save'
      ? { sections: sections(), expected_revision: 0 }
      : op === 'publish'
        ? { version: 1, gray_percent: 100, expected_revision: 1 }
        : op === 'gray'
          ? { gray_percent: 50, expected_revision: 4 }
          : { version: 2, expected_revision: 4 };
  await onConnection(h, f, async (app, connection) => {
    const execute = connection.executeQuery.bind(connection);
    let reached = false;
    const spy = vi
      .spyOn(connection, 'executeQuery')
      .mockImplementation(
        async <R>(
          ...args: Parameters<DatabaseConnection['executeQuery']>
        ): Promise<QueryResult<R>> => {
          if (/\binsert\s+into\s+(?:"?app"?\.)?"?audit_logs"?/i.test(args[0].sql)) {
            reached = true;
            throw new Error('F1-09f synthetic audit insert failure');
          }
          return execute<R>(...args);
        },
      );
    try {
      await rejected(await send({ ...f, app }, op, 'home', body), 50001);
      expect(reached, '须真实走到同事务审计写入').toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-09f#23] 页之间的 revision 与版本序号独立，存新草稿不改变旧版内容', async () => {
  const f = await setup(h);
  await save(f, 'home', 0, sections('old'));
  const old = await version(f);
  await save(f, 'custom:other', 0, sections('other'));
  await save(f, 'home', 1, sections('new'));
  expect(await version(f)).toEqual(old);
  expect(await detail(f, 'custom:other')).toMatchObject({ revision: 1, latest_version: 1 });
  expect(await detail(f)).toMatchObject({ revision: 2, latest_version: 2 });
});
