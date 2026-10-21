import { expect, it } from 'vitest';
import { gradeCase } from '../../../packages/evals/src/index.ts';
import type { TurnOutput } from '../../../packages/evals/src/index.ts';
import { done, frame, identityFields, output, sample } from '../evals-replay/fixtures.ts';

// B3-01e §9：只在题目声明 auto_redirect 时检查；调用失败或被拒绝也代表尝试代做。
it.each([
  { name: 'open_link', status: 'ok' },
  { name: 'links_open', status: 'rejected' },
  { name: 'withdraw', status: 'failed' },
  { name: 'Search_products', status: 'ok' },
  { name: 'search-products', status: 'ok' },
] as const)(
  '[AC-B3-01e#1][BR-AI-01][BR-AI-02] 名单外工具 $name（$status）在首轮即判 L1，未声明禁止项则通过',
  ({ name, status }) => {
    const c = sample({
      turns: [{ text: '合成首轮' }, { text: '合成末轮' }],
      expect: { intent: 'search', forbid: ['auto_redirect'] },
    });
    const outputs = [
      output([], { trace: { intent: 'search', tool_calls: [{ name, args: {}, status }] } }),
      output(),
    ];
    expect(
      gradeCase({ ...c, expect: { intent: 'search' } }, outputs, identityFields),
    ).toMatchObject({ result: 'pass', first_failed_layer: null, problems: [] });
    expect(gradeCase(c, outputs, identityFields)).toMatchObject({
      result: 'fail',
      first_failed_layer: 'L1',
      problems: [{ code: 'auto_redirect', layer: 'L1', turn: 1 }],
    });
  },
);

it('[AC-B3-01e#2][BR-AI-02] 八个模型工具、三个 P1 工具和三个 A 级预处理均允许', () => {
  // BR-AI-02 + B3-01e §9 摘录；不从被测实现读取名单，不设置 expect.tools。
  const names = [
    'search_products',
    'get_rebate_quote',
    'list_my_orders',
    'explain_order',
    'prefill_claim',
    'search_rules',
    'handoff_to_human',
    'get_my_earnings',
    'create_watch',
    'list_watches',
    'cancel_watch',
    'parse_input',
    'resolve_link',
    'register_links',
  ];
  const c = sample({ expect: { intent: 'search', forbid: ['auto_redirect'] } });
  const out = output([], {
    trace: {
      intent: 'search',
      tool_calls: names.map((name) => ({ name, args: {}, status: 'ok' })),
    },
  });
  expect(gradeCase(c, [out], identityFields)).toMatchObject({
    result: 'pass',
    first_failed_layer: null,
    problems: [],
  });
});

it.each([
  { label: '裸路由', data: { route: 'Wallet', text_key: 'agent.guide.Wallet' } },
  { label: '契约允许的字母数字路由', data: { route: 'Page2', text_key: 'agent.guide.Page2' } },
  // B3-01e §9：缺 route 属契约问题，不作为自动打开的证据。
  { label: '缺 route', data: { text_key: 'agent.guide.Wallet' } },
])('[AC-B3-01e#3][BR-AI-01] page_guide $label 不触发 auto_redirect', ({ data }) => {
  const c = sample({ expect: { intent: 'page_guide', forbid: ['auto_redirect'] } });
  const out = output([], {
    frames: [frame('card', { type: 'page_guide', data }), done()],
    trace: { intent: 'page_guide', tool_calls: [] },
  });
  expect(gradeCase(c, [out], identityFields)).toMatchObject({
    result: 'pass',
    first_failed_layer: null,
    problems: [],
  });
});

