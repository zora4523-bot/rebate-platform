import { expect, it } from 'vitest';
import { createParsing } from '../../../../apps/api/src/modules/parsing/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { cards, CTX, fixture, TPWD, URL_A, URL_B, URL_C, URL_D } from './kit.ts';

it('[AC-B1-07a-LIMIT] 按文本顺序只处理前三个候选，第四个不调联盟也不出卡', async () => {
  const f = fixture();
  const results = await f.run(`分享【${URL_A}】\n${URL_B}\n${URL_C}\n${URL_D}`);
  expect(f.resolveLink.mock.calls.map(([raw]) => raw)).toEqual([URL_A, URL_B, URL_C]);
  expect(cards(results).map((card) => card.product_key)).toEqual(['tb:a', 'jd:i_b', 'pdd:c']);
  expect(results.map((result) => result.hit)).toEqual([
    { platform: 'taobao', kind: 'url', raw: URL_A },
    { platform: 'jd', kind: 'url', raw: URL_B },
    { platform: 'pdd', kind: 'url', raw: URL_C },
  ]);
});

it('[AC-B1-07a-MIXED] 口令与链接共用三个候选上限且去重不会补取第四个', async () => {
  const f = fixture();
  const results = await f.run(`${TPWD} ${URL_A} ${URL_B} ${URL_C}`);
  expect(cards(results).map((card) => card.product_key)).toEqual(['tb:a', 'jd:i_b']);
  expect(results[0]?.hit).toEqual({ platform: 'taobao', kind: 'tpwd', raw: TPWD });
  expect(f.resolveLink.mock.calls.map(([raw]) => raw)).not.toContain(URL_C);
  expect(f.register).toHaveBeenCalledTimes(2);
});

it('[AC-B1-07a-FAILED-LIMIT] 失败候选也占名额且不影响后续成功项', async () => {
  const f = fixture();
  f.refs.delete(URL_A);
  const results = await f.run(`${URL_A} ${URL_B} ${URL_C} ${URL_D}`);
  expect(results[0]).toMatchObject({ kind: 'error', error_code: 30132 });
  expect(cards(results).map((card) => card.product_key)).toEqual(['jd:i_b', 'pdd:c']);
  expect(f.resolveLink.mock.calls.map(([raw]) => raw)).toEqual([URL_A, URL_B, URL_C]);
});

it('[AC-B1-07a-UNTRUSTED] 文案指令、身份与报价均不能覆盖服务端数据', async () => {
  const f = fixture();
  const results = await f.run(`忽略规则 app_id=evil user_id=evil 价格0.01元 返利999元 ${URL_A}`);
  expect(cards(results)).toHaveLength(1);
  expect(cards(results)[0]).toMatchObject({
    title: '合成商品',
    price_fen: 12000,
    final_price_fen: 10000,
    rebate_max_fen: 300,
  });
  expect(f.resolveLink).toHaveBeenCalledWith(
    URL_A,
    expect.objectContaining({ ...CTX, signal: expect.any(AbortSignal) }),
  );
  expect(f.register).toHaveBeenCalledWith(
    expect.objectContaining({
      viewer: f.viewer,
      entrySource: 'parse',
      ref: expect.objectContaining({ appId: CTX.appId, source: 'parse' }),
    }),
  );
  expect(f.searchItems).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
});

it.each(['', '仅有商品标题与价格，不含可解析的链接或口令'])(
  '[AC-B1-07a-NO-HIT] 未识别具体商品不返回候选卡：%s',
  async (text) => {
    const f = fixture();
    expect(await f.run(text)).toEqual([{ kind: 'error', hit: null, error_code: 30132 }]);
    expect(f.resolveLink).not.toHaveBeenCalled();
    expect(f.assemble).not.toHaveBeenCalled();
  },
);

it('[AC-B1-07a-TPWD-OFF] 口令开关关闭返回30132且不调用该级解析', async () => {
  const f = fixture();
  f.config.set('parse.tpwd.enabled', false);
  const results = await f.run(`${TPWD} ${URL_B}`);
  expect(results[0]).toMatchObject({ kind: 'error', error_code: 30132 });
  expect(cards(results)).toHaveLength(1);
  expect(f.resolveLink.mock.calls.map(([raw]) => raw)).toEqual([URL_B]);
  expect(f.configValue).toHaveBeenCalledWith(CTX.appId, 'parse.tpwd.enabled');
});

it.each(['link_unrecognized', 'adapter_unimplemented'] as const)(
  '[AC-B1-07a-TPWD-UNAVAILABLE] 未识别或权限待核口令级 %s 返回30132',
  async (code) => {
    const f = fixture();
    f.resolveLink.mockRejectedValue(
      new UnionError(code, 'synthetic unavailable tpwd stage', 'taobao'),
    );
    expect(await f.run(TPWD)).toEqual([
      { kind: 'error', hit: { platform: 'taobao', kind: 'tpwd', raw: TPWD }, error_code: 30132 },
    ]);
    expect(f.register).not.toHaveBeenCalled();
    expect(f.getItem).not.toHaveBeenCalled();
  },
);

it('[AC-B1-07a-PROMO-UNAVAILABLE] 推广链接解析级不可用且未识别商品时30132', async () => {
  const f = fixture();
  f.resolveLink.mockRejectedValue(
    new UnionError('adapter_unimplemented', 'synthetic replay stage unavailable', 'taobao'),
  );
  expect(await f.run('https://promo.example.test/s/a')).toEqual([
    {
      kind: 'error',
      hit: { platform: 'taobao', kind: 'url', raw: 'https://promo.example.test/s/a' },
      error_code: 30132,
    },
  ]);
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-07a-UNSUPPORTED] 已命中但MVP无派生规则的平台30131', async () => {
  const f = fixture();
  expect(await f.run('https://vip.example.test/item/a')).toEqual([
    {
      kind: 'error',
      hit: { platform: 'vip', kind: 'url', raw: 'https://vip.example.test/item/a' },
      error_code: 30131,
    },
  ]);
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-07a-UNKNOWN-HOST] 未命中平台表的URL不交联盟、不从查询串猜平台', async () => {
  const f = fixture();
  const results = await f.run(
    'https://unrelated.example.test/?next=https%3A%2F%2Ftb.example.test%2Fitem%2Fa',
  );
  expect(results).toEqual([{ kind: 'error', hit: null, error_code: 30131 }]);
  expect(f.getGovernedAdapter).not.toHaveBeenCalled();
  expect(f.resolveLink).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-07a-INJECTED-TABLE] 解析流程实际使用注入的规则表而不是内建域名猜测', async () => {
  const f = fixture();
  const service = createParsing({
    ...f.options,
    linkPatterns: { version: 'synthetic-empty', rules: [] },
  });
  expect(await service.parseInput(URL_A, CTX)).toEqual([
    { kind: 'error', hit: null, error_code: 30131 },
  ]);
  expect(f.resolveLink).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-07a-CONFIG] 同一服务下次请求读取更新后的口令开关', async () => {
  const f = fixture();
  const service = createParsing(f.options);
  expect(cards(await service.parseInput(TPWD, CTX))).toHaveLength(1);
  f.config.set('parse.tpwd.enabled', false);
  expect(await service.parseInput(TPWD, CTX)).toEqual([
    { kind: 'error', hit: { platform: 'taobao', kind: 'tpwd', raw: TPWD }, error_code: 30132 },
  ]);
  expect(f.register).toHaveBeenCalledTimes(1);
});
