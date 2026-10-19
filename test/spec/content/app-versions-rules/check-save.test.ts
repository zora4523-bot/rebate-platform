import { expect, it } from 'vitest';
import { checkAppVersionSave } from '../../../../apps/api/src/modules/content/domain/app-versions/index.ts';
import type { AppVersionSaveInput } from '../../../../apps/api/src/modules/content/domain/app-versions/index.ts';
import { row } from './kit.ts';

// SPEC_REF 5ecafb3, 08/10_ID l.196–198; task §9.2 Z1–Z3.
it('[AC-F1-02zb#19] 默认商店回退：先切换默认商店，再逐家确认落后商店', () => {
  const before = row();
  const rollback = row({
    store_listings: [
      { store: 'a', listed_version: '1.0.0' },
      { store: 'b', listed_version: '1.1.0' },
    ],
  });
  expect(checkAppVersionSave(before, rollback)).toStrictEqual({
    ok: false,
    fields: ['store_listings'],
  });

  const switched = row({ default_store: 'b' });
  expect(checkAppVersionSave(before, switched)).toStrictEqual({ ok: true, confirmed: [] });
  const after = { ...rollback, default_store: 'b' };
  expect(checkAppVersionSave(switched, after)).toStrictEqual({
    ok: false,
    fields: ['confirmed_stores'],
  });
  expect(checkAppVersionSave(switched, { ...after, confirmed_stores: ['a'] })).toStrictEqual({
    ok: true,
    confirmed: ['a'],
  });
});

it('[AC-F1-02zb#20] 单店回退：先单独下调 min，再登记回退版本', () => {
  const before = row({
    platform: 'harmony',
    channel: 'agc',
    store_listings: [{ store: 'a', listed_version: '1.1.0' }],
  });
  const rollback = { ...before, store_listings: [{ store: 'a', listed_version: '1.0.0' }] };
  expect(checkAppVersionSave(before, rollback)).toStrictEqual({
    ok: false,
    fields: ['store_listings'],
  });
  const lowered = { ...before, min_supported_version: '1.0.0' };
  expect(checkAppVersionSave(before, lowered)).toStrictEqual({ ok: true, confirmed: [] });
  expect(
    checkAppVersionSave(lowered, { ...rollback, min_supported_version: '1.0.0' }),
  ).toStrictEqual({
    ok: true,
    confirmed: [],
  });
});

it('[AC-F1-02zb#21] 提高 min 按保存后的 min 拒绝默认商店不足', () => {
  expect(checkAppVersionSave(row(), row({ min_supported_version: '1.2.0' }))).toStrictEqual({
    ok: false,
    fields: ['min_supported_version'],
  });
});

it('[AC-F1-02zb#22] 同时提高 min 与换默认商店，fields 仅含实际改动且按固定顺序', () => {
  expect(
    checkAppVersionSave(row(), row({ default_store: 'b', min_supported_version: '1.2.0' })),
  ).toStrictEqual({ ok: false, fields: ['min_supported_version', 'default_store'] });
});

it('[AC-F1-02zb#23] 三个相关字段同时改动时全部定位，不夹带文案字段或建议', () => {
  expect(
    checkAppVersionSave(
      row(),
      row({
        min_supported_version: '1.2.0',
        default_store: 'b',
        store_listings: [
          { store: 'b', listed_version: '1.0.0' },
          { store: 'a', listed_version: '1.1.0' },
        ],
        update_title: '新文案',
        confirmed_stores: ['a', 'b'],
      }),
    ),
  ).toStrictEqual({
    ok: false,
    fields: ['min_supported_version', 'default_store', 'store_listings'],
  });
});

it.each(
  [
    [
      { store: 'a', listed_version: null },
      { store: 'b', listed_version: '1.1.0' },
    ],
    [{ store: 'b', listed_version: '1.1.0' }],
    [],
  ].map((store_listings) => ({ store_listings })),
)('[AC-F1-02zb#24] 清空或删除默认商店必须拒绝 $store_listings', ({ store_listings }) => {
  expect(
    checkAppVersionSave(row(), row({ store_listings, confirmed_stores: ['a', 'b'] })),
  ).toStrictEqual({ ok: false, fields: ['store_listings'] });
});

it('[AC-F1-02zb#25] 换到未登记的默认商店，即使其他商店足够也拒绝', () => {
  expect(checkAppVersionSave(row(), row({ default_store: 'c' }))).toStrictEqual({
    ok: false,
    fields: ['default_store'],
  });
});

