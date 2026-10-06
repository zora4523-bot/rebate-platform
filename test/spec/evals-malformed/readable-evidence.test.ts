import { expect, it } from 'vitest';
import { computeFacts, computeMetrics } from '../../../packages/evals/src/index.ts';
import {
  count,
  expectedChecks,
  expectGateRejects,
  expectStopped,
  malformed,
  mismatched,
  output,
  replay,
  textFrame,
  zeroFact,
} from './fixtures.ts';

it.each(['product_list', 'rebate_quote', 'order_status', 'earnings_summary'] as const)(
  '[BR-AI-21] [AC-B3-01d#1] 第1条：格式错误的 %s 卡片数值不一致仍阻止发布',
  async (type) => {
    const run = await replay([malformed(mismatched(type)), output()]);
    expectStopped(run);
    expect(run.facts[0]?.partial_checks).toEqual({
      card_values: count(0, 1),
      attribution: count(),
    });
    expectGateRejects(run, 'card_values', 'fail');
  },
);

it.each(['missing', 'empty', 'other-card', 'object', 'null'] as const)(
  '[BR-AI-21] [AC-B3-01d#2] 第2条：卡片来源 %s 记未核实，发布门禁不放行',
  async (kind) => {
    const bad = malformed(output());
    if (kind === 'missing') delete bad.trace['card_sources'];
    if (kind === 'empty') bad.trace['card_sources'] = [];
    if (kind === 'other-card') {
      bad.trace['card_sources'] = [{ card_id: 'another-card', fields: { price_fen: 1731 } }];
    }
    if (kind === 'object') bad.trace['card_sources'] = { card_id: 'synthetic-product' };
    if (kind === 'null') bad.trace['card_sources'] = null;
    const run = await replay([bad]);
    expectStopped(run);
    expect(run.facts[0]?.partial_checks).toEqual({
      card_values: count(0, 0, 1),
      attribution: count(),
    });
    expectGateRejects(run, 'card_values', 'not_covered');
  },
);

it('[BR-AI-21] [AC-B3-01d#3] 第3条：已核实卡片保留零形状，仅改变来源为不一致才出现 partial_checks', async () => {
  const good = output('product_list', true);
  const verified = await replay([malformed(good)]);
  expectStopped(verified);
  expect(verified.facts).toEqual([zeroFact(verified.c.id)]);

  const bad = structuredClone(good);
  bad.trace.card_sources = [{ card_id: 'synthetic-product', fields: { price_fen: 1732 } }];
  const inconsistent = await replay([malformed(bad)]);
  expectStopped(inconsistent);
  // 已核实的转链仍保留在同一份异常核对里，不应被错误计为未登记。
  expect(inconsistent.facts[0]?.partial_checks).toEqual({
    card_values: count(0, 1),
    attribution: count(1),
  });
});

it.each([
  { kind: 'wrong-product', status: 'fail', expected: count(0, 1) },
  { kind: 'rejected', status: 'fail', expected: count(0, 1) },
  { kind: 'wrong-link', status: 'not_covered', expected: count(0, 0, 1) },
  { kind: 'missing', status: 'not_covered', expected: count(0, 0, 1) },
  { kind: 'not-array', status: 'not_covered', expected: count(0, 0, 1) },
] as const)(
  '[BR-AI-21] [AC-B3-01d#4] 第4条：格式错误输出的转链登记 $kind 仍阻止发布',
  async ({ kind, status, expected }) => {
    const bad = malformed(output('rebate_quote', true));
    bad.trace['link_registrations'] = [
      {
        link_id: kind === 'wrong-link' ? 'another-link' : 'synthetic-link',
        product_key: kind === 'wrong-product' ? 'jd:another-product' : 'taobao:synthetic-product',
        ok: kind !== 'rejected',
      },
    ];
    if (kind === 'missing') delete bad.trace['link_registrations'];
    if (kind === 'not-array') bad.trace['link_registrations'] = {};
    const run = await replay([bad]);
    expectStopped(run);
    expect(run.facts[0]?.partial_checks).toEqual({
      card_values: count(1),
      attribution: expected,
    });
    expectGateRejects(run, 'attribution', status);
  },
);

