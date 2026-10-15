import { expect, it } from 'vitest';
import { useHarness } from '../../../admin/auth/kit.ts';
import {
  conflict,
  DATE,
  history,
  icon,
  mark,
  REGISTERED,
  rejected,
  saved,
  setup,
  snapshot,
  SOURCE,
  success,
  transitionAudit,
  version,
  write,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-06y#6] 无标识行首次发布，返回清洗文件、独立 revision、作者和注入时间并写 publish 审计', async () => {
  const f = await setup(h);
  const original = await version(h, f.actor, 'jd', 1, { ...REGISTERED, revision: 7 });
  await version(h, f.actor, 'jd', 3);
  const before = await snapshot(h, f.appId);
  const result = await success(
    await write(f, 'publish', { version: 1, expected_revision: 0 }),
    'publish',
  );
  expect(result).toMatchObject({
    key: 'jd',
    current_version: 1,
    latest_version: 3,
    revision: 1,
    current: { ...original, ever_published: true },
    updated_by: f.actor.username,
  });
  expect(new Date(result.updated_at!).toISOString()).toBe(f.clock.now().toISOString());
  expect(await mark(h, f.appId)).toMatchObject({
    current_version: 1,
    revision: 1,
    updated_by_admin_id: f.actor.id,
    updated_at: f.clock.now(),
  });
  expect(await saved(h, f.appId)).toMatchObject({ ever_published: true, revision: 7 });
  expect(await saved(h, f.appId, 'jd', 3)).toMatchObject({ ever_published: false });
  await transitionAudit(h, f, before, 'publish', null, 1);
});

it('[AC-F1-06y#7] 发布→回滚→恢复内置→重发旧版的 revision 只增，保留历史且空 current 一律 publish', async () => {
  const f = await setup(h);
  await version(h, f.actor, 'jd', 1, REGISTERED);
  await version(h, f.actor, 'jd', 2, REGISTERED);
  for (const step of [
    { op: 'publish', to: 2, from: null, revision: 0, action: 'publish' },
    { op: 'publish', to: 1, from: 2, revision: 1, action: 'rollback' },
    { op: 'restore', to: null, from: 1, revision: 2, action: 'restore_builtin' },
    { op: 'publish', to: 1, from: null, revision: 3, action: 'publish' },
    { op: 'publish', to: 2, from: 1, revision: 4, action: 'publish' },
  ] as const) {
    const before = await snapshot(h, f.appId);
    f.clock.advanceMs(1000);
    const body =
      step.op === 'restore'
        ? { expected_revision: step.revision }
        : { expected_revision: step.revision, version: step.to };
    const result = await success(await write(f, step.op, body), step.op);
    expect(result).toMatchObject({
      current_version: step.to,
      revision: step.revision + 1,
      latest_version: 2,
    });
    expect(result.current === null ? null : result.current.version).toBe(step.to);
    expect(await mark(h, f.appId)).toMatchObject({
      current_version: step.to,
      revision: step.revision + 1,
      updated_at: f.clock.now(),
    });
    await transitionAudit(h, f, before, step.action, step.from, step.to);
    if (step.op === 'restore') {
      expect((await snapshot(h, f.appId)).versions).toEqual(before.versions);
      expect((await snapshot(h, f.appId)).uploads).toEqual(before.uploads);
    }
  }
  expect((await history(f, 'jd')).items.map((v) => [v.version, v.ever_published])).toEqual([
    [2, true],
    [1, true],
  ]);
});