it.each([null, '1.0.0'])(
  '[AC-F1-02zb#26] 默认商店改为已登记但版本不足的店 %s 也拒绝',
  (listed_version) => {
    const before = row({
      store_listings: [
        { store: 'a', listed_version: '1.1.0' },
        { store: 'b', listed_version },
      ],
    });
    expect(
      checkAppVersionSave(before, { ...before, default_store: 'b', confirmed_stores: ['b'] }),
    ).toStrictEqual({
      ok: false,
      fields: ['default_store'],
    });
  },
);

it.each([null, '1.0.0'])(
  '[AC-F1-02zb#27] 其他商店变成 %s 也触发核对且必须确认',
  (listed_version) => {
    const after = row({
      store_listings: [
        { store: 'a', listed_version: '1.1.0' },
        { store: 'b', listed_version },
      ],
    });
    expect(checkAppVersionSave(row(), after)).toStrictEqual({
      ok: false,
      fields: ['confirmed_stores'],
    });
    expect(checkAppVersionSave(row(), { ...after, confirmed_stores: ['b'] })).toStrictEqual({
      ok: true,
      confirmed: ['b'],
    });
  },
);

it('[AC-F1-02zb#28] 多家落后逐家确认，按登记顺序审计，忽略多余和重复确认', () => {
  const after = row({
    store_listings: [
      { store: 'c', listed_version: null },
      { store: 'a', listed_version: '1.1.0' },
      { store: 'b', listed_version: '1.0.0' },
      { store: 'd', listed_version: '1.2.0' },
    ],
  });
  for (const confirmed_stores of [[], ['b'], ['c'], ['a', 'd', 'unused']]) {
    expect(checkAppVersionSave(row(), { ...after, confirmed_stores })).toStrictEqual({
      ok: false,
      fields: ['confirmed_stores'],
    });
  }
  expect(
    checkAppVersionSave(row(), { ...after, confirmed_stores: ['b', 'unused', 'a', 'c', 'd', 'b'] }),
  ).toStrictEqual({ ok: true, confirmed: ['c', 'b'] });
});

it('[AC-F1-02zb#29] 提高 min 后原来足够的其他商店也须确认', () => {
  const before = row({
    min_supported_version: '1.0.0',
    store_listings: [
      { store: 'a', listed_version: '1.1.0' },
      { store: 'b', listed_version: '1.0.0' },
    ],
  });
  const after = { ...before, min_supported_version: '1.1.0' };
  expect(checkAppVersionSave(before, after)).toStrictEqual({
    ok: false,
    fields: ['confirmed_stores'],
  });
  expect(checkAppVersionSave(before, { ...after, confirmed_stores: ['b'] })).toStrictEqual({
    ok: true,
    confirmed: ['b'],
  });
});

it('[AC-F1-02zb#30] 新增未知版本的其他商店触发确认', () => {
  const before = row({ store_listings: [{ store: 'a', listed_version: '1.1.0' }] });
  const after = {
    ...before,
    store_listings: [...before.store_listings, { store: 'b', listed_version: null }],
  };
  expect(checkAppVersionSave(before, after)).toStrictEqual({
    ok: false,
    fields: ['confirmed_stores'],
  });
});

it('[AC-F1-02zb#31] 删除其他商店同样触发，仍须检查未改动的默认商店', () => {
  const before = row({
    store_listings: [
      { store: 'a', listed_version: '1.0.0' },
      { store: 'b', listed_version: '1.1.0' },
    ],
  });
  expect(
    checkAppVersionSave(before, {
      ...before,
      store_listings: [{ store: 'a', listed_version: '1.0.0' }],
    }),
  ).toStrictEqual({ ok: false, fields: ['store_listings'] });
});

it('[AC-F1-02zb#32] 删除落后商店后只核对仍登记的店，不要求确认被删商店', () => {
  const before = row({
    store_listings: [
      { store: 'a', listed_version: '1.1.0' },
      { store: 'b', listed_version: null },
    ],
  });
  expect(
    checkAppVersionSave(before, {
      ...before,
      store_listings: [{ store: 'a', listed_version: '1.1.0' }],
      confirmed_stores: ['b'],
    }),
  ).toStrictEqual({ ok: true, confirmed: [] });
});

it('[AC-F1-02zb#33] 店铺数量和版本序列相同，但商店键替换仍算增删', () => {
  const before = row({
    store_listings: [
      { store: 'a', listed_version: '1.1.0' },
      { store: 'b', listed_version: null },
    ],
  });
  expect(
    checkAppVersionSave(before, {
      ...before,
      store_listings: [
        { store: 'a', listed_version: '1.1.0' },
        { store: 'c', listed_version: null },
      ],
      confirmed_stores: ['b'],
    }),
  ).toStrictEqual({ ok: false, fields: ['confirmed_stores'] });
});

