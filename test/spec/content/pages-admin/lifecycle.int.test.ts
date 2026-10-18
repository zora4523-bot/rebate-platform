import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  audit,
  conflict,
  detail,
  fields,
  publish,
  save,
  sections,
  send,
  setup,
  snapshot,
  success,
  version,
  type PageList,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-09f#2] 首存 0 创建版本 1 与 revision 1，内容、作者、注入时间及审计正确', async () => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  const result = await save(f, 'home', 0);
  expect(result).toMatchObject({
    page_key: 'home',
    version: 1,
    status: 'draft',
    sections: sections(),
    publisher: null,
    publish_at: null,
    created_by: f.actor.username,
    render_count: 0,
    error_count: 0,
  });
  expect(new Date(result.created_at).toISOString()).toBe(f.clock.now().toISOString());
  expect(await detail(f)).toMatchObject({
    current_version: null,
    gray_version: null,
    gray_percent: 0,
    latest_version: 1,
    revision: 1,
    updated_by: f.actor.username,
  });
  const list = await success<PageList>(await send(f, 'list'));
  expect(list.total).toBe(1);
  expect(list.items.map((p) => p.page_key)).toEqual(['home']);
  const state = await snapshot(h, f.appId);
  expect(state.pages[0]).toMatchObject({ created_at: f.clock.now(), updated_at: f.clock.now() });
  expect(state.versions[0]).toMatchObject({
    created_by_admin_id: f.actor.id,
    created_at: f.clock.now(),
  });
  await audit(h, f, before, 'save', 'home', 1);
});

it('[AC-F1-09f#3] 首存 expected 1 冲突并回滚锁行，随后 expected 0 仍是版本 1', async () => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await conflict(await send(f, 'save', 'home', { sections: sections(), expected_revision: 1 }));
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect((await success<PageList>(await send(f, 'list'))).items).toEqual([]);
  expect(await save(f, 'home', 0)).toMatchObject({ version: 1 });
});

