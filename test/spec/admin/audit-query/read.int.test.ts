import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { fixture, useHarness } from '../auth/kit.ts';
import {
  append,
  detail,
  expectItems,
  FROM,
  grant,
  LIST,
  page,
  rejected,
  seed,
  setup,
  signedIn,
  TO,
  url,
} from './kit.ts';

// Contract CT-24c and task §9. Real HTTP / PG / Redis, run only by the container runner.
// No substitute routes: a missing implementation must fail the HTTP status assertion.
const h = useHarness();
const WINDOW = { from: FROM, to: TO };

it('[AC-B1-34a#1] 无 view_all 时无筛选也只看本人，指定他人或不存在的 actor 得空页', async () => {
  const f = await setup(h);
  const ordinary = await seed(h, f.appId);
  await grant(h, ordinary, f.actor, ['risk.ban']);
  const session = await signedIn(f, ordinary);
  const own = { ...f, token: session.admin_token };
  await append(h, ordinary);
  await append(h, f.actor);
  const stored = await h.db
    .selectFrom('audit_logs')
    .select('id')
    .where('app_id', '=', f.appId)
    .where('admin_id', '=', ordinary.id)
    .execute();
  const unfiltered = await page(own, {});
  expect(unfiltered.total).toBe(stored.length);
  expect(unfiltered.items.length).toBe(stored.length);
  expect(unfiltered.items.every((item) => item.actor_id === ordinary.id)).toBe(true);
  expectItems(await page(own), [ordinary.id]);
  expectItems(await page(own, { ...WINDOW, actor_id: ordinary.id }), [ordinary.id]);
  for (const actor_id of [f.actor.id, randomUUID()]) {
    expect(await page(own, { ...WINDOW, actor_id })).toEqual({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
    });
  }
  // A real visible id establishes that denial concerns row visibility, not decoding.
  const all = await page(f);
  const other = all.items.find((item) => item.actor_id === f.actor.id);
  expect(other).toBeDefined();
  await rejected(await own.read(own.token, `${LIST}/${other!.id}`), ['id'], true);
  const mine = unfiltered.items[0]!;
  expect((await detail(own, mine.id)).actor_id).toBe(ordinary.id);
});

it('[AC-B1-34a#2] 勾选 view_all 可看全部且可按 actor 筛选，超管无需权限行', async () => {
  const f = await setup(h);
  const viewer = await seed(h, f.appId);
  await grant(h, viewer, f.actor, ['audit.view_all']);
  const session = await signedIn(f, viewer);
  const view = { ...f, token: session.admin_token };
  await append(h, viewer, { at: '2026-10-08T01:00:00Z' });
  await append(h, f.actor);
  const expected = [viewer.id, f.actor.id];
  expectItems(await page(view), expected);
  expectItems(await page(f), expected);
  expectItems(await page(view, { ...WINDOW, actor_id: f.actor.id }), [f.actor.id]);
  const other = (await page(view)).items[1]!;
  expect((await detail(view, other.id)).actor_id).toBe(f.actor.id);
  expect(
    await h.db
      .selectFrom('admin_permissions')
      .select('id')
      .where('app_id', '=', f.appId)
      .where('admin_id', '=', f.actor.id)
      .execute(),
  ).toEqual([]);
});

it('[AC-B1-34a#3] app 范围来自登录身份，跨 app 的计数、列表、详情都不泄露', async () => {
  const f = await setup(h);
  const foreign = await seed(h, `other-${randomUUID()}`, { isSuper: true });
  const session = await signedIn(f, foreign);
  const other = { ...f, token: session.admin_token };
  await append(h, f.actor);
  await append(h, foreign);
  expectItems(await page(f), [f.actor.id]);
  expectItems(await page(other), [foreign.id]);
  expectItems(await page(f, { ...WINDOW, actor_id: foreign.id }), []);
  const ownId = (await page(f)).items[0]!.id;
  const foreignId = (await page(other)).items[0]!.id;
  await rejected(await f.read(f.token, `${LIST}/${foreignId}`), ['id'], true);
  await rejected(await other.read(other.token, `${LIST}/${ownId}`), ['id'], true);
  const forged = {
    ...f,
    read: (...[token, path, headers, ip]: Parameters<typeof f.read>) =>
      f.read(token, path, { ...headers, 'x-app-id': foreign.appId }, ip),
  };
  expectItems(await page(forged), [f.actor.id]);
});

