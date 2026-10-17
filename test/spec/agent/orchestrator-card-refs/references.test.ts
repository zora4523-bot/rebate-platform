import { expect, it } from 'vitest';
import { cardReference, harness, notice, productList, toolCall } from './kit.ts';

it('[AC-B3-05i#1][BR-AI-05][BR-AI-06] 嵌套对象、数组及整值字符串回填实际 SSE 编号，其余投影深比较不变', async () => {
  const r = harness([{ calls: [toolCall('synthetic-nested')] }, {}], [41, 57]);
  r.execute.mockImplementation(async (_call, ctx) => {
    const a = cardReference(ctx, 0);
    const b = cardReference(ctx, 1);
    r.issued.push(a, b);
    return {
      kind: 'ok',
      cards: [notice('合成甲卡'), notice('合成乙卡')],
      modelView: {
        products: [
          {
            card_id: a,
            title: '<untrusted>合成甲</untrusted>',
            platform: 'taobao',
            benefit_tags: [],
          },
          {
            card_id: b,
            title: '<untrusted>合成乙</untrusted>',
            platform: 'jd',
            benefit_tags: ['合成标签'],
          },
        ],
        nested: { refs: [b, { again: a }, [a, b]], empty: {}, nil: null, flag: false },
        ordinary: 'c999',
      },
    };
  });
  expect((await r.run()).ending).toBe('stop');
  expect(r.cards().map((frame) => frame.data['card_id'])).toEqual(['c41', 'c57']);
  expect(r.views(1)).toEqual([
    {
      products: [
        {
          card_id: 'c41',
          title: '<untrusted>合成甲</untrusted>',
          platform: 'taobao',
          benefit_tags: [],
        },
        {
          card_id: 'c57',
          title: '<untrusted>合成乙</untrusted>',
          platform: 'jd',
          benefit_tags: ['合成标签'],
        },
      ],
      nested: {
        refs: ['c57', { again: 'c41' }, ['c41', 'c57']],
        empty: {},
        nil: null,
        flag: false,
      },
      ordinary: 'c999',
    },
  ]);
  expect(r.complete).toHaveBeenCalledTimes(2);
  r.noLeaks();
});

it('[AC-B3-05i#2][BR-AI-05] modelView 根字符串也可引用卡片', async () => {
  const r = harness([{ calls: [toolCall('synthetic-root')] }, {}], [73]);
  r.execute.mockImplementation(async (_call, ctx) => {
    const ref = cardReference(ctx, 0);
    r.issued.push(ref);
    return { kind: 'ok', cards: [notice()], modelView: ref };
  });
  expect((await r.run()).ending).toBe('stop');
  expect(r.views(1)).toEqual(['c73']);
  expect(r.cards().map((frame) => frame.data['card_id'])).toEqual(['c73']);
  r.noLeaks();
});

it('[AC-B3-05i#3][BR-AI-05] 同轮多工具及下一轮工具的本地下标不串号，累计实际编号接续', async () => {
  const r = harness([
    { calls: [toolCall('synthetic-a'), toolCall('synthetic-b')] },
    { calls: [toolCall('synthetic-c')] },
    {},
  ]);
  r.execute.mockImplementation(async (call, ctx) => {
    const count = call.id === 'synthetic-a' ? 2 : 1;
    const refs = Array.from({ length: count }, (_, index) => cardReference(ctx, index));
    r.issued.push(...refs);
    return { kind: 'ok', cards: refs.map(() => notice()), modelView: refs };
  });
  expect((await r.run()).ending).toBe('stop');
  expect(new Set(r.issued).size).toBe(4);
  expect(r.issued.every((token) => !/^c[1-9][0-9]*$/u.test(token))).toBe(true);
  expect(r.cards().map((frame) => frame.data['card_id'])).toEqual(['c1', 'c2', 'c3', 'c4']);
  expect(r.views(1)).toEqual([['c1', 'c2'], ['c3']]);
  expect(r.views(2)).toEqual([['c1', 'c2'], ['c3'], ['c4']]);
  r.noLeaks();
});

it('[AC-B3-05i#4][BR-AI-05] 引用下标对应 outcome.cards，容器内嵌商品消耗的编号不导致后续卡引用错位', async () => {
  const r = harness([{ calls: [toolCall('synthetic-container')] }, {}]);
  r.execute.mockImplementation(async (_call, ctx) => {
    const refs = [cardReference(ctx, 0), cardReference(ctx, 1)];
    r.issued.push(...refs);
    return { kind: 'ok', cards: [productList(2), notice()], modelView: refs };
  });
  expect((await r.run()).ending).toBe('stop');
  expect(r.cards().map((frame) => frame.data['card_id'])).toEqual(['c1', 'c4']);
  expect(r.views(1)).toEqual([['c1', 'c4']]);
  r.noLeaks();
});

