// B2-11d: the console's configuration center runs payout's BR-WDR-30 保存时校验 on every write path
// (PUT /admin/v1/config-items/{key}, POST /batch, POST /{key}/rollback) of the admin entry as
// assembled for production — 规划/08 BR-WDR-30「保存配置时另校验：max_amount_fen ≤
// withdraw.max_amount_fen；platform_daily_max_fen ≤ payout.daily_cap_fen」, 细则 ③ window_end >
// window_start and ⑫ risk_block_flags only BR-WDR-29 label codes. The check sees the configuration
// as the write would leave it (stored rows of the caller's app, the written values replacing
// them, 08 defaults for the rest). A refused write is 20001 with nothing written: fields [value]
// for a single update, the refused keys for a batch, [to_version] for a rollback (the F1-02zn
// convention of the same routes). The rule values are save-check.test.ts's; here only the wiring.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  batch,
  current,
  putRow,
  rejected,
  rollback,
  setup,
  stepUp,
  success,
  update,
  written,
  type Item,
  type Setup,
} from '../../content/config-items/kit.ts';
import {
  BLOCK_FLAGS,
  DAILY_CAP,
  DEFAULT_BLOCK_FLAGS,
  MAX,
  PLATFORM_MAX,
  WINDOW_END,
  WINDOW_START,
  WITHDRAW_MAX,
} from './kit.ts';

const h = useHarness();

/** PUT `key` = `value` with a fresh totp step-up (config.business). */
async function put(f: Setup, key: string, value: unknown, expectedVersion: number) {
  return update(f, key, { value, expected_version: expectedVersion }, { stepUp: await stepUp(f) });
}

async function refusedValue(f: Setup, key: string, value: unknown, expectedVersion: number) {
  await rejected(await put(f, key, value, expectedVersion), 'update', 20001, { fields: ['value'] });
}

async function saved(f: Setup, key: string, value: unknown, expectedVersion: number) {
  const item = await success<Item>(await put(f, key, value, expectedVersion), 'update');
  expect(item).toMatchObject({ key, value, version: expectedVersion + 1 });
}

it('[AC-B2-11d#37] ② withdraw.max_amount_fen=20000 时保存自动到账 max_amount_fen=20001 → 20001 [value]、不写；20000 可存', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, WITHDRAW_MAX, 20000);
  await refusedValue(f, MAX, 20001, 0);
  expect(await current(h, f.appId, MAX)).toBeUndefined();
  await saved(f, MAX, 20000, 0);
  expect(await current(h, f.appId, MAX)).toMatchObject({ value: 20000, version: 1 });
});

it('[AC-B2-11d#38] ② 没有 withdraw.max_amount_fen 行时按 08 缺省 500000 比较：500001 拒绝、500000 可存', async () => {
  const f = await setup(h);
  await refusedValue(f, MAX, 500001, 0);
  expect(await current(h, f.appId, MAX)).toBeUndefined();
  await saved(f, MAX, 500000, 0);
});

it.each([
  { cap: 100000, over: 100001 },
  { cap: undefined, over: 5000001 },
])(
  '[AC-B2-11d#39] ⑨ payout.daily_cap_fen=$cap（缺省 5000000）时 platform_daily_max_fen=$over 拒绝、等于上限可存',
  async ({ cap, over }) => {
    const f = await setup(h);
    if (cap !== undefined) await putRow(h, f.appId, DAILY_CAP, cap);
    await refusedValue(f, PLATFORM_MAX, over, 0);
    expect(await current(h, f.appId, PLATFORM_MAX)).toBeUndefined();
    await saved(f, PLATFORM_MAX, over - 1, 0);
  },
);

it('[AC-B2-11d#40] ③ 与另一端的现值比较：开始 18:00:00 时结束 17:59:59 拒绝、18:59:59 可存；其后开始改 19:00:00 拒绝', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, WINDOW_START, '18:00:00');
  await refusedValue(f, WINDOW_END, '17:59:59', 0);
  expect(await current(h, f.appId, WINDOW_END)).toBeUndefined();
  await saved(f, WINDOW_END, '18:59:59', 0);
  await refusedValue(f, WINDOW_START, '19:00:00', 1);
  expect(await current(h, f.appId, WINDOW_START)).toMatchObject({ value: '18:00:00', version: 1 });
});

it('[AC-B2-11d#41] ⑫ risk_block_flags 含非 BR-WDR-29 标签 code 拒绝；全是标签 code 可存', async () => {
  const f = await setup(h);
  await refusedValue(f, BLOCK_FLAGS, ['had_negative', 'blacklist'], 0);
  await refusedValue(f, BLOCK_FLAGS, ['risk_flag:had_negative'], 0);
  expect(await current(h, f.appId, BLOCK_FLAGS)).toBeUndefined();
  await saved(f, BLOCK_FLAGS, [...DEFAULT_BLOCK_FLAGS, 'blacklist_hit'], 0);
});

it('[AC-B2-11d#42] 批量保存按写完后的整体校验：违规整批拒绝、fields 为被拒的键、一项不写；开始与结束一起改到同一小时可存', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, WINDOW_START, '18:00:00');
  await putRow(h, f.appId, WINDOW_END, '18:59:59');
  const over = await batch(
    f,
    {
      items: [
        { key: MAX, value: 500001, expected_version: 0 },
        { key: PLATFORM_MAX, value: 5000001, expected_version: 0 },
      ],
    },
    { stepUp: await stepUp(f) },
  );
  await rejected(over, 'batch', 20001);
  expect([...over.json<{ data: { fields: string[] } }>().data.fields].sort()).toStrictEqual(
    [MAX, PLATFORM_MAX].sort(),
  );
  expect(await current(h, f.appId, MAX)).toBeUndefined();
  expect(await current(h, f.appId, PLATFORM_MAX)).toBeUndefined();
  const early = await batch(
    f,
    { items: [{ key: WINDOW_END, value: '10:59:59', expected_version: 1 }] },
    { stepUp: await stepUp(f) },
  );
  await rejected(early, 'batch', 20001, { fields: [WINDOW_END] });
  expect(await current(h, f.appId, WINDOW_END)).toMatchObject({ value: '18:59:59', version: 1 });
  await success(
    await batch(
      f,
      {
        items: [
          { key: WINDOW_START, value: '10:00:00', expected_version: 1 },
          { key: WINDOW_END, value: '10:59:59', expected_version: 1 },
        ],
      },
      { stepUp: await stepUp(f) },
    ),
    'batch',
  );
  expect(await current(h, f.appId, WINDOW_START)).toMatchObject({ value: '10:00:00', version: 2 });
  expect(await current(h, f.appId, WINDOW_END)).toMatchObject({ value: '10:59:59', version: 2 });
});

it('[AC-B2-11d#43] 回滚到违规的历史值同样拒绝：withdraw.max_amount_fen=35000 时把 max_amount_fen 回滚到 40000 → 20001 [to_version]、不写', async () => {
  const f = await setup(h);
  await written(h, f.appId, MAX, [40000, 30000], f.actor);
  await putRow(h, f.appId, WITHDRAW_MAX, 35000);
  await rejected(
    await rollback(f, MAX, { to_version: 1, expected_version: 2 }, { stepUp: await stepUp(f) }),
    'rollback',
    20001,
    { fields: ['to_version'] },
  );
  expect(await current(h, f.appId, MAX)).toMatchObject({ value: 30000, version: 2 });
});
