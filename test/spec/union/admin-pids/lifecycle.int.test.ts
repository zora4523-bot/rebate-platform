import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { harness as pidHarness } from '../pids/kit.ts';
import {
  CONFIRMED,
  REASON,
  accepted,
  audit,
  bodyFor,
  current,
  listed,
  rejected,
  seedAccount,
  seedPid,
  setup,
  snapshot,
  type PidRow,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-22h#1] 列表不分页，按平台、场景、创建时刻排序，包含三态且隔离 app', async () => {
  const s = await setup(h);
  const other = await setup(h);
  await seedPid(other);
  const fixtures = [
    ['taobao', 'share', 'active', '2026-10-03T00:00:00Z'],
    ['jd', 'share', 'pending', '2026-10-02T00:00:00Z'],
    ['jd', 'agent', 'retired', '2026-10-01T00:00:00Z'],
    ['jd', 'share', 'retired', '2026-10-01T00:00:00Z'],
    ['pdd', 'self_buy', 'pending', '2026-10-03T00:00:00Z'],
  ] as const;
  const rows: PidRow[] = [];
  for (const [platform, pid_scene, status, created_at] of fixtures) {
    rows.push(await seedPid(s, { platform, pid_scene, status, created_at: new Date(created_at) }));
  }
  const before = await snapshot(s);
  const items = await listed(s); // No step-up token is issued for the read.
  expect(items.map((item) => item.pid_id)).toEqual([2, 3, 1, 4, 0].map((i) => rows[i]!.id));
  for (const item of items) {
    const row = rows.find((r) => r.id === item.pid_id)!;
    expect(item).toEqual({
      pid_id: row.id,
      platform: row.platform,
      union_account_id: row.union_account_id,
      site_id: row.site_id,
      pid: row.pid,
      pid_scene: row.pid_scene,
      status: row.status,
      hjy_ignore_confirmed_at: row.hjy_ignore_confirmed_at?.toISOString() ?? null,
      hjy_ignore_evidence_path: row.hjy_ignore_evidence_path,
      row_version: row.row_version,
      created_at: row.created_at.toISOString(),
    });
  }
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-22h#2] 无推广位时返回空 items', async () => {
  const s = await setup(h);
  expect(await listed(s)).toEqual([]);
});

it('[AC-B1-22h#46] 列表超过常见分页大小仍一次返回全部推广位', async () => {
  const s = await setup(h);
  const first = await seedPid(s);
  const extra = await h.db
    .insertInto('union_pids')
    .values(Array.from({ length: 101 }, () => ({ ...first, id: randomUUID(), pid: randomUUID() })))
    .returning('id')
    .execute();
  const items = await listed(s);
  expect(items).toHaveLength(102);
  expect(new Set(items.map((row) => row.pid_id))).toEqual(
    new Set([first.id, ...extra.map((row) => row.id)]),
  );
});

it.each(['taobao', 'jd', 'pdd'])(
  '[AC-B1-22h#3] %s 登记一律 pending，首条同步起点与登记同刻，后续登记不覆盖',
  async (platform) => {
    const s = await setup(h);
    const account = await seedAccount(s, { platform });
    const token = await s.issue();
    const createdAt = s.f.clock.now();
    const request = {
      platform,
      union_account_id: account.id,
      pid: 'a_09-Z',
      pid_scene: 'share',
      reason: REASON,
      ...(platform === 'taobao' ? { site_id: '3001' } : {}),
    };
    const first = await accepted(await s.write('create', '', request, { token }));
    expect(first).toMatchObject({
      platform,
      union_account_id: account.id,
      pid: request.pid,
      pid_scene: 'share',
      status: 'pending',
      site_id: platform === 'taobao' ? '3001' : null,
      row_version: 0,
      hjy_ignore_confirmed_at: null,
      hjy_ignore_evidence_path: null,
      created_at: createdAt.toISOString(),
    });
    expect(await current(s, first.pid_id)).toMatchObject({
      status: 'pending',
      app_id: s.appId,
      created_at: createdAt,
    });
    expect((await s.accounts())[0]!.sync_start_at).toEqual(createdAt);
    const log = await audit(s, 'create', first.pid_id, REASON);
    expect(log.after).toMatchObject({ pid: request.pid, status: 'pending' });
    s.f.clock.advanceMs(60_000);
    const second = await accepted(
      await s.write('create', '', { ...request, pid: 'second', reason: undefined }),
    );
    expect(second.status).toBe('pending');
    expect((await s.accounts())[0]!.sync_start_at).toEqual(createdAt);
  },
);