it('[AC-B1-34a#4] 时间倒序分页、默认 20 条、上限 200，total 不随页码改变', async () => {
  const f = await setup(h);
  const expected: string[] = [];
  // Deliberately insert in ascending time order, distinct from the requested ordering.
  for (let index = 0; index < 21; index += 1) {
    const target = randomUUID();
    expected.unshift(target);
    await append(h, f.actor, {
      action: 'user_pii_reveal',
      target,
      after: { user_id: target, field: 'phone', reason: 'fixture' },
      at: `2026-10-08T00:${String(index).padStart(2, '0')}:00Z`,
    });
  }
  const first = await page(f);
  expect(first).toMatchObject({ page: 1, page_size: 20, total: 21 });
  expect(first.items.map((item) => item.target_id)).toEqual(expected.slice(0, 20));
  const second = await page(f, { ...WINDOW, page: 2 });
  expect(second).toMatchObject({ page: 2, page_size: 20, total: 21 });
  expect(second.items.map((item) => item.target_id)).toEqual(expected.slice(20));
  const last = await page(f, { ...WINDOW, page: 22, page_size: 1 });
  expect(last).toEqual({ items: [], page: 22, page_size: 1, total: 21 });
  const one = await page(f, { ...WINDOW, page: 2, page_size: 1 });
  expect(one).toMatchObject({ page: 2, page_size: 1, total: 21 });
  expect(one.items.map((item) => item.target_id)).toEqual([expected[1]]);
  expectItems(await page(f, { ...WINDOW, page_size: 200 }), expected);
  expect(await page(f)).toEqual(first);
});

it('[AC-B1-34a#5] actor、target_type、target_id、permission 与时间筛选取交集且精确匹配', async () => {
  const f = await setup(h);
  const other = await seed(h, f.appId);
  const target = randomUUID();
  for (const actor of [f.actor, other]) {
    for (const action of ['ban', 'freeze']) {
      for (const id of [target, randomUUID()]) {
        await append(h, actor, {
          action: 'user_risk_state_change',
          target: id,
          after: { user_id: id, action, state: action === 'ban' ? 'banned' : 'frozen' },
        });
      }
    }
  }
  const query = {
    ...WINDOW,
    actor_id: other.id,
    target_type: 'user',
    target_id: target,
    permission: 'risk.ban',
  };
  const result = await page(f, query);
  expectItems(result, [target]);
  expect(result.items[0]).toMatchObject({
    actor_id: other.id,
    permission: 'risk.ban',
    target_type: 'user',
  });
  // Each independent filter has positive matches as well as near misses.
  expect((await page(f, { ...WINDOW, actor_id: other.id })).total).toBe(4);
  expect((await page(f, { ...WINDOW, target_id: target })).total).toBe(4);
  expect((await page(f, { ...WINDOW, target_type: 'user' })).total).toBe(8);
  expect((await page(f, { ...WINDOW, permission: 'risk.freeze' })).total).toBe(4);
  for (const patch of [
    { target_id: target.slice(0, -1) },
    { target_type: 'use' },
    { target_type: 'User' },
    { permission: 'config.risk' },
  ])
    expectItems(await page(f, { ...query, ...patch }), []);
});

it('[AC-B1-34a#6] from 包含、to 排除，支持带时区的同一时刻和相等的空区间', async () => {
  const f = await setup(h);
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const times = ['2026-10-07T23:59:59.999Z', FROM, '2026-10-08T23:59:59.999Z', TO];
  for (const [index, at] of times.entries()) {
    await append(h, f.actor, { action: 'user_pii_reveal', target: ids[index]!, at });
  }
  expectItems(await page(f), [ids[2]!, ids[1]!]);
  expectItems(
    await page(f, {
      from: '2026-10-08T08:00:00+08:00',
      to: '2026-10-09T08:00:00+08:00',
    }),
    [ids[2]!, ids[1]!],
  );
  expectItems(await page(f, { from: FROM, to: FROM }), []);
  // Single-sided filters remain usable; actor login occurs after all these seeded rows.
  const before = await page(f, { to: FROM });
  expectItems(before, [ids[0]!]);
  const after = await page(f, { from: TO });
  expect(after.items.some((item) => item.target_id === ids[3])).toBe(true);
  expect(after.items.every((item) => Date.parse(item.at) >= Date.parse(TO))).toBe(true);
});

it.each([
  [{ from: TO, to: FROM }, ['from', 'to']],
  [{ page_size: 201 }, ['page_size']],
  [{ page_size: 0 }, ['page_size']],
  [{ page: 0 }, ['page']],
  [{ page: '1.5' }, ['page']],
  [{ from: 'not-a-time' }, ['from']],
  [{ to: 'not-a-time' }, ['to']],
] as const)('[AC-B1-34a#7] 非法筛选 %j 返回 20001 与准确 fields', async (query, fields) => {
  const f = await setup(h);
  await rejected(await f.read(f.token, url(query)), [...fields]);
});

