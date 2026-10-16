// F1-10d: GET /admin/v1/kill-switches (adminListKillSwitches), brief §9.2 #1 and §9.3 「列表」.
// Readings in ./kit.ts.
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { grant, seed } from '../../admin/accounts/kit.ts';
import { signedIn, useHarness } from '../../admin/auth/kit.ts';
import { guardOf } from '../../admin/guard-mount/kit.ts';
import {
  EXPECTED,
  LITERAL_KEYS,
  POINTS,
  DENIED,
  SEEDED_AT,
  expectedFor,
  instant,
  listAll,
  listPage,
  member,
  owner,
  put,
  rejected,
  seedSwitch,
  setup,
  staticFields,
  stepUp,
  success,
  updated,
  type Json,
  type Page,
  type Row,
} from './kit.ts';

const h = useHarness();

function expectStatic(row: Row) {
  expect({ ...staticFields(row.key), key: row.key }).toEqual({
    key: row.key,
    default: row.default,
    value_type: row.value_type,
    options: row.options,
    permissions: [...row.permissions].sort(),
    admin_editable: row.admin_editable,
  });
}

function expectNeverWritten(row: Row) {
  expect(row).toMatchObject({ value: null, version: 0, updated_by: null, updated_at: null });
}

/** Registered keys only, each once, grouped in registry order. */
function expectShape(rows: readonly Row[]) {
  const keys = rows.map((row) => row.key);
  expect(new Set(keys).size).toBe(keys.length);
  let last = -1;
  for (const row of rows) {
    const found = expectedFor(row.key);
    expect(found, `${row.key} is not a registered switch`).toBeDefined();
    expect(found!.index, `${row.key} out of registry order`).toBeGreaterThanOrEqual(last);
    last = found!.index;
    expectStatic(row);
  }
  for (const key of LITERAL_KEYS) expect(keys.filter((k) => k === key)).toHaveLength(1);
}

it.each(POINTS)(
  '[AC-F1-10d#1] §9.2 #1 只持 %s 即可读列表：不要求二次验证令牌，带无效令牌也忽略，所带有效令牌不被核销',
  async (point) => {
    const f = await setup(h);
    const caller = await member(h, f, [point]);
    const rows = await listAll(f, caller.token);
    expectShape(rows);
    await success<Page>(
      await listPage(f.app, caller.token, '', { 'x-step-up-token': 'invalid-step-up-token' }),
      'list',
    );
    // A token carried by a read is neither checked nor consumed: it still serves one write.
    const editor = await member(h, f, [point]);
    const token = await stepUp(f, editor);
    await success<Page>(
      await listPage(f.app, editor.token, '', { 'x-step-up-token': token }),
      'list',
    );
    const key =
      point === 'switch.pay'
        ? 'pay.enabled'
        : point === 'switch.payout'
          ? 'withdraw.enabled'
          : 'jev.enabled';
    await updated(await put(f.app, editor, key, { value: false, expected_version: 0 }, token));
  },
);

it('[AC-F1-10d#2] §9.2 #1 无 switch.* 任一点返回 10403（含只持其他权限点），未登录 10001；勾选后即可读', async () => {
  const f = await setup(h);
  const none = await member(h, f, []);
  const unrelated = await member(h, f, [
    'config.general',
    'config.business',
    'content.platform_icon',
  ]);
  await rejected(await listPage(f.app, null), 'list', 10001);
  for (const caller of [none, unrelated]) {
    await rejected(await listPage(f.app, caller.token), 'list', 10403, DENIED);
  }
  const later = await seed(h, f.appId);
  const session = await signedIn(f, later);
  await rejected(await listPage(f.app, session.admin_token), 'list', 10403, DENIED);
  await grant(h, later, f.actor, ['switch.pay']);
  expectShape(await listAll(f, session.admin_token));
});

