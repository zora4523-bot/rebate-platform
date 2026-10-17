// F1-10e rulings 15～17 and the contract's permission text: reads need any config.* point and no
// step-up; writes need the key's one point, with totp step-up for config.risk / config.business
// and none for config.general; routes only on the admin entry.
import { expect, it, vi } from 'vitest';
import { factory, useHarness } from '../../admin/auth/kit.ts';
import { guardOf } from '../../admin/guard-mount/kit.ts';
import {
  ALL_POINTS,
  KEYS,
  OPERATIONS,
  POINT_KEYS,
  READS,
  batch,
  call,
  current,
  denied,
  getItem,
  hasRoute,
  historyPage,
  listAll,
  member,
  needsTotp,
  putVersion,
  putRow,
  rejected,
  rollback,
  setup,
  snapshot,
  stepUp,
  success,
  update,
  type Item,
  type Permission,
} from './kit.ts';

const h = useHarness();
const points = (selector: unknown): string[] =>
  (Array.isArray(selector) ? [...(selector as string[])] : [selector as string]).sort();

it('[AC-F1-10e#18] 六个接口只挂 admin 入口，api 与 stream 入口没有这些路由', async () => {
  const f = await setup(h);
  for (const op of OPERATIONS) expect(hasRoute(f.app, op), op).toBe(true);
  for (const entry of ['api', 'stream'] as const) {
    const app = await (await factory())(entry, f.overrides);
    h.apps.push(app);
    await app.init();
    for (const op of OPERATIONS) expect(hasRoute(app, op), `${entry} ${op}`).toBe(false);
  }
});