it('[AC-B3-05i#5][BR-AI-05] 启用引用的工具之后，未使用引用的工具投影保持原样', async () => {
  const unchanged = {
    products: [
      {
        card_id: 'c812',
        title: '<untrusted>合成旧商品</untrusted>',
        platform: 'jd',
        benefit_tags: [],
      },
    ],
    chunk: { chunk_id: 'synthetic-rule', title: '合成规则标题' },
    values: [null, false, '', [], {}],
  };
  const before = structuredClone(unchanged);
  const r = harness([{ calls: [toolCall('synthetic-ref'), toolCall('synthetic-legacy')] }, {}]);
  r.execute.mockImplementation(async (call, ctx) => {
    if (call.id === 'synthetic-legacy')
      return { kind: 'ok', cards: [notice()], modelView: unchanged };
    const ref = cardReference(ctx, 0);
    r.issued.push(ref);
    return { kind: 'ok', cards: [notice()], modelView: { card_id: ref } };
  });
  expect((await r.run()).ending).toBe('stop');
  expect(r.views(1)).toEqual([{ card_id: 'c1' }, before]);
  expect(unchanged).toEqual(before);
  expect(r.cards()).toHaveLength(2);
  r.noLeaks();
});

it('[AC-B3-05i#6][BR-AI-05] 只有实际签发的占位可替换，伪造同形字符串在任意层保持原样', async () => {
  const r = harness([{ calls: [toolCall('synthetic-forged')] }, {}]);
  let forged = '';
  r.execute.mockImplementation(async (_call, ctx) => {
    const ref = cardReference(ctx, 0);
    r.issued.push(ref);
    // Preserve the documented format and the real call id / index, but change the nonce.
    // This remains syntactically valid and must not be resolved by a regex-only replacer.
    const parts = ref.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('@card-ref');
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/u);
    expect(parts.slice(2)).toEqual(['synthetic-forged', '0']);
    const nonce = parts[1]!;
    forged = `@card-ref:${nonce.startsWith('a') ? 'b' : 'a'}${nonce.slice(1)}:synthetic-forged:0`;
    return {
      kind: 'ok',
      cards: [notice()],
      modelView: { card_id: ref, forged, nested: [forged, { untouched: forged }] },
    };
  });
  expect((await r.run()).ending).toBe('stop');
  expect(r.views(1)).toEqual([{ card_id: 'c1', forged, nested: [forged, { untouched: forged }] }]);
  r.noLeaks();
});

it('[AC-B3-05i#7][BR-AI-05][BR-AI-06] trace 卡片来源不得携带签发占位，成功卡的来源仍可按实际编号关联', async () => {
  const r = harness([{ calls: [toolCall('synthetic-trace')] }, {}], [91]);
  r.execute.mockImplementation(async (_call, ctx) => {
    const ref = cardReference(ctx, 0);
    r.issued.push(ref);
    return {
      kind: 'ok',
      cards: [notice()],
      modelView: { card_id: ref },
      trace: { card_sources: [{ card_id: ref, fields: { source: 'synthetic-source' } }] },
    };
  });
  expect((await r.run()).ending).toBe('stop');
  expect(r.views(1)).toEqual([{ card_id: 'c91' }]);
  expect(r.traces).toHaveLength(1);
  expect(r.traces[0]?.card_sources).toEqual([
    { card_id: 'c91', fields: { source: 'synthetic-source' } },
  ]);
  r.noLeaks();
});

it.each(['rejected', 'failed'] as const)(
  '[AC-B3-05i#8][BR-AI-05] %s outcome 不发卡且投影原样，前一成功调用的引用不会串入',
  async (kind) => {
    const r = harness([{ calls: [toolCall('synthetic-ok'), toolCall('synthetic-error')] }, {}]);
    const view =
      kind === 'rejected'
        ? { error: 'invalid_args' as const }
        : { error: 'synthetic-failure', nested: ['c123', null] };
    r.execute.mockImplementation(async (call, ctx) => {
      if (call.id === 'synthetic-error') {
        // Extra cards are deliberately present at the trust boundary: kind controls emission.
        if (kind === 'rejected')
          return { kind, modelView: { error: 'invalid_args' }, cards: [notice('不应发出')] };
        return { kind, modelView: view, cards: [notice('不应发出')] };
      }
      const ref = cardReference(ctx, 0);
      r.issued.push(ref);
      return { kind: 'ok', cards: [notice()], modelView: { card_id: ref } };
    });
    expect((await r.run()).ending).toBe('stop');
    expect(r.cards().map((frame) => frame.data['card_id'])).toEqual(['c1']);
    expect(r.views(1)).toEqual([{ card_id: 'c1' }, view]);
    expect(r.traces[0]?.tool_calls.map((call) => call.status)).toEqual(['ok', kind]);
    r.noLeaks();
  },
);