it('[AC-F1-02zb#34] 没设最低支持版本时任何触发字段变化都不核对', () => {
  const after = row({
    min_supported_version: null,
    default_store: 'c',
    store_listings: [],
    confirmed_stores: ['a'],
  });
  expect(checkAppVersionSave(row(), after)).toStrictEqual({ ok: true, confirmed: [] });
  expect(checkAppVersionSave(null, after)).toStrictEqual({ ok: true, confirmed: [] });
});

const NON_TRIGGER_CHANGES: { name: string; patch: Partial<AppVersionSaveInput> }[] = [
  { name: '无改动', patch: {} },
  { name: '只下调 min', patch: { min_supported_version: '1.0.0' } },
  { name: '只提高 recommended', patch: { recommended_version: '2.0.0' } },
  { name: '只改 latest', patch: { latest_version: '2.0.0' } },
  { name: '只改文案', patch: { update_title: '标题', update_notes: '新说明' } },
  { name: '只改 URI', patch: { store_url: 'market://details?id=demo' } },
  { name: '只改确认', patch: { confirmed_stores: ['a', 'b'] } },
];

it.each(NON_TRIGGER_CHANGES)(
  '[AC-F1-02zb#35] $name 不核对，即使现有默认和其他商店都不满足',
  ({ patch }) => {
    const before = row({
      store_listings: [
        { store: 'a', listed_version: '0.9.0' },
        { store: 'b', listed_version: null },
      ],
    });
    expect(checkAppVersionSave(before, { ...before, ...patch })).toStrictEqual({
      ok: true,
      confirmed: [],
    });
  },
);

it('[AC-F1-02zb#36] 只调整登记顺序不核对，也不产出审计确认', () => {
  const before = row({
    store_listings: [
      { store: 'a', listed_version: null },
      { store: 'b', listed_version: '1.0.0' },
    ],
  });
  const after = {
    ...before,
    store_listings: [...before.store_listings].reverse(),
    confirmed_stores: ['a', 'b'],
  };
  expect(checkAppVersionSave(before, after)).toStrictEqual({ ok: true, confirmed: [] });
});

it('[AC-F1-02zb#37] 顺序与 min 同时变化时只定位真正的 min 改动', () => {
  const before = row();
  expect(
    checkAppVersionSave(before, {
      ...before,
      min_supported_version: '1.2.0',
      store_listings: [...before.store_listings].reverse(),
    }),
  ).toStrictEqual({
    ok: false,
    fields: ['min_supported_version'],
  });
});

it('[AC-F1-02zb#38] 下调 min 同时改登记仍须核对，不自动再下调', () => {
  const before = row({ min_supported_version: '2.0.0' });
  const after = row({
    min_supported_version: '1.1.0',
    store_listings: [{ store: 'a', listed_version: '1.0.0' }],
  });
  expect(checkAppVersionSave(before, after)).toStrictEqual({
    ok: false,
    fields: ['min_supported_version', 'store_listings'],
  });
  expect(after.min_supported_version).toBe('1.1.0');
});

it('[AC-F1-02zb#39] 同时改 min 和登记按新 min 判断，他家达到新值无需确认', () => {
  const before = row({ min_supported_version: '2.0.0' });
  const after = row({
    min_supported_version: '1.0.0',
    store_listings: [
      { store: 'a', listed_version: '1.0.0' },
      { store: 'b', listed_version: '1.0.0' },
    ],
  });
  expect(checkAppVersionSave(before, after)).toStrictEqual({ ok: true, confirmed: [] });
});

it('[AC-F1-02zb#40] 新建设置 min 后默认商店不足，三个保存字段均定位', () => {
  expect(checkAppVersionSave(null, row({ min_supported_version: '1.2.0' }))).toStrictEqual({
    ok: false,
    fields: ['min_supported_version', 'default_store', 'store_listings'],
  });
});

it('[AC-F1-02zb#41] 新建同样要求其他商店逐家确认', () => {
  const after = row({
    store_listings: [
      { store: 'a', listed_version: '1.1.0' },
      { store: 'b', listed_version: null },
    ],
  });
  expect(checkAppVersionSave(null, after)).toStrictEqual({
    ok: false,
    fields: ['confirmed_stores'],
  });
  expect(checkAppVersionSave(null, { ...after, confirmed_stores: ['b'] })).toStrictEqual({
    ok: true,
    confirmed: ['b'],
  });
  expect(checkAppVersionSave(null, row())).toStrictEqual({ ok: true, confirmed: [] });
});

