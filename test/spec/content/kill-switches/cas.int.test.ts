// F1-10d: version compare-and-set, history row, audit, alert and the 10-second effect of
// PUT /admin/v1/kill-switches/{key} (brief §9.2 #3–#6; §9.3). Readings in ./kit.ts.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import { factory, useHarness } from '../../admin/auth/kit.ts';
import {
  ACTION,
  SWITCH_EFFECTIVE_MS,
  alertLines,
  auditAdded,
  conflict,
  expectAlert,
  expectAuditFacts,
  historyOf,
  instant,
  item,
  listAll,
  member,
  owner,
  put,
  rejected,
  seedHistory,
  seedSwitch,
  setup,
  snapshot,
  stepUp,
  updated,
} from './kit.ts';
import { orderedRace } from './ordered-race.ts';

const h = useHarness();

it.each([
  ['已有行（版本 3），expected_version 偏低', true, 2],
  ['已有行（版本 3），expected_version 偏高', true, 4],
  ['已有行（版本 3），expected_version=0', true, 0],
  ['无行，expected_version=1', false, 1],
  ['无行，expected_version=5', false, 5],
] as const)(
  '[AC-F1-10d#17] §9.2 #3 CAS 不匹配：%s → 20902 resource=kill_switch，不写行、历史、审计与告警，不核销令牌',
  async (_label, existing, expected) => {
    const f = await setup(h);
    const key = 'withdraw.enabled';
    if (existing) await seedSwitch(h, f.appId, key, true, 3);
    const token = await stepUp(f, owner(f));
    const before = await snapshot(h, f.appId);
    const mark = f.lines.length;
    await conflict(
      await put(f.app, owner(f), key, { value: false, expected_version: expected }, token),
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
    expect(alertLines(f.lines, mark)).toEqual([]);
    const current = existing ? 3 : 0;
    expect(
      await updated(
        await put(f.app, owner(f), key, { value: false, expected_version: current }, token),
      ),
    ).toMatchObject({ value: false, version: current + 1 });
  },
);

it('[AC-F1-10d#18] §9.2 #3 首次写入：无行且 expected_version=0 时新建行为版本 1，同时写一条历史与一条审计，响应即当前开关', async () => {
  const f = await setup(h);
  const key = 'convert.off_reason.pdd';
  const caller = await member(h, f, ['switch.all']);
  const token = await stepUp(f, caller);
  const before = await snapshot(h, f.appId);
  const row = await updated(
    await put(
      f.app,
      caller,
      key,
      { value: 'maintenance', expected_version: 0, reason: '拼多多维护' },
      token,
    ),
  );
  const at = f.clock.now();
  expect(row).toMatchObject({
    key,
    value: 'maintenance',
    default: 'not_launched',
    value_type: 'enum',
    options: ['not_launched', 'maintenance'],
    permissions: ['switch.all'],
    admin_editable: true,
    version: 1,
    updated_by: caller.account.username,
  });
  expect(instant(row.updated_at)).toBe(at.toISOString());
  expect(await item(h, f.appId, key)).toMatchObject({
    app_id: f.appId,
    value: 'maintenance',
    version: 1,
    updated_by: caller.account.username,
    updated_at: at,
  });
  expect(await historyOf(h, f.appId, key)).toEqual([
    expect.objectContaining({
      app_id: f.appId,
      key,
      version: 1,
      value: 'maintenance',
      updated_by: caller.account.username,
      updated_by_admin_id: caller.account.id,
      reason: '拼多多维护',
      created_at: at,
    }),
  ]);
  const audit = await auditAdded(h, f, before, caller.account, at);
  expectAuditFacts(audit, {
    key,
    from: 0,
    to: 1,
    after: 'maintenance',
    reason: '拼多多维护',
  });
  const listed = (await listAll(f, f.token)).find((r) => r.key === key);
  expect(listed).toMatchObject({
    value: 'maintenance',
    version: 1,
    updated_by: caller.account.username,
  });
});

it('[AC-F1-10d#19] §9.2 #3 种子写入的行（当前版本没有历史行）照常改：版本 +1，只新增新版本的历史行，审计带前后值与版本', async () => {
  const f = await setup(h);
  const key = 'withdraw.enabled';
  await seedSwitch(h, f.appId, key, true, 3);
  const token = await stepUp(f, owner(f));
  const before = await snapshot(h, f.appId);
  const row = await updated(
    await put(
      f.app,
      owner(f),
      key,
      { value: false, expected_version: 3, reason: '打款通道异常，暂停提现' },
      token,
    ),
  );
  const at = f.clock.now();
  expect(row).toMatchObject({ key, value: false, default: true, version: 4 });
  expect(row.updated_by).toBe(f.actor.username);
  expect(await item(h, f.appId, key)).toMatchObject({
    value: false,
    version: 4,
    updated_by: f.actor.username,
    updated_at: at,
  });
  const history = await historyOf(h, f.appId, key);
  expect(history.map((r) => r.version)).toEqual([4]);
  expect(history[0]).toMatchObject({
    value: false,
    updated_by: f.actor.username,
    updated_by_admin_id: f.actor.id,
    reason: '打款通道异常，暂停提现',
    created_at: at,
  });
  const audit = await auditAdded(h, f, before, f.actor, at);
  expectAuditFacts(audit, {
    key,
    from: 3,
    to: 4,
    before: true,
    after: false,
    reason: '打款通道异常，暂停提现',
  });
  const after = await snapshot(h, f.appId);
  expect(after.items.filter((r) => r.key !== key)).toEqual(
    before.items.filter((r) => r.key !== key),
  );
});

it('[AC-F1-10d#20] §9.2 #3 连续改动：版本逐次 +1 永不回退，每次一条历史一条审计，reason 可省（历史为 null），已有历史行时照常追加', async () => {
  const f = await setup(h);
  const key = 'payout.channel_enabled.alipay';
  await seedSwitch(h, f.appId, key, true, 2);
  await seedHistory(h, f.appId, key, 1, false);
  await seedHistory(h, f.appId, key, 2, true);
  let value: boolean = true;
  for (let version = 2; version < 6; version += 1) {
    const token = await stepUp(f, owner(f));
    const before = await snapshot(h, f.appId);
    const next: boolean = !value;
    const body: Record<string, unknown> = { value: next, expected_version: version };
    if (version % 2 === 0) body.reason = `step ${version}`;
    const row = await updated(await put(f.app, owner(f), key, body, token));
    expect(row).toMatchObject({ value: next, version: version + 1 });
    const audit = await auditAdded(h, f, before, f.actor, f.clock.now());
    expectAuditFacts(audit, {
      key,
      from: version,
      to: version + 1,
      before: value,
      after: next,
      reason: version % 2 === 0 ? `step ${version}` : null,
    });
    value = next;
  }
  const history = await historyOf(h, f.appId, key);
  expect(history.map((r) => [r.version, r.value, r.reason])).toEqual([
    [1, false, null],
    [2, true, null],
    [3, false, 'step 2'],
    [4, true, null],
    [5, false, 'step 4'],
    [6, true, null],
  ]);
  expect(await item(h, f.appId, key)).toMatchObject({ value: true, version: 6 });
});

it.each([
  ['已有行（版本 3）', true],
  ['无行（首次写入）', false],
] as const)(
  '[AC-F1-10d#21] §9.3 并发：%s 两个同 expected_version 的改动确定性交错，只成一个，另一个 20902；只一条历史、一条审计、一条告警',
  async (_label, existing) => {
    const f = await setup(h);
    const key = 'withdraw.enabled';
    if (existing) await seedSwitch(h, f.appId, key, true, 3);
    const version = existing ? 3 : 0;
    const a = await member(h, f, ['switch.payout']);
    const b = await member(h, f, ['switch.all']);
    const tokenA = await stepUp(f, a);
    const tokenB = await stepUp(f, b);
    const before = await snapshot(h, f.appId);
    const mark = f.lines.length;
    const race = await orderedRace(
      h,
      f,
      key,
      {
        caller: a,
        stepUpToken: tokenA,
        body: { value: false, expected_version: version, reason: 'first' },
      },
      {
        caller: b,
        stepUpToken: tokenB,
        body: { value: false, expected_version: version, reason: 'second' },
      },
      existing,
    );
    // The second request committed while the first was stopped: the first must lose.
    expect(await updated(race.second)).toMatchObject({ value: false, version: version + 1 });
    await conflict(race.first);
    expect(await item(h, f.appId, key)).toMatchObject({
      value: false,
      version: version + 1,
      updated_by: b.account.username,
    });
    const history = await historyOf(h, f.appId, key);
    expect(history.map((r) => [r.version, r.reason, r.updated_by_admin_id])).toEqual([
      [version + 1, 'second', b.account.id],
    ]);
    const after = await snapshot(h, f.appId);
    const ids = new Set(before.audits.map((r) => r.id));
    const added = after.audits.filter((r) => !ids.has(r.id) && r.action === ACTION);
    expect(added.map((r) => r.admin_id)).toEqual([b.account.id]);
    expect(alertLines(f.lines, mark)).toHaveLength(1);
    // The loser's token was not consumed by its 20902.
    expect(
      await updated(
        await put(f.app, a, key, { value: true, expected_version: version + 1 }, tokenA),
      ),
    ).toMatchObject({ value: true, version: version + 2 });
  },
);

it('[AC-F1-10d#22] §9.2 #3 行、历史、审计同一事务：审计写入失败时整次回滚（行不变、无历史、无告警），令牌未核销仍可重试成功', async () => {
  const f = await setup(h);
  const key = 'pay.enabled';
  await seedSwitch(h, f.appId, key, true, 2);
  const token = await stepUp(f, owner(f));
  const db = h.db.withPlugin({
    transformQuery(args) {
      const text = JSON.stringify(args.node);
      if (
        args.node.kind === 'InsertQueryNode' &&
        /audit_logs/.test(text) &&
        text.includes(ACTION)
      ) {
        throw new Error('f1-10d: audit insert refused by the rule test');
      }
      if (args.node.kind === 'RawNode' && /audit_logs/i.test(text) && text.includes(ACTION)) {
        throw new Error('f1-10d: audit insert refused by the rule test');
      }
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const app = await (
    await factory()
  )('admin', { ...f.overrides, dbHandles: { db, dbRead: null, close: async () => undefined } });
  h.apps.push(app);
  await app.init();
  const before = await snapshot(h, f.appId);
  const mark = f.lines.length;
  const sent = await put(app, owner(f), key, { value: false, expected_version: 2 }, token);
  expect(sent.response.statusCode).toBeGreaterThanOrEqual(400);
  expect(sent.response.json()).not.toMatchObject({ code: 0 });
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(alertLines(f.lines, mark)).toEqual([]);
  expect(
    await updated(await put(f.app, owner(f), key, { value: false, expected_version: 2 }, token)),
  ).toMatchObject({ value: false, version: 3 });
  expect((await historyOf(h, f.appId, key)).map((r) => r.version)).toEqual([3]);
});

it('[AC-F1-10d#23] §9.2 #3 历史行写不进（新版本号已被占用）时整次失败：行与审计不变、无告警', async () => {
  const f = await setup(h);
  const key = 'growth.invite_bind.enabled';
  await seedSwitch(h, f.appId, key, true, 3);
  await seedHistory(h, f.appId, key, 4, true);
  const token = await stepUp(f, owner(f));
  const before = await snapshot(h, f.appId);
  const mark = f.lines.length;
  const sent = await put(f.app, owner(f), key, { value: false, expected_version: 3 }, token);
  expect(sent.response.statusCode).toBeGreaterThanOrEqual(400);
  expect(sent.response.json()).not.toMatchObject({ code: 0 });
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(alertLines(f.lines, mark)).toEqual([]);
});

it.each([
  ['withdraw.enabled', 'switch.payout', [false]],
  // BR-INV-21: turning the invite binding off and on again both alert.
  ['growth.invite_bind.enabled', 'switch.all', [false, true]],
  ['pay.enabled', 'switch.pay', [false, true]],
  ['claims.enabled', 'switch.all', [false]],
  ['parse.tpwd.enabled', 'switch.all', [false, true]],
] as const)(
  '[AC-F1-10d#24] §9.2 #4 / BR-INV-21 %s（持 %s）每次成功改动恰打一条 warn 级 config_change_alert：带键、前后值、操作者与 trace，不含其他配置值；被拒与同值空操作不打',
  async (key, point, steps) => {
    const f = await setup(h);
    await seedSwitch(h, f.appId, key, true, 1);
    await seedSwitch(h, f.appId, 'config.invite.backfill_hours', 'sentinel-other-config-value', 1);
    await seedSwitch(h, f.appId, 'agent.enabled', 'sentinel-other-switch-value', 1);
    const caller = await member(h, f, [point]);
    let token = await stepUp(f, caller);
    let mark = f.lines.length;
    await rejected(
      await put(f.app, caller, key, { value: 'off', expected_version: 1 }, token),
      'update',
      20001,
      { fields: ['value'] },
    );
    await conflict(await put(f.app, caller, key, { value: false, expected_version: 7 }, token));
    await rejected(
      await put(f.app, caller, key, { value: false, expected_version: 1 }, null),
      'update',
      10003,
      { tier: 'totp' },
    );
    expect(alertLines(f.lines, mark)).toEqual([]);
    let current: boolean = true;
    let version = 1;
    for (const [index, next] of steps.entries()) {
      if (index > 0) token = await stepUp(f, caller);
      mark = f.lines.length;
      const trace = randomUUID();
      expect(
        await updated(
          await put(f.app, caller, key, { value: next, expected_version: version }, token, trace),
        ),
      ).toMatchObject({ key, value: next, version: version + 1 });
      const alerts = alertLines(f.lines, mark);
      expect(alerts).toHaveLength(1);
      expectAlert(alerts[0]!, { key, from: current, to: next, trace, actor: caller.account });
      const text = JSON.stringify(alerts[0]);
      expect(text).not.toContain('sentinel-other-config-value');
      expect(text).not.toContain('sentinel-other-switch-value');
      expect(text).not.toContain(token);
      current = next;
      version += 1;
    }
    // Refused changes and a same-value no-op (ruling 13) after the changes stay silent.
    token = await stepUp(f, caller);
    mark = f.lines.length;
    await conflict(
      await put(f.app, caller, key, { value: !current, expected_version: version - 1 }, token),
    );
    await rejected(
      await put(f.app, caller, key, { value: 1, expected_version: version }, token),
      'update',
      20001,
      { fields: ['value'] },
    );
    expect(
      await updated(
        await put(f.app, caller, key, { value: current, expected_version: version }, token),
      ),
    ).toMatchObject({ key, value: current, version });
    expect(alertLines(f.lines, mark)).toEqual([]);
  },
);

it.each([
  ['withdraw.enabled', true, false],
  ['growth.invite_bind.enabled', true, false],
  ['convert.off_reason.jd', 'not_launched', 'maintenance'],
] as const)(
  '[AC-F1-10d#25] §9.2 #5 10 秒内生效：读取方（content 的缓存读取器）先读到旧值，%s 改后推进注入时钟 10 秒内读到新值与版本，别的 app 不受影响',
  async (key, oldValue, newValue) => {
    const f = await setup(h);
    const otherApp = `f1-10d-reader-${randomUUID()}`;
    await seedSwitch(h, f.appId, key, oldValue, 5);
    await seedSwitch(h, otherApp, key, oldValue, 5);
    const token = await stepUp(f, owner(f));
    const reader = createContentReader({ db: h.db, clock: f.clock });
    expect(await reader.configValue(f.appId, key)).toStrictEqual({ value: oldValue, version: 5 });
    expect(await reader.configValue(otherApp, key)).toStrictEqual({ value: oldValue, version: 5 });
    await updated(await put(f.app, owner(f), key, { value: newValue, expected_version: 5 }, token));
    f.clock.advanceMs(SWITCH_EFFECTIVE_MS);
    expect(await reader.configValue(f.appId, key)).toStrictEqual({ value: newValue, version: 6 });
    expect(await reader.configValue(otherApp, key)).toStrictEqual({ value: oldValue, version: 5 });
  },
);

it('[AC-F1-10d#33] §9.2 #5 首次写入的开关同样 10 秒内被读取方看到（之前读到无行）', async () => {
  const f = await setup(h);
  const key = 'payout.channel_paused.wechat';
  const token = await stepUp(f, owner(f));
  const reader = createContentReader({ db: h.db, clock: f.clock });
  expect(await reader.configValue(f.appId, key)).toBeNull();
  await updated(await put(f.app, owner(f), key, { value: true, expected_version: 0 }, token));
  f.clock.advanceMs(SWITCH_EFFECTIVE_MS);
  expect(await reader.configValue(f.appId, key)).toStrictEqual({ value: true, version: 1 });
});

it('[AC-F1-10d#32] 裁定 13：同值写入（版本匹配）是空操作——200 返回当前状态，version、行、历史、审计都不变，无告警；缺令牌仍 10003', async () => {
  const f = await setup(h);
  const key = 'withdraw.enabled';
  await seedSwitch(h, f.appId, key, false, 3);
  await seedHistory(h, f.appId, key, 3, false);
  const before = await snapshot(h, f.appId);
  const mark = f.lines.length;
  await rejected(
    await put(f.app, owner(f), key, { value: false, expected_version: 3 }, null),
    'update',
    10003,
    { tier: 'totp' },
  );
  const token = await stepUp(f, owner(f));
  const row = await updated(
    await put(f.app, owner(f), key, { value: false, expected_version: 3 }, token),
  );
  expect(row).toMatchObject({ key, value: false, default: true, version: 3 });
  expect(instant(row.updated_at)).toBe(
    before.items.find((r) => r.key === key)!.updated_at.toISOString(),
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(alertLines(f.lines, mark)).toEqual([]);
  const listed = (await listAll(f, f.token)).find((r) => r.key === key);
  expect(listed).toMatchObject({ value: false, version: 3 });
});

it('[AC-F1-10d#34] 裁定 13 边界：从未写过的开关（无行、version 0）首次写入等于默认值的值也是改动——版本 1，一条历史、一条审计、一条告警', async () => {
  const f = await setup(h);
  const key = 'withdraw.enabled';
  const token = await stepUp(f, owner(f));
  const before = await snapshot(h, f.appId);
  const mark = f.lines.length;
  const row = await updated(
    await put(f.app, owner(f), key, { value: true, expected_version: 0 }, token),
  );
  expect(row).toMatchObject({ key, value: true, default: true, version: 1 });
  expect((await historyOf(h, f.appId, key)).map((r) => [r.version, r.value])).toEqual([[1, true]]);
  const audit = await auditAdded(h, f, before, f.actor, f.clock.now());
  expectAuditFacts(audit, { key, from: 0, to: 1, after: true, reason: null });
  expect(alertLines(f.lines, mark)).toHaveLength(1);
});