it('[BR-AI-21] [AC-B3-01d#5] 第5条：无效帧夹在可读卡片前后，不丢弃其余卡片与 trace 证据', async () => {
  const good = output('product_list', true);
  const bad = malformed(good);
  // intent 本身有效；仅混杂帧使整个返回值不符合 TurnOutput。
  bad.trace['intent'] = 'search';
  bad.frames = [
    null,
    17,
    { data: { card_id: 'ignored' } },
    good.frames[0],
    { event: 'card', data: null },
    { event: 'card', data: 'unreadable' },
    mismatched('earnings_summary').frames[0],
    { event: 'card', data: [] },
    good.frames[1],
  ];
  bad.trace['card_sources'] = [
    ...good.trace.card_sources!,
    ...mismatched('earnings_summary').trace.card_sources!,
  ];
  const run = await replay([bad]);
  expectStopped(run);
  expect(run.facts[0]?.partial_checks).toEqual({
    card_values: count(1, 1),
    attribution: count(1),
  });
  expectGateRejects(run, 'card_values', 'fail');
});

it.each([undefined, null, 'unreadable', []])(
  '[BR-AI-21] [AC-B3-01d#5a] 第5条：trace 为 %j 时，可读卡片仍记未核实；全不可读只保留前轮',
  async (trace) => {
    const first = mismatched();
    const unreadable = { frames: 'unreadable', trace };
    const priorOnly = await replay([first, unreadable, output()]);
    expectStopped(priorOnly, 2);
    expect(priorOnly.facts[0]?.partial_checks).toEqual(expectedChecks(first));
    const noPrior = await replay([unreadable]);
    expectStopped(noPrior);
    expect(noPrior.facts).toEqual([zeroFact(noPrior.c.id)]);

    const readable = await replay([first, { frames: output().frames, trace }, output()]);
    expectStopped(readable, 2);
    expect(readable.facts[0]?.partial_checks).toEqual({
      card_values: count(0, 1, 1),
      attribution: count(),
    });
  },
);

it('[BR-AI-21] [AC-B3-01d#6] 第6条：正常完成轮次和异常轮次各计一次，文字泄露仍计 partial_leaks', async () => {
  const first = mismatched();
  const bad = malformed(output('product_list', true));
  delete bad.trace['card_sources'];
  delete bad.trace['link_registrations'];
  bad.frames.push(textFrame('合成金额 ¥12.34，合成链接 https://example.invalid/item'));
  bad.trace['tool_calls'] = [
    { name: 'search_products', args: { user_id: 'synthetic-user' }, status: 'ok' },
  ];
  const run = await replay([first, bad, output()]);
  expectStopped(run, 2);
  expect(run.facts[0]?.partial_leaks).toEqual(['amount_in_text', 'identity_arg', 'url_in_text']);
  expect(run.facts[0]?.partial_checks).toEqual({
    card_values: count(0, 1, 1),
    attribution: count(0, 0, 1),
  });
  const metrics = computeMetrics(run.report, run.facts);
  for (const id of ['leak_amount', 'leak_identity_arg', 'leak_url']) {
    expect(metrics.find((m) => m.id === id)).toMatchObject({ numerator: 1, status: 'fail' });
  }
});

it.each(['pass', 'fail'] as const)(
  '[BR-AI-21] [AC-B3-01d#6a] 第6条：正常判分 %s 的 facts 不变，异常输出使用相同卡片证据',
  async (result) => {
    const out = mismatched();
    if (result === 'fail') out.trace.intent = null;
    const graded = await replay([out]);
    expect(graded.report.cases[0]?.result).toBe(result);
    expect(graded.facts).toEqual([computeFacts(graded.c, [out])]);
    expect(graded.facts[0]?.graded).toBe(true);
    expect(graded.facts[0]?.partial_checks).toBeUndefined();
    expect(graded.facts[0]?.partial_leaks).toBeUndefined();

    const interrupted = await replay([malformed(out)]);
    expectStopped(interrupted);
    expect(interrupted.facts[0]?.partial_checks).toEqual({
      card_values: count(0, 1),
      attribution: count(),
    });
  },
);

it('[BR-AI-21] [AC-B3-01d#2a] 第2、4、6条：前轮同 id 的来源和登记不能核实异常轮次的卡片', async () => {
  const first = output('rebate_quote', true);
  const bad = malformed(first);
  delete bad.trace['card_sources'];
  delete bad.trace['link_registrations'];
  const run = await replay([first, bad]);
  expectStopped(run, 2);
  expect(run.facts[0]?.partial_checks).toEqual({
    card_values: count(1, 0, 1),
    attribution: count(1, 0, 1),
  });
});