it('[AC-F1-02zb#42] 原先 min 为 null，首次设置也算提高且必须核对', () => {
  expect(
    checkAppVersionSave(
      row({ min_supported_version: null }),
      row({ min_supported_version: '1.2.0' }),
    ),
  ).toStrictEqual({ ok: false, fields: ['min_supported_version'] });
});

it.each([
  { listed: '1.10.0', min: '1.9.0', ok: true },
  { listed: '1.9.0', min: '1.10.0', ok: false },
  { listed: '1.0.10', min: '1.0.9', ok: true },
  { listed: '2.0.0', min: '1.99.99', ok: true },
  { listed: '1.1.0', min: '1.1.0', ok: true },
  { listed: '9007199254740992.0.0', min: '9007199254740993.0.0', ok: false },
])('[AC-F1-02zb#43] 默认商店按数字逐段比较 $listed 与 $min', ({ listed, min, ok }) => {
  const before = row({
    min_supported_version: null,
    store_listings: [{ store: 'a', listed_version: listed }],
  });
  expect(checkAppVersionSave(before, { ...before, min_supported_version: min })).toStrictEqual(
    ok ? { ok: true, confirmed: [] } : { ok: false, fields: ['min_supported_version'] },
  );
});

it('[AC-F1-02zb#44] 其他商店也按数字比较，不把 1.9.0 误当成达到 1.10.0', () => {
  const before = row({
    min_supported_version: '1.0.0',
    store_listings: [
      { store: 'a', listed_version: '1.10.0' },
      { store: 'b', listed_version: '1.9.0' },
    ],
  });
  const after = { ...before, min_supported_version: '1.10.0' };
  expect(checkAppVersionSave(before, after)).toStrictEqual({
    ok: false,
    fields: ['confirmed_stores'],
  });
  expect(checkAppVersionSave(before, { ...after, confirmed_stores: ['b'] })).toStrictEqual({
    ok: true,
    confirmed: ['b'],
  });
});

it('[AC-F1-02zb#45] 纯函数成功核对不修改输入、登记顺序或确认列表', () => {
  const before = row();
  const after = row({
    default_store: 'b',
    store_listings: [
      { store: 'b', listed_version: '1.1.0' },
      { store: 'a', listed_version: null },
    ],
    confirmed_stores: ['b', 'a', 'unused'],
  });
  const savedBefore = structuredClone(before);
  const savedAfter = structuredClone(after);
  expect(checkAppVersionSave(before, after)).toStrictEqual({ ok: true, confirmed: ['a'] });
  expect(before).toStrictEqual(savedBefore);
  expect(after).toStrictEqual(savedAfter);
});

it('[AC-F1-02zb#49] 不能沿用上一次保存的确认代替本次确认', () => {
  const before = row({
    store_listings: [
      { store: 'a', listed_version: '1.2.0' },
      { store: 'b', listed_version: '1.0.0' },
    ],
    confirmed_stores: ['b'],
  });
  expect(
    checkAppVersionSave(before, {
      ...before,
      min_supported_version: '1.2.0',
      confirmed_stores: [],
    }),
  ).toStrictEqual({ ok: false, fields: ['confirmed_stores'] });
});

it('[AC-F1-02zb#50] 下调 min 并更换默认商店也必须核对保存后的版本', () => {
  const before = row({
    min_supported_version: '1.2.0',
    store_listings: [
      { store: 'a', listed_version: '1.2.0' },
      { store: 'b', listed_version: '1.0.0' },
    ],
  });
  expect(
    checkAppVersionSave(before, { ...before, min_supported_version: '1.1.0', default_store: 'b' }),
  ).toStrictEqual({ ok: false, fields: ['min_supported_version', 'default_store'] });
});

it.each([null, '1.1.0'])(
  '[AC-F1-02zb#51] 商店登记从 %s 提高也触发核对，不能漏掉未改动的未知商店',
  (listed_version) => {
    const before = row({
      store_listings: [
        { store: 'a', listed_version },
        { store: 'b', listed_version: null },
      ],
    });
    const after = row({
      store_listings: [
        { store: 'a', listed_version: '1.2.0' },
        { store: 'b', listed_version: null },
      ],
    });
    expect(checkAppVersionSave(before, after)).toStrictEqual({
      ok: false,
      fields: ['confirmed_stores'],
    });
    expect(checkAppVersionSave(before, { ...after, confirmed_stores: ['b'] })).toStrictEqual({
      ok: true,
      confirmed: ['b'],
    });
  },
);