it('[AC-B1-34a#7] 格式合法但未知的 permission 返回 200 空页', async () => {
  const f = await setup(h);
  await append(h, f.actor);
  expect(await page(f, { ...WINDOW, permission: 'invented.permission' })).toEqual({
    items: [],
    page: 1,
    page_size: 20,
    total: 0,
  });
});

it('[AC-B1-34a#8] 登录按 admin_users 前缀推导对象，姓名取当前 display_name 并回落登录名', async () => {
  const f = await setup(h);
  await append(h, f.actor);
  // The schema permits NULL but forbids an empty string for display_name.
  for (const display_name of ['运营甲', null, '运营乙']) {
    await h.db
      .updateTable('admin_users')
      .set({ display_name })
      .where('app_id', '=', f.appId)
      .where('id', '=', f.actor.id)
      .execute();
    const result = await page(f);
    expectItems(result, [f.actor.id]);
    const item = result.items[0]!;
    expect(item).toMatchObject({
      action: 'admin.login',
      target_type: expect.any(String),
      target_id: f.actor.id,
      permission: null,
      actor_name: display_name || f.actor.username,
      ip: '192.0.2.23',
    });
    expect(item.target_type!.length).toBeGreaterThan(0);
    expect(await detail(f, item.id)).toEqual({ ...item, before: null, after: null });
    expectItems(await page(f, { ...WINDOW, target_type: item.target_type! }), [f.actor.id]);
  }
});

it.each([
  ['ban', 'risk.ban'],
  ['unban', 'risk.ban'],
  ['freeze', 'risk.freeze'],
  ['unfreeze', 'risk.freeze'],
] as const)(
  '[AC-B1-34a#9] user_risk_state_change 的 after.action=%s 映射 %s',
  async (action, permission) => {
    const f = await setup(h);
    const target = randomUUID();
    const before = { user_id: target, state: 'normal', row_version: 3 };
    const after = { user_id: target, action, reason: 'fixture', row_version: 4 };
    await append(h, f.actor, { action: 'user_risk_state_change', target, before, after });
    const item = (await page(f)).items[0]!;
    expect(item).toMatchObject({ target_type: 'user', target_id: target, permission });
    expect(item).not.toHaveProperty('before');
    expect(item).not.toHaveProperty('after');
    expect(await detail(f, item.id)).toEqual({ ...item, before, after });
    expectItems(await page(f, { ...WINDOW, permission }), [target]);
    const opposite = permission === 'risk.ban' ? 'risk.freeze' : 'risk.ban';
    expectItems(await page(f, { ...WINDOW, permission: opposite }), []);
  },
);

it('[AC-B1-34a#18] export_unmasked 由 after 的 users 资源推出 pii.reveal_phone', async () => {
  const f = await setup(h);
  const targetId = randomUUID();
  const after = { task_id: targetId, resource: 'users', reason: 'fixture', row_count: 3 };
  await append(h, f.actor, {
    action: 'export_unmasked',
    target: `export_tasks:${targetId}`,
    after,
  });
  const result = await page(f);
  expectItems(result, [targetId]);
  const item = result.items[0]!;
  expect(item).toMatchObject({
    action: 'export_unmasked',
    target_type: expect.any(String),
    permission: 'pii.reveal_phone',
  });
  expect(await detail(f, item.id)).toMatchObject({ permission: 'pii.reveal_phone', after });
  expectItems(await page(f, { ...WINDOW, permission: 'pii.reveal_phone' }), [targetId]);
  for (const permission of ['export', 'pii.reveal_identity']) {
    expectItems(await page(f, { ...WINDOW, permission }), []);
  }
});

it.each([
  ['commission.rule.draft', ''],
  ['commission.rule.trial', ''],
  ['commission.rule.publish', ''],
  ['commission.rule.revoke', ''],
  ['union.account.register', 'union_accounts:'],
  ['union.account.sync_start', 'union_accounts:'],
] as const)('[AC-B1-34a#18] %s 的 permission 为 null 且不命中权限筛选', async (action, prefix) => {
  const f = await setup(h);
  await append(h, f.actor, { action, target: `${prefix}${randomUUID()}` });
  const result = await page(f);
  expect(result.total).toBe(1);
  expect(result.items).toHaveLength(1);
  const item = result.items[0]!;
  expect(item).toMatchObject({ action, permission: null });
  expect((await detail(f, item.id)).permission).toBeNull();
  for (const permission of [
    'config.business',
    'union.account_auth',
    'union.pid',
    'audit.view_all',
  ]) {
    expectItems(await page(f, { ...WINDOW, permission }), []);
  }
});