it.each(['pending', 'active', 'retired'])(
  '[AC-B1-22h#4] 同 app×平台×pid 在 %s 也不能重复登记，账号不同不能绕过',
  async (status) => {
    const s = await setup(h);
    const row = await seedPid(s, { status });
    const account = await seedAccount(s);
    const before = await snapshot(s);
    await rejected(
      await s.write('create', '', {
        ...bodyFor('create', row),
        pid: row.pid,
        union_account_id: account.id,
      }),
      20001,
      { fields: ['pid'] },
    );
    expect(await snapshot(s)).toEqual(before);
  },
);

it('[AC-B1-22h#5] pending 可同时修改五字段，原同步起点不变，目标账号首次同步起点取修改时钟', async () => {
  const s = await setup(h);
  const start = new Date('2026-09-01T00:00:00.000Z');
  const source = await seedAccount(s, { sync_start_at: start });
  const target = await seedAccount(s, { platform: 'taobao' });
  const row = await seedPid(s, { union_account_id: source.id });
  const token = await s.issue();
  const body = {
    platform: 'taobao',
    union_account_id: target.id,
    site_id: '3009',
    pid: '2009',
    pid_scene: 'share',
    expected_row_version: row.row_version,
    reason: REASON,
  };
  const result = await accepted(await s.write('update', row.id, body, { token }));
  expect(result).toMatchObject({
    pid_id: row.id,
    platform: 'taobao',
    union_account_id: target.id,
    site_id: '3009',
    pid: '2009',
    pid_scene: 'share',
    status: 'pending',
    row_version: row.row_version + 1,
    created_at: row.created_at.toISOString(),
  });
  expect(await current(s, row.id)).toMatchObject({
    platform: 'taobao',
    union_account_id: target.id,
    site_id: '3009',
    pid: '2009',
    pid_scene: 'share',
    status: 'pending',
  });
  const accounts = await s.accounts();
  expect(accounts.find((a) => a.id === source.id)!.sync_start_at).toEqual(start);
  expect(accounts.find((a) => a.id === target.id)!.sync_start_at).toEqual(s.f.clock.now());
  const log = await audit(s, 'update', row.id, REASON);
  expect(log.before).toMatchObject({
    platform: 'jd',
    union_account_id: source.id,
    site_id: null,
    pid: row.pid,
    pid_scene: 'self_buy',
  });
  expect(log.after).toMatchObject({
    platform: 'taobao',
    union_account_id: target.id,
    site_id: '3009',
    pid: '2009',
    pid_scene: 'share',
  });
});

it('[AC-B1-22h#6] 换到已有同步起点的账号保留两边起点，并可清空非淘宝 site_id', async () => {
  const s = await setup(h);
  const start = new Date('2026-09-01T00:00:00Z');
  const source = await seedAccount(s, { platform: 'taobao', sync_start_at: start });
  const target = await seedAccount(s, { sync_start_at: start });
  const row = await seedPid(s, { platform: 'taobao', union_account_id: source.id });
  const data = await accepted(
    await s.write('update', row.id, {
      platform: 'jd',
      union_account_id: target.id,
      site_id: null,
      expected_row_version: row.row_version,
    }),
  );
  expect(data).toMatchObject({ platform: 'jd', site_id: null, union_account_id: target.id });
  expect((await s.accounts()).map((a) => a.sync_start_at)).toEqual([start, start]);
});

for (const status of ['active', 'retired']) {
  for (const field of ['platform', 'union_account_id', 'site_id', 'pid', 'pid_scene']) {
    it(`[AC-B1-22h#7] ${status} 的 ${field} 不能修改，20902 且整行不变`, async () => {
      const s = await setup(h);
      const row = await seedPid(s, { platform: 'taobao', status });
      const target = await seedAccount(s, { platform: 'taobao' });
      const values: Record<string, unknown> = {
        platform: 'taobao',
        union_account_id: target.id,
        site_id: '999',
        pid: '999',
        pid_scene: 'share',
      };
      const before = await snapshot(s);
      await rejected(
        await s.write('update', row.id, {
          [field]: values[field],
          expected_row_version: row.row_version,
        }),
        20902,
        { resource: 'union_pid' },
      );
      expect(await snapshot(s)).toEqual(before);
    });
  }
}

