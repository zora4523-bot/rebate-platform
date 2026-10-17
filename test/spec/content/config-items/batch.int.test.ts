// F1-10e rulings 8 and 16 and adminBatchUpdateConfigItems: POST /admin/v1/config-items/batch —
// one permission point per batch, every key and value checked before any version is compared,
// the whole batch or nothing.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  KEYS,
  alertsSince,
  appWith,
  auditOfKey,
  auditsSince,
  batch,
  conflict,
  current,
  expectAlerted,
  expectAudit,
  normalized,
  putRow,
  rejected,
  setup,
  snapshot,
  stepUp,
  success,
  itemOf,
  versionsOf,
  written,
  type Item,
} from './kit.ts';

const h = useHarness();
const fieldsOf = (response: { json(): { data?: Record<string, unknown> } }) =>
  [...((response.json().data?.fields as string[] | undefined) ?? [])].sort();

it('[AC-F1-10e#37] 整批成功：按请求顺序返回每项，每个键各自 version+1，历史、审计（同一 reason）、告警各一', async () => {
  const f = await setup(h);
  await written(h, f.appId, KEYS.general, [3, 6], f.actor);
  const before = await snapshot(h, f.appId);
  const seen = f.lines.length;
  const response = await batch(f, {
    items: [
      { key: KEYS.generalFlag, value: false, expected_version: 0 },
      { key: KEYS.general, value: 12, expected_version: 2 },
    ],
    reason: '上线前统一调整',
  });
  const data = await success<{ items: Item[] }>(response, 'batch');
  const now = f.clock.now().toISOString();
  expect(data.items.map(normalized)).toStrictEqual([
    itemOf(KEYS.generalFlag, {
      value: false,
      version: 1,
      updated_by: f.actor.username,
      updated_at: now,
    }),
    itemOf(KEYS.general, { value: 12, version: 3, updated_by: f.actor.username, updated_at: now }),
  ]);
  expect(await current(h, f.appId, KEYS.generalFlag)).toMatchObject({ value: false, version: 1 });
  expect(await current(h, f.appId, KEYS.general)).toMatchObject({ value: 12, version: 3 });
  expect(await versionsOf(h, f.appId, KEYS.generalFlag)).toMatchObject([
    { version: 1, value: false, reason: '上线前统一调整', updated_by_admin_id: f.actor.id },
  ]);
  const general = await versionsOf(h, f.appId, KEYS.general);
  expect(general.map((v) => v.version)).toStrictEqual([1, 2, 3]);
  expect(general[2]).toMatchObject({ value: 12, reason: '上线前统一调整' });
  const audits = await auditsSince(h, f.appId, before);
  expect(audits).toHaveLength(2);
  expectAudit(auditOfKey(audits, KEYS.generalFlag), f, f.actor, 'config_item_change', {
    key: KEYS.generalFlag,
    from: 0,
    to: 1,
    before: null,
    after: false,
    reason: '上线前统一调整',
  });
  expectAudit(auditOfKey(audits, KEYS.general), f, f.actor, 'config_item_change', {
    key: KEYS.general,
    from: 2,
    to: 3,
    before: 6,
    after: 12,
    reason: '上线前统一调整',
  });
  expectAlerted(f.lines, seen, [KEYS.generalFlag, KEYS.general]);
});

it('[AC-F1-10e#38] 整批里值未变且版本匹配的键不加 version、不写历史与审计，其余照常', async () => {
  const f = await setup(h);
  await written(h, f.appId, KEYS.general, [3], f.actor);
  await written(h, f.appId, KEYS.generalFlag, [true], f.actor);
  const before = await snapshot(h, f.appId);
  const seen = f.lines.length;
  const data = await success<{ items: Item[] }>(
    await batch(f, {
      items: [
        { key: KEYS.general, value: 3, expected_version: 1 },
        { key: KEYS.generalFlag, value: false, expected_version: 1 },
      ],
    }),
    'batch',
  );
  expect(data.items.map((i) => [i.key, i.value, i.version])).toStrictEqual([
    [KEYS.general, 3, 1],
    [KEYS.generalFlag, false, 2],
  ]);
  expect(await versionsOf(h, f.appId, KEYS.general)).toHaveLength(1);
  const audits = await auditsSince(h, f.appId, before);
  expect(audits).toHaveLength(1);
  auditOfKey(audits, KEYS.generalFlag);
  expectAlerted(f.lines, seen, [KEYS.generalFlag]);
  expect(
    alertsSince(f.lines, seen).filter((l) => JSON.stringify(l).includes(KEYS.general)),
  ).toEqual([]);
});