it('[AC-B1-34a#10] config_item_change 按注册表区分三种权限，未知同前缀键不猜权限', async () => {
  const f = await setup(h);
  // Independent expectations, not computed by the production mapping or registry function.
  const cases = [
    ['external_page.nav_host_sample_bp', 'config.general'],
    ['external_page.union_host_block', 'config.risk'],
    ['withdraw.payout_account_verify_per_day', 'config.business'],
    ['external_page.unregistered_fixture', null],
  ] as const;
  for (const [key] of cases) {
    await append(h, f.actor, {
      action: 'config_item_change',
      target: key,
      before: { key, from_version: 1, value: null },
      after: { key, to_version: 2, value: true, reason: 'fixture' },
    });
  }
  const result = await page(f);
  expect(result.total).toBe(cases.length);
  for (const [key, permission] of cases) {
    const item = result.items.find((row) => row.target_id === key);
    expect(item).toMatchObject({ target_id: key, permission, target_type: expect.any(String) });
    expect((await detail(f, item!.id)).permission).toBe(permission);
    if (permission !== null) expectItems(await page(f, { ...WINDOW, permission }), [key]);
  }
});

it('[AC-B1-34a#11] 多权限 kill_switch 返回 null，不能被任一候选权限筛中', async () => {
  const f = await setup(h);
  for (const key of ['withdraw.enabled', 'pay.enabled']) {
    await append(h, f.actor, {
      action: 'kill_switch_change',
      target: key,
      before: { key, from_version: 1, value: true },
      after: { key, to_version: 2, value: false, reason: 'fixture' },
    });
  }
  const result = await page(f);
  expect(result.total).toBe(2);
  for (const item of result.items) {
    expect(item.permission).toBeNull();
    expect((await detail(f, item.id)).permission).toBeNull();
  }
  for (const permission of ['switch.all', 'switch.payout', 'switch.pay']) {
    expectItems(await page(f, { ...WINDOW, permission }), []);
  }
});

it('[AC-B1-34a#12] 无对象的旧记录推不出字段返回 null，详情原样保留任意 JSON', async () => {
  const f = await setup(h);
  const cases: [DB['audit_logs']['before'], DB['audit_logs']['after']][] = [
    [null, null],
    [false, 7],
    ['masked', ['138****0000', null]],
  ];
  for (const [before, after] of cases) {
    await append(h, f.actor, { action: 'legacy.no_object', target: null, before, after, ip: null });
  }
  const result = await page(f);
  expect(result.total).toBe(3);
  const snapshots: unknown[] = [];
  for (const item of result.items) {
    expect(item).toMatchObject({ target_type: null, target_id: null, permission: null, ip: null });
    expect(item).not.toHaveProperty('before');
    expect(item).not.toHaveProperty('after');
    const value = await detail(f, item.id);
    const { before, after, ...listed } = value;
    expect(listed).toEqual(item);
    snapshots.push([before, after]);
  }
  expect(snapshots).toEqual(
    expect.arrayContaining([
      [null, null],
      [false, 7],
      ['masked', ['138****0000', null]],
    ]),
  );
  for (const filter of [
    { target_type: 'user' },
    { target_id: 'null' },
    { permission: 'audit.view_all' },
  ]) {
    expectItems(await page(f, { ...WINDOW, ...filter }), []);
  }
});

it('[AC-B1-34a#13] 不透明 id 不露 bigint，超过安全整数的相邻主键仍不同且重建应用后稳定可读', async () => {
  const f = await setup(h);
  const internalIds = [9007199254740992n, 9007199254740993n];
  for (const id of internalIds) {
    // Explicit identity values avoid flaky substring checks against one-digit sequence numbers.
    await sql`insert into app.audit_logs
      (id, app_id, admin_id, action, target, at)
      overriding system value values
      (${id}, ${f.appId}, ${f.actor.id}, 'admin.login', ${`admin_users:${f.actor.id}`}, ${FROM})`.execute(
      h.db,
    );
  }
  const result = await page(f);
  expect(result.total).toBe(2);
  const ids = result.items.map((item) => item.id);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) {
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(id).toMatch(/^aud_/);
    const payload = Buffer.from(id.slice(4), 'base64url');
    for (const raw of internalIds) {
      expect(id).not.toContain(String(raw));
      expect(payload.toString('utf8')).not.toContain(String(raw));
      const bytes = Buffer.alloc(8);
      bytes.writeBigUInt64BE(raw);
      expect(payload.includes(bytes)).toBe(false);
      expect(payload.includes(Buffer.from(bytes).reverse())).toBe(false);
    }
    expect((await detail(f, id)).id).toBe(id);
  }
  expect((await page(f)).items.map((item) => item.id)).toEqual(ids);
  const rebuilt = await fixture(h);
  const reopened = { ...rebuilt, token: f.token };
  expect((await page(reopened)).items.map((item) => item.id)).toEqual(ids);
  for (const id of ids) expect((await detail(reopened, id)).id).toBe(id);
});