it('[AC-B1-22h#8] 上传确认截图后启用，再停用仍保留白名单记录，版本每次仅增一', async () => {
  const s = await setup(h);
  const row = await seedPid(s);
  // Exercise the frozen B1-19 reader against rows written through the new HTTP interface.
  const reader = pidHarness(h.db).service;
  const match = {
    appId: s.appId,
    platform: 'jd' as const,
    unionAccountId: row.union_account_id,
    pid: row.pid,
    siteId: null,
  };
  const scene = {
    appId: s.appId,
    platform: 'jd' as const,
    pidScene: 'self_buy' as const,
    purpose: 'convert' as const,
  };
  expect(await reader.isWhitelisted(match)).toBe(true);
  expect(await reader.getActivePid(scene)).toBeNull();
  const active = await accepted(
    await s.write('activate', row.id, { ...bodyFor('activate', row), reason: REASON }),
  );
  expect(active).toMatchObject({
    pid_id: row.id,
    status: 'active',
    row_version: row.row_version + 1,
    hjy_ignore_confirmed_at: CONFIRMED,
  });
  expect(active.hjy_ignore_evidence_path).toEqual(expect.any(String));
  expect(active.hjy_ignore_evidence_path!.length).toBeGreaterThan(0);
  expect(active.hjy_ignore_evidence_path).not.toMatch(/^https?:\/\//);
  const stored = await current(s, row.id);
  expect(stored).toMatchObject({
    status: 'active',
    row_version: row.row_version + 1,
    hjy_ignore_confirmed_at: new Date(CONFIRMED),
    hjy_ignore_evidence_path: active.hjy_ignore_evidence_path,
  });
  await audit(s, 'activate', row.id, REASON);
  expect((await reader.getActivePid(scene))?.id).toBe(row.id);
  expect(await reader.isWhitelisted(match)).toBe(true);
  const retired = await accepted(
    await s.write('retire', row.id, { expected_row_version: active.row_version, reason: REASON }),
  );
  expect(retired).toMatchObject({
    ...active,
    status: 'retired',
    row_version: active.row_version + 1,
  });
  expect(await current(s, row.id)).toMatchObject({
    ...stored,
    status: 'retired',
    row_version: stored.row_version + 1,
    updated_at: s.f.clock.now(),
  });
  expect((await listed(s)).map((p) => p.pid_id)).toEqual([row.id]);
  await audit(s, 'retire', row.id, REASON);
  expect(await reader.getActivePid(scene)).toBeNull();
  expect(await reader.isWhitelisted(match)).toBe(true);
});

for (const [action, states] of [
  ['activate', ['active', 'retired']],
  ['retire', ['pending', 'retired']],
] as const) {
  it.each(states)(`[AC-B1-22h#9] ${action} 不接受 %s，禁止跳步与恢复`, async (status) => {
    const s = await setup(h);
    const row = await seedPid(s, { status });
    const before = await snapshot(s);
    await rejected(await s.write(action, row.id, bodyFor(action, row)), 20902, {
      resource: 'union_pid',
    });
    expect(await snapshot(s)).toEqual(before);
  });
}

it.each([false, true])(
  '[AC-B1-22h#10] 同场景已有 active 拒绝启用，跨联盟账号=%s；先停旧才可启新',
  async (differentAccount) => {
    const s = await setup(h);
    const old = await seedPid(s, { status: 'active' });
    const pending = await seedPid(
      s,
      differentAccount ? {} : { union_account_id: old.union_account_id },
    );
    const before = await snapshot(s);
    const token = await s.issue();
    await rejected(
      await s.write('activate', pending.id, bodyFor('activate', pending), { token }),
      30155,
    );
    expect(await snapshot(s)).toEqual(before);
    await accepted(await s.write('retire', old.id, bodyFor('retire', old)));
    expect(
      (
        await accepted(
          await s.write('activate', pending.id, bodyFor('activate', pending), { token }),
        )
      ).status,
    ).toBe('active');
    expect(await current(s, old.id)).toMatchObject({ status: 'retired' });
    expect(await s.rows()).toHaveLength(2);
  },
);

it('[AC-B1-22h#11] 其他 app、平台、场景的 active 不阻止当前场景启用', async () => {
  const s = await setup(h);
  const other = await setup(h);
  await seedPid(other, { status: 'active' });
  await seedPid(s, { status: 'active', platform: 'pdd' });
  await seedPid(s, { status: 'active', pid_scene: 'share' });
  const row = await seedPid(s);
  expect((await accepted(await s.write('activate', row.id, bodyFor('activate', row)))).status).toBe(
    'active',
  );
  expect((await s.rows()).filter((p) => p.status === 'active')).toHaveLength(3);
});

it('[AC-B1-22h#12] 同 pid 在其他 app 或平台不构成重复登记', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const pid = randomUUID();
  await seedPid(other, { pid });
  await seedPid(s, { pid, platform: 'pdd' });
  const account = await seedAccount(s);
  expect(
    (
      await accepted(
        await s.write('create', '', {
          platform: 'jd',
          union_account_id: account.id,
          pid,
          pid_scene: 'share',
        }),
      )
    ).pid,
  ).toBe(pid);
});