it('[AC-F1-10d#3] §9.2 #1 未写过的开关：注册表每个字面键各一行、按注册表顺序，version 0、value null、无修改人，默认值与类型等取自注册表', async () => {
  const f = await setup(h);
  const rows = await listAll(f, f.token);
  expectShape(rows);
  for (const row of rows) expectNeverWritten(row);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  expect(byKey.get('withdraw.enabled')).toMatchObject({
    default: true,
    value_type: 'boolean',
    options: null,
    admin_editable: true,
  });
  expect([...byKey.get('withdraw.enabled')!.permissions].sort()).toEqual([
    'switch.all',
    'switch.payout',
  ]);
  expect([...byKey.get('pay.enabled')!.permissions].sort()).toEqual(['switch.all', 'switch.pay']);
  expect(byKey.get('withdraw.auto_payout.enabled')).toMatchObject({
    default: false,
    admin_editable: true,
    permissions: ['switch.all'],
  });
  expect(byKey.get('agent.whitelist_only')).toMatchObject({ default: true, admin_editable: false });
  expect(byKey.get('agent.model_route')).toMatchObject({
    value_type: 'object',
    default: null,
    admin_editable: false,
  });
  expect(byKey.get('growth.invite_bind.enabled')).toMatchObject({ default: true });
  // Literal keys keep registry order among themselves.
  const literalOrder = rows.map((row) => row.key).filter((key) => LITERAL_KEYS.includes(key));
  expect(literalOrder).toEqual(LITERAL_KEYS);
});

it('[AC-F1-10d#4] §9.2 #1 当前值取自 config_items：已写过的开关与模式键的具体键列出值、版本、时间；按占位值的默认值；非开关键与不合模式的键不列出', async () => {
  const f = await setup(h);
  const written: [string, Json, number][] = [
    ['withdraw.enabled', false, 3],
    ['convert.off_reason.pdd', 'maintenance', 2],
    ['payout.channel_enabled.wechat', true, 1],
    ['payout.channel_enabled.alipay', false, 5],
    ['payout.channel_enabled.zz_new_channel', true, 1],
    ['agent.tools.get_my_earnings.enabled', false, 4],
    ['agent.whitelist_only', true, 1],
  ];
  for (const [key, value, version] of written) {
    await seedSwitch(h, f.appId, key, value, version, '2026-10-06T07:08:09.000Z');
  }
  const foreign = [
    'config.invite.backfill_hours',
    'payout.proven_success_writeoff.enabled',
    'convert.enabled.Taobao',
    'agent.tools.a.b.enabled',
    'withdraw.enabled.extra',
  ];
  for (const key of foreign) await seedSwitch(h, f.appId, key, true, 2);
  const rows = await listAll(f, f.token);
  expectShape(rows);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const key of foreign) expect(byKey.has(key), key).toBe(false);
  for (const [key, value, version] of written) {
    const row = byKey.get(key);
    expect(row, key).toBeDefined();
    expect(row).toMatchObject({ value, version });
    expect(instant(row!.updated_at)).toBe('2026-10-06T07:08:09.000Z');
  }
  expect(byKey.get('payout.channel_enabled.wechat')!.default).toBe(false);
  expect(byKey.get('payout.channel_enabled.alipay')!.default).toBe(true);
  expect(byKey.get('payout.channel_enabled.zz_new_channel')!.default).toBe(null);
  expect(byKey.get('convert.off_reason.pdd')).toMatchObject({
    default: 'not_launched',
    value_type: 'enum',
    options: ['not_launched', 'maintenance'],
  });
  const writtenKeys = new Set(written.map(([key]) => key));
  for (const row of rows) if (!writtenKeys.has(row.key)) expectNeverWritten(row);
});

it('[AC-F1-10d#5] §9.2 #1 列表读主库不走缓存：直接改表后立即再读即见新值与版本', async () => {
  const f = await setup(h);
  const first = new Map((await listAll(f, f.token)).map((row) => [row.key, row]));
  expectNeverWritten(first.get('withdraw.enabled')!);
  await seedSwitch(h, f.appId, 'withdraw.enabled', false, 1);
  let now = new Map((await listAll(f, f.token)).map((row) => [row.key, row]));
  expect(now.get('withdraw.enabled')).toMatchObject({ value: false, version: 1 });
  await h.db
    .updateTable('config_items')
    .set({ value: true, version: 2 })
    .where('app_id', '=', f.appId)
    .where('key', '=', 'withdraw.enabled')
    .execute();
  now = new Map((await listAll(f, f.token)).map((row) => [row.key, row]));
  expect(now.get('withdraw.enabled')).toMatchObject({ value: true, version: 2 });
});