it('[AC-B1-34a#14] 篡改、非法和不存在的 id 一律 20001 [id]', async () => {
  const f = await setup(h);
  const row = await append(h, f.actor);
  const valid = (await page(f)).items[0]!.id;
  const altered = `${valid.slice(0, 4)}${valid[4] === 'A' ? 'B' : 'A'}${valid.slice(5)}`;
  for (const id of [
    altered,
    'x',
    String(row.id),
    'aud_!!!!!!!!!!!!!!!!',
    'aud_' + 'A'.repeat(61),
    'aud_' + 'A'.repeat(22),
  ]) {
    await rejected(await f.read(f.token, `${LIST}/${encodeURIComponent(id)}`), ['id'], true);
  }
  expect((await detail(f, valid)).id).toBe(valid);
});

it('[AC-B1-34a#15] 成功、空页与失败查询均不追加或改变审计记录', async () => {
  const f = await setup(h);
  await append(h, f.actor);
  const snapshot = () =>
    h.db.selectFrom('audit_logs').selectAll().where('app_id', '=', f.appId).orderBy('id').execute();
  const before = await snapshot();
  const result = await page(f);
  await detail(f, result.items[0]!.id);
  expectItems(await page(f, { ...WINDOW, actor_id: randomUUID() }), []);
  await rejected(await f.read(f.token, url({ page_size: 201 })), ['page_size']);
  await rejected(await f.read(f.token, `${LIST}/invalid`), ['id'], true);
  expect(await snapshot()).toEqual(before);
});

it('[AC-B1-34a#17] 数据密钥轮换不改变 id，独立盲索引密钥改变编码且不能读取旧 id', async () => {
  const f = await setup(h);
  await append(h, f.actor);
  expect((await page(f)).total).toBe(1);
  // All material below is newly generated test data under the disposable workspace directory.
  const base = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'b1-34a-keys-'));
  try {
    const master = randomBytes(32);
    const provider = new LocalKeyProvider(master);
    const original = await createWrappedKeyring(provider);
    const rotated = await rotateDataKey(original, provider);
    const independent = await createWrappedKeyring(provider);
    const masterFile = join(dir, 'fixture-master.hex');
    await writeFile(masterFile, master.toString('hex'), { mode: 0o600 });
    const views = [];
    for (const [index, keyring] of [original, rotated, independent].entries()) {
      const keyringFile = join(dir, `fixture-keyring-${index}.json`);
      await writeFile(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
      const next = await fixture(h, {
        env: { FIELD_MASTER_KEY_FILE: masterFile, FIELD_KEYRING_FILE: keyringFile },
      });
      views.push({ ...next, token: f.token });
    }
    const first = (await page(views[0]!)).items[0]!;
    const second = (await page(views[1]!)).items[0]!;
    expect(second.id).toBe(first.id);
    expect((await detail(views[1]!, first.id)).id).toBe(first.id);
    const third = (await page(views[2]!)).items[0]!;
    expect(third.id).not.toBe(first.id);
    await rejected(await views[2]!.read(f.token, `${LIST}/${first.id}`), ['id'], true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  ['claim_item_approve', 'claim_items', 'order.claim'],
  ['claim_item_reject', 'claim_items', 'order.claim'],
  ['export_create', 'export_tasks', 'export'],
  ['export_download', 'export_tasks', 'export'],
  ['export_retry', 'export_tasks', 'export'],
  ['export_cancel', 'export_tasks', 'export'],
] as const)(
  '[AC-B1-34a#18] 预登记 %s 的 target 前缀和权限映射',
  async (action, prefix, permission) => {
    const f = await setup(h);
    const targetId = randomUUID();
    await append(h, f.actor, { action, target: `${prefix}:${targetId}` });
    const result = await page(f);
    expectItems(result, [targetId]);
    const item = result.items[0]!;
    expect(item).toMatchObject({ action, target_type: expect.any(String), permission });
    expect((await detail(f, item.id)).permission).toBe(permission);
    expectItems(await page(f, { ...WINDOW, target_id: targetId, permission }), [targetId]);
  },
);
