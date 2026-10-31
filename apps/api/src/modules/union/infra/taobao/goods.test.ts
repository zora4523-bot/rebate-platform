import { expect, it } from 'vitest';
import { UnionError } from '../../domain/types.ts';
import { detailItemId, detailRows, mapTaobaoDetail } from './goods.ts';

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error.code;
    throw error;
  }
  throw new Error('expected a UnionError');
}

const now = new Date('2026-10-31T09:00:00.000Z');

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_basic_info: { title: '单元合成商品' },
    price_promotion_info: { zk_final_price: '10.00', final_promotion_price: '10.00' },
    publish_info: { income_info: { commission_rate: '500' } },
    ...overrides,
  };
}

it('[AC-B1-04l-UNIT#1] 详情 results 缺失、为 {}、包装下空数组 → item_unavailable（UnionError，不是 TypeError）', () => {
  for (const inner of [{}, { results: null }, { results: {} }, { results: { unit_wrap: [] } }]) {
    expect(code(() => detailRows(inner))).toBe('item_unavailable');
  }
});

it('[AC-B1-04l-UNIT#2] 详情结构不对 → upstream_unavailable：results 非对象、包装值非数组、多个包装键', () => {
  const bad: unknown[] = [
    { results: [] },
    { results: 'unit' },
    { results: { unit_wrap: {} } },
    { results: { unit_wrap: 'unit' } },
    { results: { unit_wrap: null } },
    { results: { a: [row()], b: [row()] } },
    null,
  ];
  for (const inner of bad) expect(code(() => detailRows(inner))).toBe('upstream_unavailable');
});

it('[AC-B1-04l-UNIT#3] 结果行不是对象、标题缺失或佣金比例不合格 → upstream_unavailable', () => {
  const rows: unknown[] = [
    null,
    'unit',
    row({ item_basic_info: {} }),
    row({ item_basic_info: { title: '  ' } }),
    row({ publish_info: {} }),
    row({ publish_info: { income_info: { commission_rate: '12.5' } } }),
    row({ publish_info: { income_info: { commission_rate: '10001' } } }),
  ];
  for (const input of rows) {
    expect(code(() => mapTaobaoDetail(input, 'unit-item', now, undefined))).toBe(
      'upstream_unavailable',
    );
  }
});

it('[AC-B1-04l-UNIT#4] 价格字段缺失或非法 → missing_field 异常，三价为 0', () => {
  for (const price of [
    {},
    { zk_final_price: 'abc', final_promotion_price: '10.00' },
    { zk_final_price: '10.00', final_promotion_price: '10.00', final_promotion_path_list: 'x' },
    {
      zk_final_price: '10.00',
      final_promotion_price: '9.00',
      final_promotion_path_list: {
        final_promotion_path_map_data: [
          {
            promotion_title: '商品券',
            promotion_fee: '1.00',
            promotion_id: 'u1',
            promotion_end_time: 'soon',
          },
        ],
      },
    },
  ]) {
    expect(
      mapTaobaoDetail(row({ price_promotion_info: price }), 'unit-item', now, undefined),
    ).toMatchObject({
      price_fen: 0n,
      coupon_fen: 0n,
      final_price_fen: 0n,
      price_status: 'anomaly',
      price_anomaly_reason: 'missing_field',
    });
  }
});

it('[AC-B1-04l-UNIT#5] 一级类目接受数字串，非法 ID 与空名称不填', () => {
  const ok = mapTaobaoDetail(
    row({
      item_basic_info: { title: 'u', level_one_category_id: '16', level_one_category_name: '女装' },
    }),
    'unit-item',
    now,
    undefined,
  );
  expect(ok).toMatchObject({ category_l1_id: '16', category_l1_name: '女装' });
  const bad = mapTaobaoDetail(
    row({
      item_basic_info: { title: 'u', level_one_category_id: -1, level_one_category_name: '' },
    }),
    'unit-item',
    now,
    undefined,
  );
  expect(bad).not.toHaveProperty('category_l1_id');
  expect(bad).not.toHaveProperty('category_l1_name');
});

it('[AC-B1-04l-UNIT#6] item_id：非淘宝商品、缺失、空白、含逗号 → invalid_dto；合格原样返回', () => {
  expect(detailItemId({ platform: 'taobao', item_id: ' unit-1 ' })).toBe(' unit-1 ');
  for (const ref of [
    { platform: 'pdd' as const, item_id: 'unit-1' },
    { platform: 'taobao' as const },
    { platform: 'taobao' as const, item_id: '\t' },
    { platform: 'taobao' as const, item_id: 'a,b' },
  ]) {
    expect(code(() => detailItemId(ref))).toBe('invalid_dto');
  }
});
