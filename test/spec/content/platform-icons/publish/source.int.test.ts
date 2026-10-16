import { expect, it } from 'vitest';
import { useHarness } from '../../../admin/auth/kit.ts';
import { orderedRace } from './ordered-race.ts';
import {
  auditDelta,
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
  version,
  write,
  type Version,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-06y#27] 只纠正来源时保留已有下载日期和文件信息', async () => {
  const f = await setup(h);
  const original = await version(h, f.actor, 'jd', 1, REGISTERED);
  const result = await success<Version>(
    await write(f, 'source', { expected_revision: 1, source_url: `${SOURCE}/corrected` }),
    'source',
  );
  expect(result).toEqual({ ...original, source_url: `${SOURCE}/corrected`, revision: 2 });
  expect((await history(f, 'jd')).items[0]).toEqual(result);
});

it.each([false, true])(
  '[AC-F1-06y#1] 部分登记保留省略字段、版本 revision 独立递增并写审计（已有标识=%s）',
  async (existing) => {
    const f = await setup(h);
    const original = await version(h, f.actor, 'jd', 1, { revision: 5 });
    if (existing) await icon(h, f.actor, 'jd', null, 19);
    const before = await snapshot(h, f.appId);
    const first = await success<Version>(
      await write(f, 'source', { expected_revision: 5, source_url: SOURCE }),
      'source',
    );
    expect(first).toMatchObject({
      ...original,
      source_url: SOURCE,
      revision: 6,
      publishable: false,
    });
    expect(await mark(h, f.appId)).toMatchObject({
      current_version: null,
      revision: existing ? 19 : 0,
      updated_by: f.actor.username,
      updated_by_admin_id: f.actor.id,
      updated_at: f.clock.now(),
    });
    await auditDelta(h, f, before, 'version_source');
    const middle = await snapshot(h, f.appId);
    f.clock.advanceMs(1000);
    const second = await success<Version>(
      await write(f, 'source', { expected_revision: 6, downloaded_on: DATE }),
      'source',
    );
    expect(second).toMatchObject({ ...first, downloaded_on: DATE, revision: 7, publishable: true });
    expect((await history(f, 'jd')).items[0]).toEqual(second);
    const row = await saved(h, f.appId);
    expect(row).toMatchObject({
      source_url: SOURCE,
      revision: 7,
      ever_published: false,
      sha256: original.sha256,
    });
    expect(await mark(h, f.appId)).toMatchObject({
      revision: existing ? 19 : 0,
      updated_at: f.clock.now(),
    });
    await auditDelta(h, f, middle, 'version_source');
    expect((await snapshot(h, f.appId)).uploads).toEqual(before.uploads);
  },
);

it('[AC-F1-06y#2] 可同时纠正两个登记字段，CAS 使用版本而非标识的 revision，旧请求无副作用', async () => {
  const f = await setup(h);
  await version(h, f.actor, 'jd', 1, { ...REGISTERED, revision: 4 });
  await icon(h, f.actor, 'jd', null, 17);
  const before = await snapshot(h, f.appId);
  await conflict(
    await write(f, 'source', { expected_revision: 17, source_url: `${SOURCE}/wrong` }),
    'source',
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  const changed = { source_url: `${SOURCE}/corrected`, downloaded_on: '2026-10-02' };
  expect(
    await success<Version>(
      await write(f, 'source', { expected_revision: 4, ...changed }),
      'source',
    ),
  ).toMatchObject({ ...changed, revision: 5, publishable: true });
  const after = await snapshot(h, f.appId);
  await conflict(await write(f, 'source', { expected_revision: 4, ...changed }), 'source');
  expect(await snapshot(h, f.appId)).toEqual(after);
  expect(await mark(h, f.appId)).toMatchObject({ revision: 17 });
});

it.each(['unknown', 'current', 'restored'] as const)(
  '[AC-F1-06y#3] %s 版本不能补登，返回 20001 [version] 且不改库或审计',
  async (state) => {
    const f = await setup(h);
    if (state !== 'unknown') {
      await version(h, f.actor, 'jd', 1, { ...REGISTERED, ever_published: true });
      await icon(h, f.actor, 'jd', state === 'current' ? 1 : null, 8);
    }
    const before = await snapshot(h, f.appId);
    await rejected(
      await write(f, 'source', { expected_revision: 1, source_url: `${SOURCE}/edit` }),
      'source',
      20001,
      { fields: ['version'] },
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it.each(['a', 'b'] as const)(
  '[AC-F1-06y#4] 登记 %s 先读后写必败，后发请求先完成，revision 只增一次',
  async (first) => {
    const f = await setup(h);
    await version(h, f.actor, 'jd', 1);
    // The revised pause may pass a DO NOTHING insert only when the mark already exists.
    await icon(h, f.actor, 'jd', null, 0);
    const before = await snapshot(h, f.appId);
    const second = first === 'a' ? 'b' : 'a';
    const responses = await orderedRace(
      h,
      f,
      { op: 'source', body: { expected_revision: 1, source_url: `${SOURCE}/${first}` } },
      { op: 'source', body: { expected_revision: 1, source_url: `${SOURCE}/${second}` } },
      true,
    );
    const winner = await success<Version>(responses.second, 'source');
    await conflict(responses.first, 'source');
    expect(winner).toMatchObject({ revision: 2, source_url: `${SOURCE}/${second}` });
    expect(await saved(h, f.appId)).toMatchObject({
      revision: 2,
      source_url: winner.source_url,
      downloaded_on: null,
    });
    expect(await mark(h, f.appId)).toMatchObject({ revision: 0, current_version: null });
    await auditDelta(h, f, before, 'version_source');
  },
);

it.each([
  { expected_revision: 1 },
  { expected_revision: 1, source_url: null },
  { expected_revision: 1, downloaded_on: null },
  { expected_revision: 0, source_url: SOURCE },
  { source_url: SOURCE },
])('[AC-F1-06y#5] PATCH 拒绝不符合契约的登记体 %j', async (body) => {
  const f = await setup(h);
  await version(h, f.actor, 'jd', 1);
  const before = await snapshot(h, f.appId);
  await rejected(await write(f, 'source', body), 'source', 20001);
  expect(await snapshot(h, f.appId)).toEqual(before);
});
