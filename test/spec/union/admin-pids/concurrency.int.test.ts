import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  accepted,
  bodyFor,
  current,
  rejected,
  seedAccount,
  seedPid,
  setup,
  snapshot,
} from './kit.ts';

const h = useHarness();

for (const action of ['update', 'activate', 'retire'] as const) {
  it(`[AC-B1-22h#35] ${action} 拒绝旧版本与未来版本，全部字段和审计保持不变`, async () => {
    const s = await setup(h);
    const row = await seedPid(s, { status: action === 'retire' ? 'active' : 'pending' });
    const before = await snapshot(s);
    for (const version of [row.row_version - 1, row.row_version + 1]) {
      await rejected(
        await s.write(action, row.id, { ...bodyFor(action, row), expected_row_version: version }),
        20902,
        { resource: 'union_pid' },
      );
      expect(await snapshot(s)).toEqual(before);
    }
  });

  it(`[AC-B1-22h#36] ${action} 同一版本两个请求只能一笔成功、一条业务审计`, async () => {
    const s = await setup(h);
    const row = await seedPid(s, { status: action === 'retire' ? 'active' : 'pending' });
    const tokens = [await s.issue(), await s.issue()];
    const results = await Promise.all(
      tokens.map((token) => s.write(action, row.id, bodyFor(action, row), { token })),
    );
    expect(results.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 20902]);
    await accepted(results.find((r) => r.json().code === 0)!);
    await rejected(
      results.find((r) => r.json().code === 20902)!,
      20902,
      { resource: 'union_pid' },
    );
    expect((await current(s, row.id)).row_version).toBe(row.row_version + 1);
    expect(await s.audits()).toHaveLength(1);
  });
}

it('[AC-B1-22h#37] 同一联盟账号同场景并发启用只能一个成功，败者 30155 且保留原 pending 行', async () => {
  const s = await setup(h);
  const account = await seedAccount(s);
  const rows = [
    await seedPid(s, { union_account_id: account.id }),
    await seedPid(s, { union_account_id: account.id }),
  ];
  const tokens = [await s.issue(), await s.issue()];
  const results = await Promise.all(
    rows.map((row, i) =>
      s.write('activate', row.id, bodyFor('activate', row), { token: tokens[i]! }),
    ),
  );
  expect(results.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 30155]);
  const winner = results.findIndex((r) => r.json().code === 0);
  const loser = winner === 0 ? 1 : 0;
  await accepted(results[winner]!);
  await rejected(results[loser]!, 30155);
  expect(await current(s, rows[loser]!.id)).toEqual(rows[loser]);
  expect((await s.rows()).filter((row) => row.status === 'active')).toHaveLength(1);
  expect(await s.audits()).toHaveLength(1);
});

it('[AC-B1-22h#37] 不同联盟账号同场景并发启用两条都成功，各一条审计', async () => {
  const s = await setup(h);
  const rows = [await seedPid(s), await seedPid(s)];
  expect(rows[0]!.union_account_id).not.toBe(rows[1]!.union_account_id);
  const tokens = [await s.issue(), await s.issue()];
  const results = await Promise.all(
    rows.map((row, i) =>
      s.write('activate', row.id, bodyFor('activate', row), { token: tokens[i]! }),
    ),
  );
  for (const [i, result] of results.entries()) {
    expect(await accepted(result)).toMatchObject({
      pid_id: rows[i]!.id,
      status: 'active',
      row_version: rows[i]!.row_version + 1,
    });
  }
  expect(
    (await s.rows())
      .filter((row) => row.status === 'active')
      .map((row) => row.id)
      .sort(),
  ).toEqual(rows.map((row) => row.id).sort());
  const audits = await s.audits();
  expect(audits.map((row) => row.action)).toEqual(['union_pid_activate', 'union_pid_activate']);
  for (const row of rows) {
    expect(audits.filter((a) => a.target?.includes(row.id))).toHaveLength(1);
  }
});

it('[AC-B1-22h#38] 并发重复登记只插入一行，败者 20001 pid，不重写同步起点', async () => {
  const s = await setup(h);
  const account = await seedAccount(s);
  const tokens = [await s.issue(), await s.issue()];
  const body = {
    platform: 'jd',
    union_account_id: account.id,
    pid: 'duplicate-race',
    pid_scene: 'share',
  };
  const results = await Promise.all(tokens.map((token) => s.write('create', '', body, { token })));
  expect(results.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 20001]);
  await accepted(results.find((r) => r.json().code === 0)!);
  await rejected(
    results.find((r) => r.json().code === 20001)!,
    20001,
    { fields: ['pid'] },
  );
  const rows = await s.rows();
  expect(rows).toHaveLength(1);
  expect((await s.accounts())[0]!.sync_start_at).toEqual(rows[0]!.created_at);
  expect(await s.audits()).toHaveLength(1);
});

it('[AC-B1-22h#39] pending 修改与启用争用同一版本，不能既改归属字段又成功启用', async () => {
  const s = await setup(h);
  const row = await seedPid(s);
  const tokens = [await s.issue(), await s.issue()];
  const results = await Promise.all([
    s.write(
      'update',
      row.id,
      { pid: 'changed', pid_scene: 'share', expected_row_version: row.row_version },
      { token: tokens[0]! },
    ),
    s.write('activate', row.id, bodyFor('activate', row), { token: tokens[1]! }),
  ]);
  expect(results.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 20902]);
  const after = await current(s, row.id);
  expect(after.row_version).toBe(row.row_version + 1);
  if (results[0]!.json().code === 0) {
    expect(after).toMatchObject({
      status: 'pending',
      pid: 'changed',
      pid_scene: 'share',
      hjy_ignore_confirmed_at: null,
      hjy_ignore_evidence_path: null,
    });
  } else expect(after).toMatchObject({ status: 'active', pid: row.pid, pid_scene: row.pid_scene });
  await accepted(results.find((r) => r.json().code === 0)!);
  await rejected(
    results.find((r) => r.json().code === 20902)!,
    20902,
    { resource: 'union_pid' },
  );
  expect(await s.audits()).toHaveLength(1);
});
