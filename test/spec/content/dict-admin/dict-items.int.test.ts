// F1-02t §9.3: one top-level test per acceptance point; only the container runner executes it.
import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import {
  KEYS,
  ROOT,
  ROUTES,
  contract,
  defaultsWithAdmin,
  harness,
  member,
  rejected,
  seedItem,
  seedVersion,
  send,
  setup,
  snapshot,
  stepUp,
  success,
  type Harness,
  type HistoryPage,
  type ItemPage,
  type Saved,
  type Setup,
} from './kit.ts';

let database: Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>>;
let redis: Awaited<ReturnType<(typeof import('@couli/db/testing'))['acquireTestRedis']>>;
let db: ReturnType<typeof createDb>;
let h: Harness;
beforeAll(async () => {
  const testing = await import('@couli/db/testing');
  database = await testing.createTestDatabase();
  redis = await testing.acquireTestRedis();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  h = await harness(db, database.urlFor('couli_app'), redis.url);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
});

const change = (key: string, text: string | null) => ({ key, text });
const save = (f: Setup, expected: string, changes: ReturnType<typeof change>[], extra = {}) => {
  h.clock.advanceMs(1000);
  return send(f, 'save', { changes, expected_version: expected, ...extra });
};
type Audit = Awaited<ReturnType<typeof snapshot>>['audits'][number];
function auditValues(
  audit: Audit,
  beforeVersion: string,
  afterVersion: string,
  before: ReturnType<typeof change>[],
  after: ReturnType<typeof change>[],
) {
  expect(audit.before).toMatchObject({ dict_version: beforeVersion });
  expect(audit.after).toMatchObject({ dict_version: afterVersion });
  // §9.2 fixes the contents but does not name the array property.
  expect(Object.values(audit.before as object)).toContainEqual(before);
  expect(Object.values(audit.after as object)).toContainEqual(after);
}

it('[AC-F1-02t#1] general 首存即发布：整数串版本、拆键、历史、时钟和审计一致，四路由解除 planned', async () => {
  const f = await setup(h);
  expect(success<ItemPage>(await send(f, 'list')).dict_version).toBe('0');
  const changes = [change(KEYS.general, '诊断入口甲'), change(KEYS.second, '复制完成甲')];
  expect(success<Saved>(await save(f, '0', changes, { legal_confirmed_by: '测试确认人' }))).toEqual(
    { version: '1', keys: changes.map((x) => x.key) },
  );
  const state = await snapshot(h, f.appId);
  expect(state.items.map((x) => [x.dict, x.code, x.version, x.text, x.created_by])).toEqual([
    ['about', 'copy_diagnostics', 1, '诊断入口甲', f.actor.id],
    ['about', 'copy_diagnostics.done', 1, '复制完成甲', f.actor.id],
  ]);
  expect(state.items.every((x) => x.created_at.toISOString() === h.clock.now().toISOString())).toBe(
    true,
  );
  expect(state.config).toHaveLength(1);
  expect(state.config[0]).toMatchObject({ value: '1', version: 1, updated_by: f.actor.loginName });
  expect(state.config[0]!.updated_at.toISOString()).toBe(h.clock.now().toISOString());
  expect(state.versions).toHaveLength(1);
  expect(state.versions[0]).toMatchObject({
    value: '1',
    version: 1,
    updated_by: f.actor.loginName,
  });
  expect(state.versions[0]!.created_at.toISOString()).toBe(h.clock.now().toISOString());
  expect(state.audits).toHaveLength(1);
  expect(state.audits[0]).toMatchObject({
    action: 'dict_items_save',
    admin_id: f.actor.id,
    after: { fund_terms: false, legal_confirmed_by: '测试确认人' },
  });
  expect(state.audits[0]!.at.toISOString()).toBe(h.clock.now().toISOString());
  auditValues(
    state.audits[0]!,
    '0',
    '1',
    changes.map((x) => change(x.key, null)),
    changes,
  );
  const page = success<ItemPage>(await send(f, 'list', undefined, { query: '?key_prefix=about.' }));
  expect(page.dict_version).toBe('1');
  expect(page.items.map((x) => [x.key, x.text, x.version])).toEqual(
    changes.map((x) => [x.key, x.text, 1]),
  );
  h.fault.audit = true;
  try {
    rejected(await save(f, '1', [change(KEYS.general, '审计失败时不得发布')]), 50001);
  } finally {
    h.fault.audit = false;
  }
  expect(await snapshot(h, f.appId)).toEqual(state);
  const doc = await contract();
  for (const route of Object.values(ROUTES)) {
    expect(doc.paths[route.path]![route.method.toLowerCase()]!['x-implementation']).not.toBe(
      'planned',
    );
  }
});

