import { expect, it } from 'vitest';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { unwrapPddResponse } from '../../../../apps/api/src/modules/union/infra/pdd/response.ts';
import { ctx, detail, increment, range, win } from '../pdd-orders/kit.ts';
import { wireSetup } from './kit.ts';

const sources = ['increment', 'pay_time', 'detail'] as const;
type Source = (typeof sources)[number];

// Numbers are inserted as raw JSON text: JSON.stringify(9007199254740993) would erase the bug.
function rawRow(integerText: string, key = 'goods_id'): string {
  return `{"order_sn":"lossless-order","order_amount":1200,"promotion_amount":100,"${key}":${integerText}}`;
}

function envelope(source: Source, rowText: string): string {
  return source === 'detail'
    ? `{"order_detail_response":${rowText}}`
    : `{"order_list_get_response":{"order_list":[${rowText}]}}`;
}

async function read(source: Source, body: string): Promise<readonly UnionOrder[]> {
  const { adapter } = wireSetup(() => body);
  // Direct construction intentionally supplies no new governance callback/option.
  if (source === 'detail') return [await adapter.getPddOrderDetail('lossless-order', ctx)];
  return (await adapter.listOrders(win, { queryMode: source }, ctx)).items;
}

it.each(sources)(
  '[AC-B1-04w-ID#1] %s 从原始 JSON 区分 2^53 与 2^53+1，既有边界仍接受',
  async (source) => {
    for (const value of ['0', '9007199254740991', '9007199254740992']) {
      await expect(read(source, envelope(source, rawRow(value)))).resolves.toMatchObject([
        { goods_id: value, paid_fen: 1200n, commission_fen: 100n },
      ]);
    }
    for (const value of ['-1', '1.5', '"9007199254740992"', '9007199254740994']) {
      await expect(read(source, envelope(source, rawRow(value)))).rejects.toMatchObject({
        code: 'invalid_dto',
        platform: 'pdd',
      });
    }
    await expect(read(source, envelope(source, rawRow('9007199254740993')))).rejects.toMatchObject({
      code: 'invalid_dto',
      platform: 'pdd',
    });
  },
);

it.each(sources)('[AC-B1-04w-ID#2] %s 转义字段名和指数形式不能绕过无损整数边界', async (source) => {
  await expect(
    read(source, envelope(source, rawRow('9007199254740992', '\\u0067oods_id'))),
  ).resolves.toMatchObject([{ goods_id: '9007199254740992' }]);
  for (const value of ['9007199254740993', '9007199254740993e0', '9.007199254740993e15']) {
    await expect(
      read(source, envelope(source, rawRow(value, '\\u0067oods_id'))),
    ).rejects.toMatchObject({ code: 'invalid_dto', platform: 'pdd' });
  }
});

it.each(sources)(
  '[AC-B1-04w-ID#3] %s 只处理订单本层 goods_id，字符串、嵌套字段及全局解包不受影响',
  async (source) => {
    const custom = '{"goods_id":9007199254740993,"quoted":"\\\"goods_id\\\""}';
    const extra = `,"custom_parameters":${JSON.stringify(custom)},"subsidy_list":[{"goods_id":9007199254740993}],"unknown":{"goods_id":9007199254740993}`;
    const valid = rawRow('9007199254740992').replace(/}$/, `${extra}}`);
    await expect(read(source, envelope(source, valid))).resolves.toMatchObject([
      {
        goods_id: '9007199254740992',
        custom_parameters: custom,
        subsidy_list: [null],
      },
    ]);
    const method = source === 'detail' ? detail : source === 'pay_time' ? range : increment;
    const key = source === 'detail' ? 'order_detail_response' : 'order_list_get_response';
    const opaque = { synthetic_marker: ['untouched', { value: 0 }] };
    const body = JSON.stringify({ [key]: opaque });
    expect(unwrapPddResponse(method, { status: 200, headers: {}, body })).toEqual(opaque);
    const { adapter, transport } = wireSetup(() => body);
    const controller = new AbortController();
    await expect(adapter.request(method, {}, controller.signal)).resolves.toEqual(opaque);
    expect(transport.mock.calls[0]![0].signal).toBe(controller.signal);
    const unrelated = wireSetup(
      () => '{"authority_query_response":{"goods_id":9007199254740993,"bind":1}}',
    );
    await expect(unrelated.adapter.request('pdd.ddk.member.authority.query', {})).resolves.toEqual({
      goods_id: 9007199254740992,
      bind: 1,
    });
    // Leave nested decoys in place: the invalid value belongs to the actual order itself.
    const invalid = rawRow('9007199254740993').replace(/}$/, `${extra}}`);
    await expect(read(source, envelope(source, invalid))).rejects.toMatchObject({
      code: 'invalid_dto',
    });
  },
);

it.each(['increment', 'pay_time'] as const)(
  '[AC-B1-04w-ID#4] %s 每一行独立校验，合法首行不能掩盖后续行的超界商品号',
  async (source) => {
    const body = `{"order_list_get_response":{"order_list":[${rawRow('42')},${rawRow('9007199254740993')}]}}`;
    await expect(read(source, body)).rejects.toMatchObject({
      code: 'invalid_dto',
      platform: 'pdd',
    });
  },
);
