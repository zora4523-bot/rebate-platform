import { expect, it } from 'vitest';
import { validateAppVersionSave } from '../../../../apps/api/src/modules/content/domain/app-versions/index.ts';
import { row } from './kit.ts';

// F1-02zb §9.2 D2/D3/D4; contracts SemVer/StoreListing and app_versions column types.
it.each([
  ['ios', 'appstore'],
  ['android', 'official'],
  ['android', 'huawei'],
  ['harmony', 'agc'],
])('[AC-F1-02zb#1] 接受端渠道配对 %s / %s', (platform, channel) => {
  expect(
    validateAppVersionSave(
      {
        ...row(),
        platform,
        channel,
        store_listings: [{ store: 'a', listed_version: '1.1.0' }],
      },
      ['a'],
    ),
  ).toStrictEqual({ ok: true, store_table_empty: false });
});

it.each(['h5', 'admin', 'other', '', null, 1])(
  '[AC-F1-02zb#2] 拒绝不可管理的平台 %s',
  (platform) => {
    expect(validateAppVersionSave({ ...row(), platform }, ['a', 'b'])).toMatchObject({
      ok: false,
      fields: ['platform'],
    });
  },
);

it.each([
  ['ios', 'official'],
  ['ios', 'huawei'],
  ['ios', 'agc'],
  ['android', 'appstore'],
  ['android', 'agc'],
  ['harmony', 'official'],
  ['harmony', 'huawei'],
  ['harmony', 'appstore'],
  ['android', ''],
  ['android', 'other'],
  ['android', null],
])('[AC-F1-02zb#3] 不匹配的端渠道 %s / %s 定位 channel', (platform, channel) => {
  expect(validateAppVersionSave({ ...row(), platform, channel }, ['a', 'b'])).toMatchObject({
    ok: false,
    fields: ['channel'],
  });
});

const VERSION_FIELDS = ['latest_version', 'min_supported_version', 'recommended_version'] as const;
const INVALID_VERSIONS = [
  '1.02.0',
  '01.2.0',
  '1.2.00',
  '1.0',
  'v1.0.0',
  '1.0.0.0',
  '1.0.0-beta',
  '1.0.0+build',
  '-1.0.0',
  '1e2.0.0',
  ' 1.0.0',
  '1.0.0\n',
  '',
  1,
];

it.each(VERSION_FIELDS.flatMap((field) => INVALID_VERSIONS.map((value) => ({ field, value }))))(
  '[AC-F1-02zb#4] $field 拒绝非三段数字 $value',
  ({ field, value }) => {
    expect(validateAppVersionSave({ ...row(), [field]: value }, ['a', 'b'])).toMatchObject({
      ok: false,
      fields: [field],
    });
  },
);

it.each(VERSION_FIELDS)('[AC-F1-02zb#5] %s 接受零值、大版本分量且不另加大小关系', (field) => {
  for (const version of ['0.0.0', '1.10.0', '12345678901234567890.0.0']) {
    expect(validateAppVersionSave({ ...row(), [field]: version }, ['a', 'b'])).toStrictEqual({
      ok: true,
      store_table_empty: false,
    });
  }
});

it('[AC-F1-02zb#6] min/recommended 可空，latest 低于 min 也通过格式校验', () => {
  expect(
    validateAppVersionSave(row({ min_supported_version: null, recommended_version: null }), [
      'a',
      'b',
    ]),
  ).toStrictEqual({ ok: true, store_table_empty: false });
  expect(
    validateAppVersionSave(
      row({
        latest_version: '1.0.0',
        min_supported_version: '2.0.0',
        recommended_version: '3.0.0',
      }),
      ['a', 'b'],
    ),
  ).toStrictEqual({ ok: true, store_table_empty: false });
  expect(validateAppVersionSave({ ...row(), latest_version: null }, ['a', 'b'])).toMatchObject({
    ok: false,
    fields: ['latest_version'],
  });
});

it.each(['https://store.test/a?x=1#detail', 'market://details?id=demo', 'urn:store:demo'])(
  '[AC-F1-02zb#7] store_url 接受绝对 URI %s（不限 https）',
  (store_url) => {
    expect(validateAppVersionSave(row({ store_url }), ['a', 'b'])).toStrictEqual({
      ok: true,
      store_table_empty: false,
    });
  },
);

it.each([
  '',
  '/details/a',
  '//store.test/a',
  'store.test/a',
  'https://',
  'https://store.test/a b',
  null,
])('[AC-F1-02zb#8] store_url 拒绝非绝对 URI %s', (store_url) => {
  expect(validateAppVersionSave({ ...row(), store_url }, ['a', 'b'])).toMatchObject({
    ok: false,
    fields: ['store_url'],
  });
});

it.each(['update_title', 'update_notes'] as const)(
  '[AC-F1-02zb#9] 文案 %s 只要求字符串，允许空串及换行',
  (field) => {
    expect(validateAppVersionSave({ ...row(), [field]: '' }, ['a', 'b'])).toMatchObject({
      ok: true,
    });
    expect(
      validateAppVersionSave({ ...row(), [field]: '第一行\n第二行' }, ['a', 'b']),
    ).toMatchObject({
      ok: true,
    });
    expect(validateAppVersionSave({ ...row(), [field]: null }, ['a', 'b'])).toMatchObject({
      ok: false,
      fields: [field],
    });
  },
);

