import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seed } from '../../../admin/accounts/kit.ts';
import { signedIn, useHarness } from '../../../admin/auth/kit.ts';
import { icon, version, history } from '../read/kit.ts';
import { write, success as writeSuccess } from '../publish/kit.ts';
import {
  DATE,
  REGISTERED,
  SOURCE,
  UNSAFE_SVG,
  auditDelta,
  create,
  mark,
  pending,
  png,
  rejected,
  saved,
  setup,
  snapshot,
  success,
  upload,
  type Version,
} from './kit.ts';

const h = useHarness();

it.each([{}, { source_url: SOURCE }, { downloaded_on: DATE }, REGISTERED])(
  '[AC-F1-06x#12] 登记 %j 决定草稿或可发布，新版本 revision=1、从未发布，审计与作者快照完整',
  async (registration) => {
    const f = await setup(h);
    const pendingRow = await pending(h, f);
    f.clock.advanceMs(2345);
    const before = await snapshot(h, f.appId);
    const data = await success<Version>(
      await create(f, { upload_id: pendingRow.id, ...registration }),
      'versions',
    );
    expect(data).toMatchObject({
      version: 1,
      revision: 1,
      ever_published: false,
      source_url: 'source_url' in registration ? SOURCE : null,
      downloaded_on: 'downloaded_on' in registration ? DATE : null,
      publishable: 'source_url' in registration && 'downloaded_on' in registration,
      sha256: pendingRow.sha256,
      format: pendingRow.format,
      bytes: pendingRow.bytes,
      sanitized: false,
      created_by: f.actor.username,
    });
    expect(new Date(data.created_at)).toEqual(f.clock.now());
    expect(await saved(h, f.appId)).toMatchObject({
      upload_id: pendingRow.id,
      app_id: f.appId,
      key: 'jd',
      created_by_admin_id: f.actor.id,
      created_by: f.actor.username,
      created_at: f.clock.now(),
    });
    expect(await mark(h, f.appId)).toMatchObject({
      current_version: null,
      revision: 0,
      updated_by: f.actor.username,
      updated_by_admin_id: f.actor.id,
      updated_at: f.clock.now(),
    });
    expect((await history(f, 'jd')).items).toEqual([data]);
    const audit = await auditDelta(h, f, before, 'version_create');
    const facts = { ...(audit.before as object | null), ...(audit.after as object | null) };
    expect(facts).toMatchObject({ key: 'jd', version: 1, upload_id: pendingRow.id });
    expect(JSON.stringify(facts)).not.toMatch(/<svg|base64|"file"/i);
    expect((await snapshot(h, f.appId)).uploads).toEqual(before.uploads);
    await h.db
      .updateTable('admin_users')
      .set({ login_name: `renamed-${randomUUID()}` })
      .where('id', '=', f.actor.id)
      .execute();
    expect((await history(f, 'jd')).items[0]!.created_by).toBe(f.actor.username);
  },
);

it('[AC-F1-06x#13] 版本号按 app 与 key 独立递增，保存只更新 updated_* 不改当前版本和标识 revision', async () => {
  const f = await setup(h);
  await version(h, f.actor, 'jd', 1, { ...REGISTERED, ever_published: true });
  await icon(h, f.actor, 'jd', 1, 7);
  const other = await seed(h, `f1-06x-number-${randomUUID()}`, { isSuper: true });
  await version(h, other, 'jd', 99, REGISTERED);
  await icon(h, other, 'jd', 99, 7);
  const foreign = await snapshot(h, other.appId);
  const editor = await seed(h, f.appId, { isSuper: true });
  const session = await signedIn(f, editor);
  const caller = { ...f, token: session.admin_token };
  for (const [key, number] of [
    ['jd', 2],
    ['tmall', 1],
    ['jd', 3],
  ] as const) {
    const row = await pending(h, f, { key });
    const result = await success<Version>(
      await create(caller, { upload_id: row.id, ...REGISTERED }, key),
      'versions',
    );
    expect(result.version).toBe(number);
    expect(result.created_by).toBe(editor.username);
  }
  expect(await mark(h, f.appId)).toMatchObject({
    current_version: 1,
    revision: 7,
    updated_by: editor.username,
    updated_by_admin_id: editor.id,
    updated_at: f.clock.now(),
  });
  expect(await snapshot(h, other.appId)).toEqual(foreign);
});