it('[AC-F1-09f#4] 存稿→全量→灰度→改比例→转全量，逐写 revision 与审计递增、旧内容与统计不变', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  const first = await version(f);
  const b1 = await snapshot(h, f.appId);
  expect(await publish(f, 'home', 1, 1)).toMatchObject({
    current_version: 1,
    gray_version: null,
    gray_percent: 0,
    revision: 2,
  });
  await audit(h, f, b1, 'publish', 'home', 1);
  const v1 = await version(f);
  expect(v1).toMatchObject({
    status: 'published',
    publisher: f.actor.username,
    sections: first.sections,
  });
  expect(new Date(v1.publish_at!).toISOString()).toBe(f.clock.now().toISOString());
  await h.db
    .updateTable('page_versions')
    .set({ render_count: 17n, error_count: 3n })
    .where('app_id', '=', f.appId)
    .where('page_key', '=', 'home')
    .where('version', '=', 1)
    .execute();
  const b2 = await snapshot(h, f.appId);
  expect(await save(f, 'home', 2, sections('second'))).toMatchObject({
    version: 2,
    status: 'draft',
  });
  await audit(h, f, b2, 'save', 'home', 2);
  const b3 = await snapshot(h, f.appId);
  expect(await publish(f, 'home', 3, 2, 10)).toMatchObject({
    current_version: 1,
    gray_version: 2,
    gray_percent: 10,
    revision: 4,
  });
  await audit(h, f, b3, 'publish', 'home', 2);
  const gray = await version(f, 'home', 2);
  for (const [percent, revision] of [
    [50, 4],
    [100, 5],
  ] as const) {
    const before = await snapshot(h, f.appId);
    f.clock.advanceMs(1000);
    const result = await success(
      await send(f, 'gray', 'home', { gray_percent: percent, expected_revision: revision }),
    );
    expect(result).toMatchObject({
      current_version: percent === 100 ? 2 : 1,
      gray_version: percent === 100 ? null : 2,
      gray_percent: percent === 100 ? 0 : percent,
      revision: revision + 1,
      latest_version: 2,
    });
    await audit(h, f, before, 'gray', 'home', 2);
    expect((await snapshot(h, f.appId)).versions).toEqual(before.versions);
  }
  expect(await version(f, 'home', 2)).toEqual(gray);
  expect(await version(f)).toMatchObject({
    status: 'published',
    render_count: 17,
    error_count: 3,
    sections: first.sections,
    publish_at: v1.publish_at,
    publisher: v1.publisher,
    created_at: first.created_at,
  });
  const before = await snapshot(h, f.appId);
  await fields(await send(f, 'gray', 'home', { gray_percent: 50, expected_revision: 6 }), [
    'gray_percent',
  ]);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-09f#5] 首发只能全量；有灰度不能再发；非草稿和不存在版本均拒绝且不留写入', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  let before = await snapshot(h, f.appId);
  await fields(
    await send(f, 'publish', 'home', { version: 1, gray_percent: 10, expected_revision: 1 }),
    ['gray_percent'],
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  await publish(f, 'home', 1, 1);
  for (const number of [1, 99]) {
    before = await snapshot(h, f.appId);
    await fields(
      await send(f, 'publish', 'home', {
        version: number,
        gray_percent: 100,
        expected_revision: 2,
      }),
      ['version'],
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  }
  await save(f, 'home', 2);
  await publish(f, 'home', 3, 2, 10);
  await save(f, 'home', 4);
  for (const percent of [10, 100]) {
    before = await snapshot(h, f.appId);
    await fields(
      await send(f, 'publish', 'home', { version: 3, gray_percent: percent, expected_revision: 5 }),
      ['version'],
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  }
});

it('[AC-F1-09f#6] 按发布时间回滚：先发 v2 再发 v1，退回 v2，保留未发布 v3', async () => {
  const f = await setup(h);
  for (let revision = 0; revision < 3; revision += 1)
    await save(f, 'home', revision, sections(`saved_${revision}`));
  await publish(f, 'home', 3, 2);
  const v2 = await version(f, 'home', 2);
  await publish(f, 'home', 4, 1);
  const before = await snapshot(h, f.appId);
  const v1 = await version(f);
  // v2 虽仍 published，但已不是当前全量；v3 是未发布草稿，两者都不能回滚。
  for (const number of [2, 3]) {
    f.clock.advanceMs(1000);
    await fields(await send(f, 'rollback', 'home', { version: number, expected_revision: 5 }), [
      'version',
    ]);
    expect(await snapshot(h, f.appId)).toEqual(before);
  }
  f.clock.advanceMs(1000);
  expect(
    await success(await send(f, 'rollback', 'home', { version: 1, expected_revision: 5 })),
  ).toMatchObject({
    current_version: 2,
    gray_version: null,
    gray_percent: 0,
    latest_version: 3,
    revision: 6,
  });
  await audit(h, f, before, 'rollback', 'home', 1);
  expect(await version(f)).toEqual({ ...v1, status: 'rolled_back' });
  expect(await version(f, 'home', 2)).toEqual(v2);
  expect(await version(f, 'home', 3)).toMatchObject({ status: 'draft', publish_at: null });
  const final = await snapshot(h, f.appId);
  await fields(await send(f, 'rollback', 'home', { version: 2, expected_revision: 6 }), [
    'version',
  ]);
  await fields(
    await send(f, 'publish', 'home', { version: 1, gray_percent: 100, expected_revision: 6 }),
    ['version'],
  );
  expect(await snapshot(h, f.appId)).toEqual(final);
});

it('[AC-F1-09f#7] 唯一全量不能回滚、有灰度不能回滚全量；回滚灰度仅清灰度且不再作为后继候选', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  await publish(f, 'home', 1, 1);
  const only = await snapshot(h, f.appId);
  await fields(await send(f, 'rollback', 'home', { version: 1, expected_revision: 2 }), [
    'version',
  ]);
  expect(await snapshot(h, f.appId)).toEqual(only);
  await save(f, 'home', 2);
  await publish(f, 'home', 3, 2, 25);
  const before = await snapshot(h, f.appId);
  for (const number of [1, 99]) {
    await fields(await send(f, 'rollback', 'home', { version: number, expected_revision: 4 }), [
      'version',
    ]);
    expect(await snapshot(h, f.appId)).toEqual(before);
  }
  const gray = await version(f, 'home', 2);
  f.clock.advanceMs(1000);
  expect(
    await success(await send(f, 'rollback', 'home', { version: 2, expected_revision: 4 })),
  ).toMatchObject({ current_version: 1, gray_version: null, gray_percent: 0, revision: 5 });
  await audit(h, f, before, 'rollback', 'home', 2);
  expect(await version(f, 'home', 2)).toEqual({ ...gray, status: 'rolled_back' });
  await save(f, 'home', 5);
  await publish(f, 'home', 6, 3);
  f.clock.advanceMs(1000);
  expect(
    await success(await send(f, 'rollback', 'home', { version: 3, expected_revision: 7 })),
  ).toMatchObject({ current_version: 1, revision: 8 });
});

it('[AC-F1-09f#8] 多个全量候选取最新 publish_at，同时间以 version 较大者决胜，不选 draft', async () => {
  const f = await setup(h);
  for (let revision = 0; revision < 5; revision += 1) await save(f, 'home', revision);
  await publish(f, 'home', 5, 3);
  await publish(f, 'home', 6, 1);
  // 两次发布故意用同一注入时刻，固定 (publish_at, version) 的次序。
  await success(
    await send(f, 'publish', 'home', { version: 2, gray_percent: 100, expected_revision: 7 }),
  );
  await publish(f, 'home', 8, 4);
  f.clock.advanceMs(1000);
  expect(
    await success(await send(f, 'rollback', 'home', { version: 4, expected_revision: 9 })),
  ).toMatchObject({ current_version: 2, latest_version: 5, revision: 10 });
});

it('[AC-F1-09f#9] 调灰度转全量不重写发布时间，后续回滚仍按原 publish_at 排序', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  await save(f, 'home', 1);
  await publish(f, 'home', 2, 1);
  await publish(f, 'home', 3, 2, 10);
  const prior = await version(f, 'home', 2);
  f.clock.advanceMs(6000);
  await success(await send(f, 'gray', 'home', { gray_percent: 100, expected_revision: 4 }));
  expect(await version(f, 'home', 2)).toEqual(prior);
  f.clock.advanceMs(1000);
  expect(
    await success(await send(f, 'rollback', 'home', { version: 2, expected_revision: 5 })),
  ).toMatchObject({ current_version: 1, revision: 6 });
});