it.each([
  [
    'general + risk',
    [
      { key: KEYS.general, value: 1, expected_version: 0 },
      { key: KEYS.risk, value: 600, expected_version: 0 },
    ],
  ],
  [
    'risk + business',
    [
      { key: KEYS.riskFlag, value: false, expected_version: 0 },
      { key: KEYS.business, value: 2, expected_version: 0 },
    ],
  ],
  [
    'same key twice',
    [
      { key: KEYS.general, value: 1, expected_version: 0 },
      { key: KEYS.general, value: 2, expected_version: 0 },
    ],
  ],
  [
    'same key twice, same value',
    [
      { key: KEYS.business, value: 2, expected_version: 0 },
      { key: KEYS.business2, value: 2, expected_version: 0 },
      { key: KEYS.business, value: 2, expected_version: 0 },
    ],
  ],
] as const)('[AC-F1-10e#39] 整批 %s：20001 fields=[items]，整批不写', async (_name, items) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await rejected(
    await batch(f, { items: [...items] }, { stepUp: await stepUp(f) }),
    'batch',
    20001,
    { fields: ['items'] },
  );
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it('[AC-F1-10e#40] 多个键校验失败：fields 列出全部失败的键（未登记、不可改、类型不符），整批不写', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEYS.general, 1);
  const before = await snapshot(h, f.appId);
  const seen = f.lines.length;
  const response = await batch(f, {
    items: [
      { key: KEYS.general, value: 2, expected_version: 1 },
      { key: KEYS.generalFlag, value: 'yes', expected_version: 0 },
      { key: 'external_hosts', value: [], expected_version: 0 },
      { key: 'invite.fail_limit_per_day', value: 5, expected_version: 0 },
      { key: KEYS.generalFlag2, value: false, expected_version: 0 },
    ],
  });
  await rejected(response, 'batch', 20001);
  expect(Object.keys(response.json().data ?? {})).toStrictEqual(['fields']);
  expect(fieldsOf(response)).toStrictEqual(
    ['external_hosts', 'invite.fail_limit_per_day', KEYS.generalFlag].sort(),
  );
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
  expect(alertsSince(f.lines, seen)).toStrictEqual([]);
});

it('[AC-F1-10e#41] 先校验后比版本：有键校验失败时即使另一项版本不符也是 20001 列失败键，不是 20902', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEYS.general, 1);
  const before = await snapshot(h, f.appId);
  const response = await batch(f, {
    items: [
      { key: KEYS.general, value: 2, expected_version: 5 },
      { key: KEYS.generalFlag, value: 0, expected_version: 0 },
    ],
  });
  await rejected(response, 'batch', 20001);
  expect(fieldsOf(response)).toStrictEqual([KEYS.generalFlag]);
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it.each([0, 1, 2])(
  '[AC-F1-10e#42] 全部校验通过、第 %i 项版本不符：20902 resource=config_item，整批一个都不写、不告警',
  async (stale) => {
    const f = await setup(h);
    await written(h, f.appId, KEYS.business, [3], f.actor);
    await written(h, f.appId, KEYS.business2, [24, 48], f.actor);
    const items = [
      { key: KEYS.business, value: 4, expected_version: 1 },
      { key: KEYS.business2, value: 12, expected_version: 2 },
      { key: 'withdraw.payout_account_verify_recheck_minutes', value: 15, expected_version: 0 },
    ];
    items[stale]!.expected_version += 1;
    const before = await snapshot(h, f.appId);
    const seen = f.lines.length;
    await conflict(await batch(f, { items }, { stepUp: await stepUp(f) }), 'batch');
    expect(await snapshot(h, f.appId)).toStrictEqual(before);
    expect(alertsSince(f.lines, seen)).toStrictEqual([]);
  },
);

it('[AC-F1-10e#43] 整批 business 键带 totp 令牌成功；整批中途写库失败时全部回滚', async () => {
  const f = await setup(h);
  const items = [
    { key: KEYS.business, value: 2, expected_version: 0 },
    { key: KEYS.business2, value: 12, expected_version: 0 },
  ];
  let reached = false;
  // Fails the history insert of the second key, whether written per key or as one statement.
  const db = h.db.withPlugin({
    transformQuery(args) {
      if (
        args.node.kind === 'InsertQueryNode' &&
        /\bconfig_item_versions\b/.test(JSON.stringify(args.node.into)) &&
        JSON.stringify(args.node).includes(KEYS.business2)
      ) {
        reached = true;
        throw new Error('injected second history failure');
      }
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const app = await appWith(h, f, db);
  const before = await snapshot(h, f.appId);
  const seen = f.lines.length;
  await rejected(
    await batch({ ...f, app }, { items }, { stepUp: await stepUp(f) }),
    'batch',
    50001,
  );
  expect(reached).toBe(true);
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
  expect(alertsSince(f.lines, seen)).toStrictEqual([]);
  const data = await success<{ items: Item[] }>(
    await batch(f, { items }, { stepUp: await stepUp(f) }),
    'batch',
  );
  expect(data.items.map((i) => [i.key, i.version])).toStrictEqual([
    [KEYS.business, 1],
    [KEYS.business2, 1],
  ]);
});

it.each([
  { items: [] },
  {},
  { items: [{ key: KEYS.general, value: 1 }] },
  { items: [{ key: KEYS.general, value: 1, expected_version: 0, app_id: 'x' }] },
  { items: [{ key: KEYS.general, value: 1, expected_version: 0 }], reason: '' },
  {
    items: Array.from({ length: 201 }, () => ({
      key: KEYS.general,
      value: 1,
      expected_version: 0,
    })),
  },
])('[AC-F1-10e#44] 整批请求体不合契约 20001，不写库', async (body) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await rejected(await batch(f, body), 'batch', 20001);
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});