it.each(['missing', 'expired', 'boundary', 'other-key', 'other-app'] as const)(
  '[AC-F1-06x#14] %s upload 返回 20001 [upload_id]，不建标识、版本或审计',
  async (kind) => {
    const f = await setup(h);
    const other = await seed(h, `f1-06x-foreign-${randomUUID()}`, { isSuper: true });
    const row = await pending(h, f, {
      key: kind === 'other-key' ? 'tmall' : 'jd',
      actor: kind === 'other-app' ? other : f.actor,
      remainingMs: kind === 'expired' || kind === 'boundary' ? 1000 : 86_400_000,
    });
    if (kind === 'expired' || kind === 'boundary')
      f.clock.advanceMs(kind === 'boundary' ? 1000 : 1001);
    const before = await snapshot(h, f.appId);
    const foreign = await snapshot(h, other.appId);
    await rejected(
      await create(f, { upload_id: kind === 'missing' ? randomUUID() : row.id }),
      'versions',
      20001,
      {
        fields: ['upload_id'],
      },
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
    expect(await snapshot(h, other.appId)).toEqual(foreign);
  },
);

it('[AC-F1-06x#15] 过期前 1ms 仍可保存；清洗预览必须确认，未确认拒绝不消费 upload', async () => {
  const f = await setup(h);
  const row = await pending(h, f, { sanitized: true, remainingMs: 1000 });
  f.clock.advanceMs(999);
  const before = await snapshot(h, f.appId);
  for (const confirmation of [{}, { sanitized_confirmed: false }]) {
    await rejected(await create(f, { upload_id: row.id, ...confirmation }), 'versions', 20001, {
      fields: ['sanitized_confirmed'],
    });
    expect(await snapshot(h, f.appId)).toEqual(before);
  }
  expect(
    await success<Version>(
      await create(f, {
        upload_id: row.id,
        sanitized_confirmed: true,
      }),
      'versions',
    ),
  ).toMatchObject({ version: 1, sanitized: true });
});

it('[AC-F1-06x#16] 上传清洗后保存沿用清洗文件信息，未清洗 PNG 无需确认', async () => {
  const f = await setup(h);
  const uploaded = await success(await upload(f, UNSAFE_SVG), 'uploads');
  expect(uploaded.sanitized).toBe(true);
  const result = await success<Version>(
    await create(f, {
      upload_id: uploaded.upload_id,
      sanitized_confirmed: true,
    }),
    'versions',
  );
  expect(result).toMatchObject({
    sha256: uploaded.sha256,
    bytes: uploaded.bytes,
    format: uploaded.format,
    url: uploaded.url,
    sanitized: true,
    publishable: false,
  });
  const originalPng = await success(await upload(f, png()), 'uploads');
  expect(originalPng.sanitized).toBe(false);
  expect(
    await success<Version>(
      await create(f, {
        upload_id: originalPng.upload_id,
      }),
      'versions',
    ),
  ).toMatchObject({
    version: 2,
    format: 'png',
    sanitized: false,
    sha256: originalPng.sha256,
  });
});

it('[AC-F1-06x#17] 同 upload 重试返回当前版本；先幂等后确认，不套用重试来源、不再审计或更新时间', async () => {
  const f = await setup(h);
  const row = await pending(h, f, { sanitized: true });
  const first = await success<Version>(
    await create(f, {
      upload_id: row.id,
      sanitized_confirmed: true,
    }),
    'versions',
  );
  const current = await writeSuccess<Version>(
    await write(f, 'source', {
      expected_revision: first.revision,
      ...REGISTERED,
    }),
    'source',
  );
  await writeSuccess(await write(f, 'publish', { expected_revision: 0, version: 1 }), 'publish');
  f.clock.advanceMs(1000);
  const before = await snapshot(h, f.appId);
  const replay = await success<Version>(
    await create(f, {
      upload_id: row.id,
      sanitized_confirmed: false,
      source_url: `${SOURCE}/ignored`,
      downloaded_on: '2026-10-08',
    }),
    'versions',
  );
  expect(replay).toEqual({ ...current, ever_published: true });
  expect(await snapshot(h, f.appId)).toEqual(before);
  // An already-saved upload is still confined to its original mark.
  await rejected(await create(f, { upload_id: row.id }, 'tmall'), 'versions', 20001, {
    fields: ['upload_id'],
  });
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([
  {},
  { upload_id: 'not-a-uuid' },
  { upload_id: randomUUID(), sanitized_confirmed: 'true' },
  { upload_id: randomUUID(), source_url: null },
  { upload_id: randomUUID(), downloaded_on: 'not-a-date' },
])('[AC-F1-06x#18] 保存请求 %j 按契约拒绝，数据库保持原状', async (body) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await rejected(await create(f, body), 'versions', 20001);
  expect(await snapshot(h, f.appId)).toEqual(before);
});