it.each([
  { registration: {}, fields: ['source_url', 'downloaded_on'] },
  { registration: { source_url: SOURCE }, fields: ['downloaded_on'] },
  { registration: { downloaded_on: DATE }, fields: ['source_url'] },
])(
  '[AC-F1-06y#8] 缺登记拒绝发布并列全 fields=$fields，不留半成品',
  async ({ registration, fields }) => {
    const f = await setup(h);
    await version(h, f.actor, 'jd', 1, registration);
    const before = await snapshot(h, f.appId);
    await rejected(
      await write(f, 'publish', { version: 1, expected_revision: 0 }),
      'publish',
      20001,
      { fields },
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-06y#9] 未知发布版本返回 20001 [version]，不建标识行也不写审计', async () => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await rejected(
    await write(f, 'publish', { version: 99, expected_revision: 0 }),
    'publish',
    20001,
    { fields: ['version'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-06y#10] 发布当前版且 revision 匹配是完整空操作，已生效请求的旧 revision 仍冲突', async () => {
  const f = await setup(h);
  await version(h, f.actor, 'jd', 1, REGISTERED);
  const first = await success(
    await write(f, 'publish', { version: 1, expected_revision: 0 }),
    'publish',
  );
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(2000);
  expect(
    await success(await write(f, 'publish', { version: 1, expected_revision: 1 }), 'publish'),
  ).toEqual(first);
  expect(await snapshot(h, f.appId)).toEqual(before);
  await conflict(await write(f, 'publish', { version: 1, expected_revision: 0 }), 'publish');
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([false, true])(
  '[AC-F1-06y#11] 内置态恢复是空操作但仍校验 revision（已有行=%s）',
  async (existing) => {
    const f = await setup(h);
    if (existing) {
      await version(h, f.actor, 'jd', 1, { ...REGISTERED, ever_published: true });
      await icon(h, f.actor, 'jd', null, 9);
    }
    const revision = existing ? 9 : 0;
    const before = await snapshot(h, f.appId);
    const result = await success(
      await write(f, 'restore', { expected_revision: revision }),
      'restore',
    );
    expect(result).toMatchObject({
      current: null,
      current_version: null,
      revision,
      latest_version: existing ? 1 : null,
    });
    const after = await snapshot(h, f.appId);
    expect(after.audits).toEqual(before.audits);
    expect(after.versions).toEqual(before.versions);
    if (existing) expect(after).toEqual(before);
    // Creating a lock row on the absent-row path is allowed; it must remain revision zero.
    else
      for (const row of after.icons)
        expect(row).toMatchObject({ revision: 0, current_version: null });
    await conflict(await write(f, 'restore', { expected_revision: revision + 1 }), 'restore');
    expect(await snapshot(h, f.appId)).toEqual(after);
  },
);

it('[AC-F1-06y#12] 恢复后旧恢复请求和旧发布请求都冲突，revision 不复用', async () => {
  const f = await setup(h);
  await version(h, f.actor, 'jd', 1, { ...REGISTERED, ever_published: true });
  await icon(h, f.actor, 'jd', 1, 5);
  const initial = await snapshot(h, f.appId);
  await conflict(await write(f, 'restore', { expected_revision: 4 }), 'restore');
  expect(await snapshot(h, f.appId)).toEqual(initial);
  expect(
    await success(await write(f, 'restore', { expected_revision: 5 }), 'restore'),
  ).toMatchObject({ revision: 6 });
  const before = await snapshot(h, f.appId);
  await conflict(await write(f, 'restore', { expected_revision: 5 }), 'restore');
  await conflict(await write(f, 'publish', { expected_revision: 5, version: 1 }), 'publish');
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([false, true])(
  '[AC-F1-06y#13] 两个发布同时争用 expected_revision 只有一个成功（已有行=%s）',
  async (existing) => {
    const f = await setup(h);
    await version(h, f.actor, 'jd', 1, REGISTERED);
    await version(h, f.actor, 'jd', 2, REGISTERED);
    if (existing) await icon(h, f.actor, 'jd', null, 8);
    const revision = existing ? 8 : 0;
    const before = await snapshot(h, f.appId);
    const responses = await Promise.all(
      [1, 2].map((v) => write(f, 'publish', { expected_revision: revision, version: v })),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const winner = await success(
      responses.find((r) => r.statusCode === 200)!,
      'publish',
    );
    await conflict(
      responses.find((r) => r.statusCode === 409)!,
      'publish',
    );
    expect(await mark(h, f.appId)).toMatchObject({
      revision: revision + 1,
      current_version: winner.current_version,
    });
    for (const v of [1, 2])
      expect(await saved(h, f.appId, 'jd', v)).toMatchObject({
        ever_published: v === winner.current_version,
      });
    await transitionAudit(h, f, before, 'publish', null, winner.current_version);
  },
);

it('[AC-F1-06y#14] 发布与恢复内置并发共享同一 CAS，败方不写审计或 ever_published', async () => {
  const f = await setup(h);
  await version(h, f.actor, 'jd', 1, { ...REGISTERED, ever_published: true });
  await version(h, f.actor, 'jd', 2, REGISTERED);
  await icon(h, f.actor, 'jd', 1, 4);
  const before = await snapshot(h, f.appId);
  const responses = await Promise.all([
    write(f, 'publish', { version: 2, expected_revision: 4 }),
    write(f, 'restore', { expected_revision: 4 }),
  ]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  for (const [i, op] of ['publish', 'restore'].entries()) {
    const operation = op as 'publish' | 'restore';
    if (responses[i]!.statusCode === 200) await success(responses[i]!, operation);
    else await conflict(responses[i]!, operation);
  }
  const published = responses[0]!.statusCode === 200;
  expect(await mark(h, f.appId)).toMatchObject({
    current_version: published ? 2 : null,
    revision: 5,
  });
  expect(await saved(h, f.appId, 'jd', 2)).toMatchObject({ ever_published: published });
  await transitionAudit(
    h,
    f,
    before,
    published ? 'publish' : 'restore_builtin',
    1,
    published ? 2 : null,
  );
});
