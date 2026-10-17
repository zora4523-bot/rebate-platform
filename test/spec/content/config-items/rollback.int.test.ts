// F1-10e ruling 16 and adminRollbackConfigItem: POST /admin/v1/config-items/{key}/rollback —
// the value of a stored older version becomes a new version; history is never rewritten.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  FUND_FLAGS,
  KEYS,
  UNREGISTERED,
  alertsSince,
  auditsSince,
  conflict,
  current,
  expectAlerted,
  expectAudit,
  expectedOf,
  historyPage,
  keyInvalid,
  normalized,
  itemOf,
  putRow,
  putVersion,
  rejected,
  rollback,
  setup,
  snapshot,
  stepUp,
  success,
  update,
  versionsOf,
  written,
  type Item,
} from './kit.ts';

const h = useHarness();
const versionInvalid = (response: Awaited<ReturnType<typeof rollback>>) =>
  rejected(response, 'rollback', 20001, { fields: ['to_version'] });

it.each([1, 2])(
  '[AC-F1-10e#45] 回滚到 v%i：以其值写新版本 4（当前 3 加 1），历史 1～3 不变，审计 config_item_rollback 并告警',
  async (to) => {
    const f = await setup(h);
    await written(h, f.appId, KEYS.general, [3, 6, 9], f.actor);
    const old = await versionsOf(h, f.appId, KEYS.general);
    const before = await snapshot(h, f.appId);
    const seen = f.lines.length;
    const item = await success<Item>(
      await rollback(f, KEYS.general, { to_version: to, expected_version: 3, reason: '回到旧值' }),
      'rollback',
    );
    const value = [3, 6][to - 1]!;
    const now = f.clock.now().toISOString();
    expect(normalized(item)).toStrictEqual(
      itemOf(KEYS.general, { value, version: 4, updated_by: f.actor.username, updated_at: now }),
    );
    expect(await current(h, f.appId, KEYS.general)).toMatchObject({
      value,
      version: 4,
      updated_by: f.actor.username,
    });
    const history = await versionsOf(h, f.appId, KEYS.general);
    expect(history.slice(0, 3)).toStrictEqual(old);
    expect(history).toHaveLength(4);
    expect(history[3]).toMatchObject({
      version: 4,
      value,
      updated_by: f.actor.username,
      updated_by_admin_id: f.actor.id,
      reason: '回到旧值',
    });
    expect(history[3]!.created_at.toISOString()).toBe(now);
    const audits = await auditsSince(h, f.appId, before);
    expect(audits).toHaveLength(1);
    expectAudit(audits[0]!, f, f.actor, 'config_item_rollback', {
      key: KEYS.general,
      from: 3,
      to: 4,
      before: 9,
      after: value,
      reason: '回到旧值',
    });
    expectAlerted(f.lines, seen, [KEYS.general]);
    expect((await historyPage(f, KEYS.general)).items[0]).toMatchObject({ version: 4, value });
  },
);

it('[AC-F1-10e#46] risk / business 的键回滚带 totp 令牌成功', async () => {
  const f = await setup(h);
  await written(h, f.appId, KEYS.business, [3, 5], f.actor);
  const item = await success<Item>(
    await rollback(
      f,
      KEYS.business,
      { to_version: 1, expected_version: 2 },
      { stepUp: await stepUp(f) },
    ),
    'rollback',
  );
  expect(item).toMatchObject({ value: 3, version: 3, permission: 'config.business' });
});

it.each([
  ['等于当前版本', 3],
  ['高于当前版本', 4],
  ['远高于当前版本', 99],
] as const)('[AC-F1-10e#47] to_version %s（%i）20001 [to_version]，不写库', async (_name, to) => {
  const f = await setup(h);
  await written(h, f.appId, KEYS.general, [3, 6, 9], f.actor);
  const before = await snapshot(h, f.appId);
  await versionInvalid(await rollback(f, KEYS.general, { to_version: to, expected_version: 3 }));
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it('[AC-F1-10e#48] 种子写入的 v1 没有历史行：改到 v2 后回滚到 1 仍是 20001 [to_version]', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEYS.general, 3); // seed row: version 1, no history
  await success(await update(f, KEYS.general, { value: 6, expected_version: 1 }), 'update');
  expect((await versionsOf(h, f.appId, KEYS.general)).map((v) => v.version)).toStrictEqual([2]);
  const before = await snapshot(h, f.appId);
  await versionInvalid(await rollback(f, KEYS.general, { to_version: 1, expected_version: 2 }));
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it('[AC-F1-10e#49] 历史值已不合当前登记类型时 20001 [to_version]，不写库', async () => {
  const f = await setup(h);
  await putVersion(h, f.appId, KEYS.general, 1, 'three', f.actor);
  await putVersion(h, f.appId, KEYS.general, 2, 6, f.actor);
  await putRow(h, f.appId, KEYS.general, 6, 2, 'history-snapshot');
  const before = await snapshot(h, f.appId);
  await versionInvalid(await rollback(f, KEYS.general, { to_version: 1, expected_version: 2 }));
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it('[AC-F1-10e#50] 回滚 CAS：expected_version 不是当前版本 20902 resource=config_item，不写库不告警', async () => {
  const f = await setup(h);
  await written(h, f.appId, KEYS.general, [3, 6, 9], f.actor);
  const before = await snapshot(h, f.appId);
  const seen = f.lines.length;
  for (const expected of [2, 4]) {
    await conflict(
      await rollback(f, KEYS.general, { to_version: 1, expected_version: expected }),
      'rollback',
    );
  }
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
  expect(alertsSince(f.lines, seen)).toStrictEqual([]);
});

it.each([...UNREGISTERED, ...FUND_FLAGS, 'agent.page_guide.routes', 'external_hosts'])(
  '[AC-F1-10e#51] 未登记或不可改的键 %s 回滚 20001 [key]，不写库',
  async (key) => {
    const f = await setup(h);
    const registered = !(UNREGISTERED as readonly string[]).includes(key);
    if (registered || !['constructor', '__proto__', 'toString'].includes(key)) {
      const boolean = !registered || expectedOf(key).valueType === 'boolean';
      await written(h, f.appId, key, boolean ? [true, false] : [['Wallet'], []], f.actor);
    }
    const before = await snapshot(h, f.appId);
    await keyInvalid(
      await rollback(f, key, { to_version: 1, expected_version: 2 }, { stepUp: await stepUp(f) }),
      'rollback',
    );
    expect(await snapshot(h, f.appId)).toStrictEqual(before);
  },
);

it.each([
  { to_version: 1 },
  { expected_version: 3 },
  { to_version: 0, expected_version: 3 },
  { to_version: 1, expected_version: 0 },
  { to_version: 1, expected_version: 3, value: 1 },
  { to_version: 1, expected_version: 3, reason: 'x'.repeat(201) },
])('[AC-F1-10e#52] 回滚请求体不合契约 %j 20001，不写库', async (body) => {
  const f = await setup(h);
  await written(h, f.appId, KEYS.general, [3, 6, 9], f.actor);
  const before = await snapshot(h, f.appId);
  await rejected(await rollback(f, KEYS.general, body), 'rollback', 20001);
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});