it('[AC-F1-10d#6] §9.2 #1 页码分页：缺省第 1 页 20 条；逐页拼接等于整表且 total 一致；越界页为空；page_size 201 或 page 0 返回 20001', async () => {
  const f = await setup(h);
  // Concrete pattern keys with rows guarantee more than one default page whatever the expansion.
  for (const platform of ['taobao', 'jd', 'pdd', 'tmall', 'zz_paging_a', 'zz_paging_b']) {
    await seedSwitch(h, f.appId, `convert.enabled.${platform}`, true, 1);
  }
  const all = await listAll(f, f.token);
  expect(all.length).toBeGreaterThan(20);
  const first = await success<Page>(await listPage(f.app, f.token), 'list');
  expect(first).toMatchObject({ page: 1, page_size: 20, total: all.length });
  expect(first.items.map((row) => row.key)).toEqual(all.slice(0, 20).map((row) => row.key));
  const collected: string[] = [];
  const size = 7;
  const pages = Math.ceil(all.length / size);
  for (let page = 1; page <= pages; page += 1) {
    const data = await success<Page>(
      await listPage(f.app, f.token, `?page=${page}&page_size=${size}`),
      'list',
    );
    expect(data).toMatchObject({ page, page_size: size, total: all.length });
    expect(data.items.length).toBe(page < pages ? size : all.length - size * (pages - 1));
    collected.push(...data.items.map((row) => row.key));
  }
  expect(collected).toEqual(all.map((row) => row.key));
  const beyond = await success<Page>(
    await listPage(f.app, f.token, `?page=${pages + 1}&page_size=${size}`),
    'list',
  );
  expect(beyond).toMatchObject({ items: [], page: pages + 1, total: all.length });
  await rejected(await listPage(f.app, f.token, '?page_size=201'), 'list', 20001, {
    fields: ['page_size'],
  });
  await rejected(await listPage(f.app, f.token, '?page=0'), 'list', 20001, { fields: ['page'] });
});

it('[AC-F1-10d#7] §9.3 跨 app 隔离：别的 app 的同名开关与具体键不出现在本 app 的列表里，本 app 的写入也不改别的 app', async () => {
  const f = await setup(h);
  const otherApp = `f1-10d-other-${randomUUID()}`;
  await seedSwitch(h, otherApp, 'withdraw.enabled', false, 9);
  await seedSwitch(h, otherApp, 'convert.enabled.zz_foreign_only', true, 2);
  const rows = await listAll(f, f.token);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  expectNeverWritten(byKey.get('withdraw.enabled')!);
  expect(byKey.has('convert.enabled.zz_foreign_only')).toBe(false);
  const token = await stepUp(f, owner(f));
  const result = await updated(
    await put(f.app, owner(f), 'withdraw.enabled', { value: false, expected_version: 0 }, token),
  );
  expect(result).toMatchObject({ value: false, version: 1 });
  const foreignRow = await h.db
    .selectFrom('config_items')
    .selectAll()
    .where('app_id', '=', otherApp)
    .where('key', '=', 'withdraw.enabled')
    .executeTakeFirstOrThrow();
  expect(foreignRow).toMatchObject({ value: false, version: 9, updated_by: 'f1-10d-seed' });
  expect(foreignRow.updated_at.toISOString()).toBe(SEEDED_AT);
  expect(
    await h.db
      .selectFrom('config_item_versions')
      .selectAll()
      .where('app_id', '=', otherApp)
      .execute(),
  ).toEqual([]);
});

it('[AC-F1-10d#8] §9.2 #1 列表经守卫只读模式，权限点为 switch.all / switch.payout / switch.pay 三者', async () => {
  const f = await setup(h);
  const guard = await guardOf(f.app);
  const run = vi.spyOn(guard, 'run');
  try {
    const caller = await member(h, f, ['switch.payout']);
    await success<Page>(await listPage(f.app, caller.token), 'list');
    expect(run).toHaveBeenCalledTimes(1);
    const input = run.mock.calls[0]![0];
    expect(input.readOnly).toBe(true);
    const points =
      typeof input.permission === 'string' ? [input.permission] : [...input.permission];
    expect(points.sort()).toEqual([...POINTS].sort());
  } finally {
    run.mockRestore();
  }
  expect(EXPECTED.length).toBeGreaterThan(0);
});