it.each(
  [
    null,
    {},
    'a',
    [null],
    [[]],
    [{}],
    [{ store: 'a' }],
    [{ listed_version: '1.1.0' }],
    [{ store: 1, listed_version: '1.1.0' }],
    [{ store: 'a', listed_version: 1 }],
    ...INVALID_VERSIONS.map((listed_version) => [{ store: 'a', listed_version }]),
  ].map((store_listings) => ({ store_listings })),
)('[AC-F1-02zb#10] 拒绝非法商店登记 $store_listings', ({ store_listings }) => {
  expect(validateAppVersionSave({ ...row(), store_listings }, ['a', 'b'])).toMatchObject({
    ok: false,
    fields: ['store_listings'],
  });
});

it.each([null, '1.1.0'])(
  '[AC-F1-02zb#11] 同一家商店重复出现即拒绝，第二项版本=%s',
  (listed_version) => {
    expect(
      validateAppVersionSave(
        row({
          store_listings: [
            { store: 'a', listed_version: '1.1.0' },
            { store: 'a', listed_version },
          ],
        }),
        ['a'],
      ),
    ).toMatchObject({ ok: false, fields: ['store_listings'] });
  },
);

it('[AC-F1-02zb#12] 空列表、默认商店未登记及 null 版本留给保存前核对', () => {
  for (const store_listings of [[], [{ store: 'b', listed_version: null }]]) {
    expect(validateAppVersionSave(row({ store_listings }), ['a', 'b'])).toStrictEqual({
      ok: true,
      store_table_empty: false,
    });
  }
});

it.each(['a_b1', 'a'.repeat(32)])(
  '[AC-F1-02zb#13] 空商店表允许合规键 %s 并返回告警标志',
  (store) => {
    expect(
      validateAppVersionSave(
        row({ default_store: store, store_listings: [{ store, listed_version: null }] }),
        [],
      ),
    ).toStrictEqual({ ok: true, store_table_empty: true });
  },
);

it.each(['default_store', 'store_listings'] as const)(
  '[AC-F1-02zb#14] 空商店表仍校验 %s 的键格式',
  (field) => {
    for (const store of ['', 'A-b', 'a'.repeat(33), 'a b', 'a\n', '商店', null]) {
      const value = field === 'default_store' ? store : [{ store, listed_version: null }];
      expect(validateAppVersionSave({ ...row(), [field]: value }, [])).toMatchObject({
        ok: false,
        fields: [field],
        store_table_empty: true,
      });
    }
  },
);

it('[AC-F1-02zb#15] 非空商店表拒绝表外默认商店', () => {
  expect(validateAppVersionSave(row({ default_store: 'c' }), ['a', 'b'])).toMatchObject({
    ok: false,
    fields: ['default_store'],
    store_table_empty: false,
  });
});

it('[AC-F1-02zb#16] 非空商店表拒绝表外登记，不因默认商店合法而放行', () => {
  expect(
    validateAppVersionSave(
      row({
        store_listings: [
          { store: 'a', listed_version: '1.1.0' },
          { store: 'c', listed_version: null },
        ],
      }),
      ['a', 'b'],
    ),
  ).toMatchObject({ ok: false, fields: ['store_listings'], store_table_empty: false });
});

it.each([null, 'a', [1], [null]].map((confirmed_stores) => ({ confirmed_stores })))(
  '[AC-F1-02zb#17] confirmed_stores 必须为字符串数组 $confirmed_stores',
  ({ confirmed_stores }) => {
    expect(validateAppVersionSave({ ...row(), confirmed_stores }, ['a', 'b'])).toMatchObject({
      ok: false,
      fields: ['confirmed_stores'],
    });
  },
);

it('[AC-F1-02zb#18] 多余确认不参与商店表成员校验', () => {
  expect(
    validateAppVersionSave(row({ confirmed_stores: ['a', 'unused'] }), ['a', 'b']),
  ).toStrictEqual({
    ok: true,
    store_table_empty: false,
  });
});

it.each([
  ...VERSION_FIELDS,
  'update_title',
  'update_notes',
  'store_url',
  'default_store',
  'store_listings',
  'confirmed_stores',
])('[AC-F1-02zb#47] 缺少字段 %s 不视为合法空值', (field) => {
  const input: Record<string, unknown> = { ...row() };
  delete input[field];
  expect(validateAppVersionSave(input, ['a', 'b'])).toMatchObject({
    ok: false,
    fields: [field],
  });
});

it('[AC-F1-02zb#48] 格式校验不改写输入、商店表或填写顺序', () => {
  const input = row({
    store_listings: [
      { store: 'b', listed_version: null },
      { store: 'a', listed_version: '1.1.0' },
    ],
  });
  const keys = ['b', 'a'];
  const original = structuredClone(input);
  expect(validateAppVersionSave(input, keys)).toStrictEqual({
    ok: true,
    store_table_empty: false,
  });
  expect(input).toStrictEqual(original);
  expect(keys).toStrictEqual(['b', 'a']);
});