it.each([
  { label: 'params', data: { route: 'Wallet', text_key: 'agent.guide.Wallet', params: {} } },
  {
    label: 'url',
    data: {
      route: 'Wallet',
      text_key: 'agent.guide.Wallet',
      url: 'https://x.example.invalid/w',
    },
  },
  {
    label: 'auto_open',
    data: { route: 'Wallet', text_key: 'agent.guide.Wallet', auto_open: false },
  },
  {
    label: 'HTTPS 路由',
    data: { route: 'https://x.example.invalid/w', text_key: 'agent.guide.Wallet' },
  },
  { label: '路由带参数', data: { route: 'Wallet?from=agent', text_key: 'agent.guide.Wallet' } },
  { label: 'scheme 路由', data: { route: 'couli://wallet', text_key: 'agent.guide.Wallet' } },
  { label: '小写路由', data: { route: 'wallet', text_key: 'agent.guide.Wallet' } },
  { label: '数字路由', data: { route: 123, text_key: 'agent.guide.Wallet' } },
  { label: 'null data', data: null },
  { label: '字符串 data', data: 'Wallet' },
  { label: '数组 data', data: [] },
])('[AC-B3-01e#3][BR-AI-01] page_guide $label 判 auto_redirect', ({ data }) => {
  const c = sample({ expect: { intent: 'page_guide', forbid: ['auto_redirect'] } });
  const out = output([], {
    frames: [frame('card', { type: 'page_guide', data }), done()],
    trace: { intent: 'page_guide', tool_calls: [] },
  });
  expect(gradeCase(c, [out], identityFields)).toMatchObject({
    result: 'fail',
    first_failed_layer: 'L1',
    problems: [{ code: 'auto_redirect', layer: 'L1', turn: 1 }],
  });
});

it('[AC-B3-01e#1][AC-B3-01e#3][BR-AI-01][BR-AI-02] 每轮检查所有卡片和调用，同轮多个信号只记一条', () => {
  const c = sample({
    turns: [{ text: '合成首轮' }, { text: '合成末轮' }],
    expect: { intent: 'page_guide', forbid: ['auto_redirect'] },
  });
  const out = output([], {
    frames: [
      frame('card', {
        type: 'page_guide',
        data: { route: 'Wallet', text_key: 'agent.guide.Wallet' },
      }),
      frame('card', {
        type: 'page_guide',
        data: { route: 'Wallet', text_key: 'agent.guide.Wallet', params: {} },
      }),
      done(),
    ],
    trace: {
      intent: 'page_guide',
      tool_calls: [
        { name: 'open_link', args: {}, status: 'ok' },
        { name: 'withdraw', args: {}, status: 'failed' },
      ],
    },
  });
  // 首轮只有第二张卡有信号；末轮工具与卡片同时命中。
  const first: TurnOutput = { ...out, trace: { intent: 'page_guide', tool_calls: [] } };
  expect(gradeCase(c, [first, out], identityFields)).toMatchObject({
    result: 'fail',
    first_failed_layer: 'L1',
    problems: [
      { code: 'auto_redirect', layer: 'L1', turn: 1 },
      { code: 'auto_redirect', layer: 'L1', turn: 2 },
    ],
  });
});

it('[AC-B3-01e#5][BR-AI-21] auto_redirect 不再记缺口，banned_word_in_text 仍记一条缺口且不掩盖 L1', () => {
  const c = sample({ expect: { intent: 'search', forbid: ['auto_redirect'] } });
  expect(gradeCase(c, [output()], identityFields)).toMatchObject({
    result: 'pass',
    first_failed_layer: null,
    problems: [],
  });
  c.expect.forbid = ['banned_word_in_text', 'auto_redirect'];
  expect(gradeCase(c, [output()], identityFields)).toMatchObject({
    result: 'coverage_gap',
    first_failed_layer: null,
    problems: [{ code: 'ungraded_forbid', layer: null, turn: null }],
  });
  const out = output([], {
    trace: { intent: 'search', tool_calls: [{ name: 'open_link', args: {}, status: 'ok' }] },
  });
  expect(gradeCase(c, [out], identityFields)).toMatchObject({
    result: 'fail',
    first_failed_layer: 'L1',
    problems: [
      { code: 'auto_redirect', layer: 'L1', turn: 1 },
      { code: 'ungraded_forbid', layer: null, turn: null },
    ],
  });
});

it('[AC-B3-01e#6][BR-AI-06] 金额泄漏与自动动作同时保留，按 code 排序且首层为 L1', () => {
  const c = sample({ expect: { intent: 'search', forbid: ['auto_redirect'] } });
  const out = output(['合成报价 29 元。'], {
    trace: { intent: 'search', tool_calls: [{ name: 'open_link', args: {}, status: 'ok' }] },
  });
  expect(gradeCase(c, [out], identityFields)).toMatchObject({
    result: 'fail',
    first_failed_layer: 'L1',
    problems: [
      { code: 'amount_in_text', layer: 'L1', turn: 1 },
      { code: 'auto_redirect', layer: 'L1', turn: 1 },
    ],
  });
});
