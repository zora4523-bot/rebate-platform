import { expect, it } from 'vitest';
import {
  authorityUrlMethod,
  convertMethod,
  ctx,
  custom,
  identity,
  invoke,
  operations,
  queryMethod,
  req,
  setup,
  successReply,
  TestIdentity,
} from './kit.ts';

it('[AC-B1-04h-REQ#1] 转链一次一个 goods_sign、当前推广位、单人团且请求 scheme 与短链', async () => {
  const h = setup(successReply('convert'));
  const signal = new AbortController().signal;
  await h.adapter.convert(req, identity, { ...ctx, signal });
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({
    type: convertMethod,
    p_id: identity.claims.promotionSlot,
    goods_sign_list: JSON.stringify([req.item.goods_sign]),
    custom_parameters: JSON.stringify(custom),
    multi_group: false,
    generate_schema_url: true,
    generate_short_url: true,
  });
  for (const key of ['search_id', 'sku_id_code_list', 'goods_id', 'user_id', 'idempotencyKey']) {
    expect(h.requests[0]).not.toHaveProperty(key);
  }
  expect(h.transport.mock.calls[0]![0].signal).toBe(signal);
  expect(h.queryIdentity).not.toHaveBeenCalled();
  expect(JSON.stringify(h.requests)).not.toContain(identity.claims.userId);
});

it.each(operations)(
  '[AC-B1-04h-REQ#2] %s 原样序列化键序与 lk，不从 userId 重建 uid',
  async (operation) => {
    const parameters = { lk: 'link-synth', sc: 's', uid: 'attr-synth', app: 'n' };
    const who = new TestIdentity(parameters);
    const h = setup(successReply(operation));
    await invoke(h.adapter, operation, who);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.custom_parameters).toBe(JSON.stringify(parameters));
    expect(who.custom_parameters).toEqual(parameters);
    expect(h.queryIdentity).not.toHaveBeenCalled();
    expect(JSON.stringify(h.requests)).not.toContain(who.claims.userId);
  },
);

it.each(operations)('[AC-B1-04h-REQ#3] %s no_rebate 无 uid 时不补用户归属', async (operation) => {
  const who = new TestIdentity({ sc: 's', app: 'n', lk: 'link-synth' });
  const h = setup(successReply(operation));
  await invoke(h.adapter, operation, who);
  expect(h.requests[0]!.custom_parameters).toBe('{"sc":"s","app":"n","lk":"link-synth"}');
  expect(JSON.stringify(h.requests)).not.toContain(who.claims.userId);
});

// JSON 固定开销 29 字节；同时覆盖 UTF-8 多字节与 JSON 转义后的长度。
it.each(operations)(
  '[AC-B1-04h-REQ#4] %s 接受序列化后恰好 64 字节且不改变内容',
  async (operation) => {
    for (const uid of ['a'.repeat(35), '汉'.repeat(11) + 'ab', '"'.repeat(17) + 'a']) {
      const who = new TestIdentity({ app: 'n', uid, sc: 's' });
      const text = JSON.stringify(who.custom_parameters);
      expect(Buffer.byteLength(text, 'utf8')).toBe(64);
      const h = setup(successReply(operation));
      await invoke(h.adapter, operation, who);
      expect(h.requests[0]!.custom_parameters).toBe(text);
    }
  },
);

it.each(operations)(
  '[AC-B1-04h-REQ#5] %s 超过 64 字节报 invalid_dto，不截断或发送',
  async (operation) => {
    for (const uid of ['a'.repeat(36), '汉'.repeat(12), '"'.repeat(18)]) {
      const who = new TestIdentity({ app: 'n', uid, sc: 's' });
      expect(Buffer.byteLength(JSON.stringify(who.custom_parameters), 'utf8')).toBe(65);
      const h = setup(successReply(operation));
      await expect(invoke(h.adapter, operation, who)).rejects.toMatchObject({
        code: 'invalid_dto',
        platform: 'pdd',
      });
      expect(h.transport).not.toHaveBeenCalled();
      expect(h.credentials).not.toHaveBeenCalled();
    }
  },
);

it('[AC-B1-04h-REQ#6] 同一 uid 在自购位与分享位分别转链、查询、生成备案链接', async () => {
  for (const promotionSlot of ['synthetic-self-pid', 'synthetic-share-pid']) {
    const who = new TestIdentity(custom, { promotionSlot });
    const convert = setup(successReply('convert'));
    await convert.adapter.convert(req, who, ctx);
    expect(convert.requests).toHaveLength(1);
    expect(convert.requests[0]).toMatchObject({
      type: convertMethod,
      p_id: promotionSlot,
      custom_parameters: JSON.stringify(custom),
    });
    const query = setup(successReply('queryPddAuthority'));
    await query.adapter.queryPddAuthority(who, ctx);
    expect(query.requests).toHaveLength(1);
    expect(query.requests[0]).toMatchObject({
      type: queryMethod,
      pid: promotionSlot,
      custom_parameters: JSON.stringify(custom),
    });
    expect(query.requests[0]).not.toHaveProperty('p_id');
    const url = setup(successReply('pddAuthorityUrl'));
    await url.adapter.pddAuthorityUrl(who, ctx);
    expect(url.requests).toHaveLength(1);
    expect(url.requests[0]).toMatchObject({
      type: authorityUrlMethod,
      channel_type: 10,
      p_id_list: JSON.stringify([promotionSlot]),
      custom_parameters: JSON.stringify(custom),
    });
    expect(query.queryIdentity).not.toHaveBeenCalled();
    expect(url.queryIdentity).not.toHaveBeenCalled();
    expect(convert.queryIdentity).not.toHaveBeenCalled();
  }
});