it('[AC-F1-02t#2] 混类和空集合在选权限点前整批拒绝，保存与回滚均无业务行和审计', async () => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  for (const keys of [[KEYS.general, KEYS.fund], [KEYS.fund, KEYS.general], []]) {
    rejected(
      await save(
        f,
        '0',
        keys.map((key) => change(key, '测试文案')),
      ),
      20001,
      { fields: ['changes'] },
    );
    rejected(await send(f, 'rollback', { keys, to_version: 0, expected_version: '0' }), 20001, {
      fields: ['keys'],
    });
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02t#3] 资金与未知键选资金权限：拒绝留键级审计，totp 每次必需且成功记录前后值', async () => {
  const f = await setup(h);
  const fund = await member(h, f.appId, ['content.fund_terms']);
  for (const op of ['save', 'rollback'] as const) {
    for (const key of [KEYS.fund, KEYS.unknown]) {
      const body =
        op === 'save'
          ? { changes: [change(key, '资金文案甲')], expected_version: '0' }
          : { keys: [key], to_version: 0, expected_version: '0' };
      for (const [actor, code] of [
        [f.actor, 10403],
        [fund, 10003],
      ] as const) {
        const before = await snapshot(h, f.appId);
        rejected(
          await send(f, op, body, { token: actor.token }),
          code,
          code === 10403 ? { reason: 'admin_permission_denied' } : { tier: 'totp' },
        );
        const after = await snapshot(h, f.appId);
        expect({ ...after, audits: before.audits }).toEqual(before);
        expect(after.audits).toHaveLength(before.audits.length + 1);
        const audit = after.audits.at(-1)!;
        expect(audit).toMatchObject({
          action: 'dict_items_denied',
          admin_id: actor.id,
          after: { keys: [key] },
        });
        expect(Object.values(audit.after as object)).toContain(code);
      }
    }
  }
  const token = await stepUp(h, fund);
  const body = { changes: [change(KEYS.fund, '资金文案甲')], expected_version: '0' };
  expect(success<Saved>(await send(f, 'save', body, { token: fund.token, stepUp: token }))).toEqual(
    { version: '1', keys: [KEYS.fund] },
  );
  const state = await snapshot(h, f.appId);
  const audit = state.audits.at(-1)!;
  expect(audit).toMatchObject({
    action: 'dict_items_save',
    admin_id: fund.id,
    after: { fund_terms: true },
  });
  auditValues(audit, '0', '1', [change(KEYS.fund, null)], body.changes);
  rejected(
    await send(
      f,
      'save',
      { changes: [change(KEYS.fund, '资金文案乙')], expected_version: '1' },
      { token: fund.token, stepUp: token },
    ),
    10003,
    { tier: 'totp' },
  );
  rejected(
    await send(
      f,
      'rollback',
      { keys: [KEYS.fund], to_version: 0, expected_version: '1' },
      { token: fund.token, stepUp: await stepUp(h, fund, 'sms') },
    ),
    10003,
    { tier: 'totp' },
  );
  expect((await snapshot(h, f.appId)).items).toEqual(state.items);
  expect(
    success<Saved>(
      await send(
        f,
        'rollback',
        { keys: [KEYS.fund], to_version: 0, expected_version: '1' },
        { token: fund.token, stepUp: await stepUp(h, fund) },
      ),
    ),
  ).toEqual({ version: '2', keys: [KEYS.fund] });
});