it.each(OPERATIONS)('[AC-F1-10e#19] %s 未登录 10001，不写库', async (op) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  const body =
    op === 'update'
      ? { value: 1, expected_version: 0 }
      : op === 'batch'
        ? { items: [{ key: KEYS.general, value: 1, expected_version: 0 }] }
        : op === 'rollback'
          ? { to_version: 1, expected_version: 2 }
          : undefined;
  await rejected(await call(f, op, { key: KEYS.general, body, token: null }), op, 10001);
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it.each(ALL_POINTS)(
  '[AC-F1-10e#20] 只持 %s 即可读列表、单项与历史，不要二次验证令牌',
  async (point) => {
    const f = await setup(h);
    await putRow(h, f.appId, KEYS.business, 3);
    const { token } = await member(h, f, [point]);
    const reader = { ...f, token };
    expect((await listAll(reader)).length).toBeGreaterThan(0);
    for (const key of [KEYS.general, KEYS.risk, KEYS.business]) {
      expect((await getItem(reader, key)).key).toBe(key);
      expect((await historyPage(reader, key)).total).toBe(0);
    }
  },
);

it.each(READS)(
  '[AC-F1-10e#21] %s 无 config.* 或只有无关权限点 10403；守卫以只读模式收三个 config.* 之一',
  async (op) => {
    const f = await setup(h);
    const guard = await guardOf(f.app);
    const run = vi.spyOn(guard, 'run');
    try {
      for (const grants of [[], ['user.list', 'switch.all', 'content.platform_icon']]) {
        const { token } = await member(h, f, grants);
        await denied(await call({ ...f, token }, op, { key: KEYS.general }), op);
      }
      run.mockClear();
      await success(await call(f, op, { key: KEYS.general }), op);
      expect(run).toHaveBeenCalledTimes(1);
      const input = run.mock.calls[0]![0];
      expect(points(input.permission)).toStrictEqual([...ALL_POINTS].sort());
      expect(input.readOnly).toBe(true);
    } finally {
      run.mockRestore();
    }
  },
);

it('[AC-F1-10e#22] config.general 的键：持 config.general 改值不要二次验证令牌，守卫写模式只收 config.general', async () => {
  const f = await setup(h);
  const guard = await guardOf(f.app);
  const run = vi.spyOn(guard, 'run');
  try {
    const { who, token } = await member(h, f, ['config.general']);
    const item = await success<Item>(
      await update({ ...f, token }, KEYS.general, { value: 3, expected_version: 0 }),
      'update',
    );
    expect(item).toMatchObject({ value: 3, version: 1, updated_by: who.username });
    expect(run).toHaveBeenCalledTimes(1);
    const input = run.mock.calls[0]![0];
    expect(points(input.permission)).toStrictEqual(['config.general']);
    expect(input.readOnly ?? false).toBe(false);
  } finally {
    run.mockRestore();
  }
});

it.each(['config.risk', 'config.business'] as const)(
  '[AC-F1-10e#23] %s 的键：缺令牌 10003 tier=totp 不写库，带有效 totp 令牌后改值成功；守卫只收该点',
  async (point: Permission) => {
    const f = await setup(h);
    const key = POINT_KEYS[point];
    const guard = await guardOf(f.app);
    const run = vi.spyOn(guard, 'run');
    try {
      const { who, token } = await member(h, f, [point]);
      const caller = { ...f, token };
      const before = await snapshot(h, f.appId);
      await needsTotp(await update(caller, key, { value: 5, expected_version: 0 }), 'update');
      await needsTotp(
        await batch(caller, { items: [{ key, value: 5, expected_version: 0 }] }),
        'batch',
      );
      expect(await snapshot(h, f.appId)).toStrictEqual(before);
      run.mockClear();
      const stepped = await stepUp(f, who, token);
      const item = await success<Item>(
        await update(caller, key, { value: 5, expected_version: 0 }, { stepUp: stepped }),
        'update',
      );
      expect(item).toMatchObject({ key, value: 5, version: 1, permission: point });
      expect(run).toHaveBeenCalledTimes(1);
      const input = run.mock.calls[0]![0];
      expect(points(input.permission)).toStrictEqual([point]);
      expect(input.readOnly ?? false).toBe(false);
      // Rollback is guarded the same way.
      await putVersion(h, f.appId, key, 2, 7, f.actor);
      await h.db
        .updateTable('config_items')
        .set({ value: JSON.stringify(7), version: 2 })
        .where('app_id', '=', f.appId)
        .where('key', '=', key)
        .execute();
      await needsTotp(
        await rollback(caller, key, { to_version: 1, expected_version: 2 }),
        'rollback',
      );
      expect(await current(h, f.appId, key)).toMatchObject({ version: 2, value: 7 });
    } finally {
      run.mockRestore();
    }
  },
);

it.each([
  ['config.general', 'config.risk'],
  ['config.general', 'config.business'],
  ['config.risk', 'config.general'],
  ['config.risk', 'config.business'],
  ['config.business', 'config.general'],
  ['config.business', 'config.risk'],
] as const)(
  '[AC-F1-10e#24] 只持 %s 改 %s 的键：10403 admin_permission_denied，单项、整批、回滚都不写库',
  async (held, needed) => {
    const f = await setup(h);
    const key = POINT_KEYS[needed];
    await putVersion(h, f.appId, key, 1, 1, f.actor);
    await putRow(h, f.appId, key, 4, 2);
    const { who, token } = await member(h, f, [held]);
    const caller = { ...f, token };
    const before = await snapshot(h, f.appId);
    const stepped = held === 'config.general' ? undefined : await stepUp(f, who, token);
    const extra = stepped === undefined ? {} : { stepUp: stepped };
    await denied(await update(caller, key, { value: 2, expected_version: 2 }, extra), 'update');
    await denied(
      await batch(caller, { items: [{ key, value: 2, expected_version: 2 }] }, extra),
      'batch',
    );
    await denied(
      await rollback(caller, key, { to_version: 1, expected_version: 2 }, extra),
      'rollback',
    );
    expect(await snapshot(h, f.appId)).toStrictEqual(before);
  },
);

it('[AC-F1-10e#25] 超管改 risk / business 的键同样要 totp 令牌，改 general 的键不要', async () => {
  const f = await setup(h);
  await needsTotp(await update(f, KEYS.risk, { value: 300, expected_version: 0 }), 'update');
  await needsTotp(await update(f, KEYS.business, { value: 2, expected_version: 0 }), 'update');
  expect(await current(h, f.appId, KEYS.risk)).toBeUndefined();
  expect(await current(h, f.appId, KEYS.business)).toBeUndefined();
  await success(await update(f, KEYS.general, { value: 2, expected_version: 0 }), 'update');
  await success(
    await update(f, KEYS.risk, { value: 300, expected_version: 0 }, { stepUp: await stepUp(f) }),
    'update',
  );
});