it('[AC-F1-02t#4] privacy/perm 使用 agreement 权限和 totp，保存与回滚都要求法务确认人', async () => {
  const f = await setup(h);
  const actor = await member(h, f.appId, ['content.agreement']);
  const keys = [KEYS.agreement, 'perm.btn.continue'];
  const body = { changes: keys.map((key) => change(key, '确认甲')), expected_version: '0' };
  rejected(await send(f, 'save', body), 10403, { reason: 'admin_permission_denied' });
  rejected(await send(f, 'save', body, { token: actor.token }), 10003, { tier: 'totp' });
  const before = await snapshot(h, f.appId);
  rejected(
    await send(f, 'save', body, { token: actor.token, stepUp: await stepUp(h, actor) }),
    20001,
    { fields: ['legal_confirmed_by'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(
    success<Saved>(
      await send(
        f,
        'save',
        { ...body, legal_confirmed_by: '测试法务甲' },
        { token: actor.token, stepUp: await stepUp(h, actor) },
      ),
    ),
  ).toEqual({ version: '1', keys });
  const saved = await snapshot(h, f.appId);
  expect(saved.audits.at(-1)).toMatchObject({
    after: { legal_confirmed_by: '测试法务甲', fund_terms: false },
  });
  const rollback = { keys, to_version: 0, expected_version: '1' };
  rejected(
    await send(f, 'rollback', rollback, { token: actor.token, stepUp: await stepUp(h, actor) }),
    20001,
    { fields: ['legal_confirmed_by'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(saved);
  expect(
    success<Saved>(
      await send(
        f,
        'rollback',
        { ...rollback, legal_confirmed_by: '测试法务乙' },
        { token: actor.token, stepUp: await stepUp(h, actor) },
      ),
    ),
  ).toEqual({ version: '2', keys });
  expect((await snapshot(h, f.appId)).audits.at(-1)).toMatchObject({
    action: 'dict_items_rollback',
    after: { legal_confirmed_by: '测试法务乙', to_version: 0 },
  });
});

it('[AC-F1-02t#5] 每项校验一次全报：同值/null、重复、未知、变量及禁用词带准确索引，无部分保存', async () => {
  const f = await setup(h);
  success<Saved>(await save(f, '0', [change(KEYS.general, '当前文案')]));
  const before = await snapshot(h, f.appId);
  const changes = [
    change('auth_manage.title', '可以保存的文案'),
    change(KEYS.general, '当前文案'),
    change(KEYS.second, null),
    change(KEYS.variable, '全\u200b网最低{wrong}'),
    change('app_update.retry', '再次打开'),
    change('app_update.retry', '再试一次'),
  ];
  rejected(await save(f, '1', changes), 20001, {
    fields: ['changes[1].key', 'changes[2].key', 'changes[3].text', '全网最低', 'changes[5].key'],
  });
  expect(await snapshot(h, f.appId)).toEqual(before);
  const fund = await member(h, f.appId, ['content.fund_terms']);
  rejected(
    await send(
      f,
      'save',
      {
        changes: [change(KEYS.fund, '可用资金文案'), change(KEYS.unknown, '未知')],
        expected_version: '1',
      },
      { token: fund.token, stepUp: await stepUp(h, fund) },
    ),
    20001,
    { fields: ['changes[1].key'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  // Valid variables, and restoring null after a non-null override, must remain writable.
  expect(
    success<Saved>(
      await save(f, '1', [change(KEYS.variable, '规格：{spec}'), change(KEYS.general, null)]),
    ),
  ).toEqual({ version: '2', keys: [KEYS.variable, KEYS.general] });
});

it('[AC-F1-02t#6] 先校验再 CAS，字符串全等；首发与已有行并发恰一成功，非整数当前版本拒绝', async () => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  rejected(await save(f, '9', [change(KEYS.variable, '缺变量')]), 20001, {
    fields: ['changes[0].text'],
  });
  rejected(await save(f, '00', [change(KEYS.general, '文案甲')]), 20902, { resource: 'dict_item' });
  expect(await snapshot(h, f.appId)).toEqual(before);
  for (const expected of ['0', '1']) {
    const old = await snapshot(h, f.appId);
    h.clock.advanceMs(1000);
    const responses = await Promise.all(
      ['并发甲', '并发乙'].map((text) =>
        send(f, 'save', {
          changes: [change(KEYS.general, `${text}${expected}`)],
          expected_version: expected,
        }),
      ),
    );
    expect(responses.map((x) => x.json().code).sort((a, b) => a - b)).toEqual([0, 20902]);
    const winner = responses.findIndex((x) => x.json().code === 0);
    expect(success<Saved>(responses[winner]!)).toEqual({
      version: String(Number(expected) + 1),
      keys: [KEYS.general],
    });
    rejected(responses[1 - winner]!, 20902, { resource: 'dict_item' });
    const next = await snapshot(h, f.appId);
    expect(next.items).toHaveLength(old.items.length + 1);
    expect(next.items.at(-1)!.text).toBe(`${winner === 0 ? '并发甲' : '并发乙'}${expected}`);
    expect(next.items.map((x) => x.version)).toEqual(expected === '0' ? [1] : [1, 2]);
    expect(next.config[0]!.value).toBe(String(Number(expected) + 1));
    expect(next.versions).toHaveLength(old.versions.length + 1);
    expect(next.audits).toHaveLength(old.audits.length + 1);
    if (old.config.length > 0) {
      expect(next.config[0]!.version).toBe(old.config[0]!.version + 1);
      expect(next.config[0]!.row_version).toBe(old.config[0]!.row_version + 1);
    }
  }
  const invalid = await setup(h);
  await seedVersion(h, invalid.appId, 'dict-42');
  const unchanged = await snapshot(h, invalid.appId);
  rejected(await save(invalid, 'dict-42', [change(KEYS.general, '文案甲')]), 50001);
  expect(await snapshot(h, invalid.appId)).toEqual(unchanged);
});

it('[AC-F1-02t#7] 回滚追加新版本不改历史，0/无历史恢复 null，旧文案重过校验并先于 CAS', async () => {
  const f = await setup(h);
  success<Saved>(await save(f, '0', [change(KEYS.general, '文案甲')]));
  success<Saved>(
    await save(f, '1', [change(KEYS.general, '文案乙'), change(KEYS.second, '第二键')]),
  );
  const v2 = await snapshot(h, f.appId);
  h.clock.advanceMs(1000);
  expect(
    success<Saved>(
      await send(f, 'rollback', {
        keys: [KEYS.general, KEYS.second],
        to_version: 1,
        expected_version: '2',
      }),
    ),
  ).toEqual({ version: '3', keys: [KEYS.general, KEYS.second] });
  const v3 = await snapshot(h, f.appId);
  expect(v3.items.slice(0, v2.items.length)).toEqual(v2.items);
  expect(v3.items.slice(v2.items.length).map((x) => [x.text, x.version])).toEqual([
    ['文案甲', 3],
    [null, 3],
  ]);
  expect(v3.config[0]!.value).toBe('3');
  expect(v3.config[0]!.version).toBe(v2.config[0]!.version + 1);
  expect(v3.config[0]!.row_version).toBe(v2.config[0]!.row_version + 1);
  expect(v3.versions.map((x) => x.value)).toEqual(['1', '2', '3']);
  expect(v3.audits.at(-1)).toMatchObject({
    action: 'dict_items_rollback',
    admin_id: f.actor.id,
    after: { to_version: 1, fund_terms: false },
  });
  auditValues(
    v3.audits.at(-1)!,
    '2',
    '3',
    [change(KEYS.general, '文案乙'), change(KEYS.second, '第二键')],
    [change(KEYS.general, '文案甲'), change(KEYS.second, null)],
  );
  for (const to_version of [3, 4]) {
    rejected(
      await send(f, 'rollback', { keys: [KEYS.general], to_version, expected_version: 'wrong' }),
      20001,
      { fields: ['to_version'] },
    );
  }
  rejected(
    await send(f, 'rollback', {
      keys: [KEYS.general, KEYS.general],
      to_version: 1,
      expected_version: '3',
    }),
    20001,
    { fields: ['keys[1]'] },
  );
  rejected(
    await send(f, 'rollback', { keys: [KEYS.general], to_version: 1, expected_version: '2' }),
    20902,
    { resource: 'dict_item' },
  );
  expect(await snapshot(h, f.appId)).toEqual(v3);
  h.clock.advanceMs(1000);
  success<Saved>(
    await send(f, 'rollback', {
      keys: [KEYS.general, KEYS.second],
      to_version: 0,
      expected_version: '3',
    }),
  );
  const v4 = await snapshot(h, f.appId);
  expect(v4.items.slice(-2).map((x) => [x.text, x.version])).toEqual([
    [null, 4],
    [null, 4],
  ]);
  expect(v4.items.slice(0, v3.items.length)).toEqual(v3.items);
  // Historical bad text was possible before a rule update; never rewrite it to make rollback pass.
  const stale = await setup(h);
  await seedVersion(h, stale.appId, '2', 2);
  await seedItem(h, stale, KEYS.general, 1, '全网最低');
  await seedItem(h, stale, KEYS.general, 2, '当前正常');
  await seedItem(h, stale, KEYS.variable, 1, '旧文缺变量');
  const old = await snapshot(h, stale.appId);
  rejected(
    await send(stale, 'rollback', {
      keys: [KEYS.second, KEYS.general, KEYS.variable],
      to_version: 1,
      expected_version: 'wrong',
    }),
    20001,
    { fields: ['keys[1]', '全网最低', 'keys[2]'] },
  );
  expect(await snapshot(h, stale.appId)).toEqual(old);
  const fund = await member(h, stale.appId, ['content.fund_terms']);
  rejected(
    await send(
      stale,
      'rollback',
      { keys: [KEYS.unknown], to_version: 1, expected_version: '2' },
      { token: fund.token, stepUp: await stepUp(h, fund) },
    ),
    20001,
    { fields: ['keys[0]'] },
  );
  expect(await snapshot(h, stale.appId)).toEqual(old);
});

it('[AC-F1-02t#8] 列表按默认全集/类别/前缀分页且只取已发布值；历史降序精确键过滤，读任一权限无 step-up', async () => {
  const f = await setup(h);
  const other = await setup(h);
  await seedVersion(h, f.appId, '2', 2);
  await seedItem(h, f, KEYS.general, 1, '第一版');
  await seedItem(h, f, KEYS.general, 2, null);
  await seedItem(h, f, KEYS.second, 2, '第二键');
  await seedItem(h, f, KEYS.general, 3, '未发布');
  await seedVersion(h, other.appId, '8', 8);
  await seedItem(h, other, KEYS.general, 8, '其他应用');
  // F1-02zh (test-change): F1-02zd (#953) widened dict-items to the union of texts.default.json
  // and texts.admin.default.json; F1-02zg's transitional choice between the two key sets ends here.
  const texts = defaultsWithAdmin();
  const keys = Object.keys(texts).sort();
  const spec = parseYamlLite(readFileSync(new URL('specs/fund-term-keys.yaml', ROOT), 'utf8')) as {
    fund_terms: { prefixes: string[]; keys: string[] };
    ordinary: { prefixes: string[]; keys: string[] };
  };
  // Independent expected classification from the specification, not the implementation helper.
  const classOf = (key: string) => {
    const covers = (segment: typeof spec.ordinary) =>
      segment.keys.includes(key) || segment.prefixes.some((p) => key.startsWith(p));
    return covers(spec.fund_terms) || !covers(spec.ordinary)
      ? 'fund_terms'
      : /^(privacy|perm)\./.test(key)
        ? 'agreement'
        : 'general';
  };
  const expected = keys.map((key) => ({
    key,
    class: classOf(key),
    default_text: texts[key],
    text: key === KEYS.second ? '第二键' : null,
    version: key === KEYS.general || key === KEYS.second ? 2 : null,
  }));
  const all: ItemPage['items'] = [];
  for (let page = 1; all.length < keys.length; page++) {
    const data = success<ItemPage>(
      await send(f, 'list', undefined, { query: `?page=${page}&page_size=200` }),
    );
    expect(data).toMatchObject({ page, page_size: 200, total: keys.length, dict_version: '2' });
    expect(data.items.length).toBeGreaterThan(0);
    all.push(...data.items);
  }
  expect(all).toEqual(expected);
  for (const [permission, category] of [
    ['config.general', 'general'],
    ['content.fund_terms', 'fund_terms'],
    ['content.agreement', 'agreement'],
  ] as const) {
    const actor = await member(h, f.appId, [permission]);
    const data = success<ItemPage>(
      await send(f, 'list', undefined, {
        token: actor.token,
        query: `?class=${category}&page_size=2&page=2`,
      }),
    );
    const filtered = expected.filter((x) => x.class === category);
    expect(data.total).toBe(filtered.length);
    expect(data.items).toEqual(filtered.slice(2, 4));
    const history = success<HistoryPage>(
      await send(f, 'history', undefined, { token: actor.token, query: '?page_size=200' }),
    );
    expect(history.total).toBe(4);
    expect(history.items.map((x) => [x.version, x.key, x.text])).toEqual([
      [3, KEYS.general, '未发布'],
      [2, KEYS.general, null],
      [2, KEYS.second, '第二键'],
      [1, KEYS.general, '第一版'],
    ]);
    expect(history.items.every((x) => x.created_by === f.actor.id && x.created_at.length > 0)).toBe(
      true,
    );
  }
  const prefix = success<ItemPage>(
    await send(f, 'list', undefined, {
      query: '?class=general&key_prefix=about.copy_diagnostics&page_size=1&page=2',
    }),
  );
  expect(prefix.total).toBe(2);
  expect(prefix.items).toEqual(expected.filter((x) => x.key === KEYS.second));
  const history = success<HistoryPage>(
    await send(f, 'history', undefined, { query: `?key=${KEYS.general}&page_size=2&page=2` }),
  );
  expect(history.total).toBe(3);
  expect(history.items.map((x) => [x.key, x.version])).toEqual([[KEYS.general, 1]]);
  const denied = await member(h, f.appId, []);
  for (const op of ['list', 'history'] as const) {
    rejected(await send(f, op, undefined, { token: denied.token }), 10403, {
      reason: 'admin_permission_denied',
    });
  }
});
