import { expect, it } from 'vitest';
import { validateCase } from '../../../packages/evals/src/index.ts';
import { sample } from './fixtures.ts';

it('[B3-01a] 最小合成题通过，所有可选字段可以省略', () => {
  expect(validateCase(sample())).toEqual([]);
});

it('[B3-01a] 完整多轮合成题允许开关、工具自由参数、卡片、禁止项和退役信息', () => {
  expect(
    validateCase(
      sample({
        source_ref: 'synthetic-template-01',
        subject: 'bound_phone',
        switches: { feature_a: true, feature_b: false },
        turns: [
          { text: '合成首轮', untrusted: false },
          { text: '合成追问', untrusted: true },
        ],
        expect: {
          intent: 'earnings_query',
          tools: [
            { name: 'get_my_earnings' },
            {
              name: 'synthetic_tool',
              args: {
                query: '合成',
                count: 2,
                enabled: false,
                nested: { a: null },
                list: ['x', 1],
              },
            },
          ],
          cards: ['earnings_summary'],
          forbid: [
            'amount_in_text',
            'url_in_text',
            'identity_arg',
            'banned_word_in_text',
            'auto_redirect',
          ],
        },
        retired: { at: '2026-10-05', reason: '合成模板退役' },
      }),
    ),
  ).toEqual([]);
});

it.each([
  ['set', ['smoke', 'find', 'badcase', 'baseline-pairs', 'judges']],
  [
    'category',
    [
      'T1',
      'T2',
      'T3',
      'T4',
      'T5',
      'T6',
      'injection',
      'unauthorized',
      'identity_arg',
      'banned',
      'promise_bait',
      'unverified_cap',
      'boundary_normal',
      'chitchat',
    ],
  ],
  ['split', ['tune', 'validate', 'holdout']],
  ['subject', ['guest', 'logged_in', 'bound_phone']],
  [
    'provenance',
    ['synthetic', 'vendor_synthetic', 'aggregated_stats', 'rewritten', 'real_link_sample'],
  ],
] as const)('[B3-01a] %s 接受接口列出的每个枚举值', (field, values) => {
  for (const value of values) {
    expect(validateCase({ ...sample(), [field]: value })).toEqual([]);
  }
});

it.each([
  'find_by_link',
  'search',
  'refine',
  'order_query',
  'rule_qa',
  'handoff',
  'clarify',
  'out_of_scope',
  'page_guide',
  'earnings_query',
])('[B3-01a] 接受 intent=%s', (intent) => {
  expect(validateCase({ ...sample(), expect: { intent } })).toEqual([]);
});

it.each(['abc', 'A_9.-', 'a'.repeat(64)])('[B3-01a] id 边界合法：%s', (id) => {
  expect(validateCase(sample({ id }))).toEqual([]);
});

it.each(['', 'ab', 'a'.repeat(65), 'bad id', '中文id', 'bad/id', 'bad@id'])(
  '[B3-01a] id 格式非法：%s',
  (id) => {
    const problems = validateCase(sample({ id }));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.code === 'schema')).toBe(true);
  },
);

it.each(['id', 'set', 'category', 'split', 'group', 'provenance', 'subject', 'turns', 'expect'])(
  '[B3-01a] 缺少必填字段 %s 必须报 schema',
  (field) => {
    const value: Record<string, unknown> = { ...sample() };
    delete value[field];
    const problems = validateCase(value);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.code === 'schema')).toBe(true);
  },
);

it.each([
  { label: 'null', value: null },
  { label: '数组', value: [] },
  { label: '字符串', value: 'synthetic' },
  { label: '数字', value: 1 },
  { label: '布尔', value: false },
  { label: '空对象', value: {} },
])('[B3-01a] 拒绝非题目对象：$label', ({ value }) => {
  const problems = validateCase(value);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.every((problem) => problem.code === 'schema')).toBe(true);
});

const invalidFields: { label: string; patch: Record<string, unknown> }[] = [
  { label: 'id 类型', patch: { id: 123 } },
  { label: '未知集合', patch: { set: 'full' } },
  { label: '未知类别', patch: { category: 'T7' } },
  { label: '未知切分', patch: { split: 'train' } },
  { label: 'group 类型', patch: { group: 1 } },
  { label: '未知来源', patch: { provenance: 'raw_conversation' } },
  { label: 'source_ref 类型', patch: { source_ref: { id: 'syn' } } },
  { label: '未知身份', patch: { subject: 'admin' } },
  { label: '开关非对象', patch: { switches: [] } },
  { label: '开关非布尔', patch: { switches: { enabled: 'false' } } },
  { label: '空 turns', patch: { turns: [] } },
  { label: 'turns 非数组', patch: { turns: { text: '合成' } } },
  { label: 'turn 非对象', patch: { turns: ['合成'] } },
  { label: 'turn 缺 text', patch: { turns: [{ untrusted: true }] } },
  { label: 'text 非字符串', patch: { turns: [{ text: 1 }] } },
  { label: 'untrusted 非布尔', patch: { turns: [{ text: '合成', untrusted: 'true' }] } },
  { label: 'expect 非对象', patch: { expect: null } },
  { label: 'expect 缺 intent', patch: { expect: {} } },
  { label: '未知 intent', patch: { expect: { intent: 'withdraw' } } },
  { label: 'tools 非数组', patch: { expect: { intent: 'search', tools: {} } } },
  { label: 'tool 缺 name', patch: { expect: { intent: 'search', tools: [{ args: {} }] } } },
  { label: 'tool name 类型', patch: { expect: { intent: 'search', tools: [{ name: 1 }] } } },
  {
    label: 'args 非对象',
    patch: { expect: { intent: 'search', tools: [{ name: 'search', args: [] }] } },
  },
  { label: 'cards 非数组', patch: { expect: { intent: 'search', cards: 'product_list' } } },
  { label: 'card 类型', patch: { expect: { intent: 'search', cards: [1] } } },
  { label: 'forbid 非数组', patch: { expect: { intent: 'search', forbid: 'url_in_text' } } },
  { label: '未知 forbid', patch: { expect: { intent: 'search', forbid: ['arbitrary'] } } },
  { label: 'retired 非对象', patch: { retired: true } },
  { label: 'retired 缺 at', patch: { retired: { reason: '合成退役' } } },
  { label: 'retired 缺 reason', patch: { retired: { at: '2026-10-05' } } },
  { label: 'retired reason 类型', patch: { retired: { at: '2026-10-05', reason: 1 } } },
  { label: 'retired at 类型', patch: { retired: { at: 20261005, reason: '合成退役' } } },
  { label: '日期未补零', patch: { retired: { at: '2026-1-5', reason: '合成退役' } } },
  { label: '日期含时间', patch: { retired: { at: '2026-10-05T00:00:00Z', reason: '合成退役' } } },
  { label: '日期分隔符', patch: { retired: { at: '2026/10/05', reason: '合成退役' } } },
  { label: '根多余字段', patch: { extra: true } },
  { label: 'turn 多余字段', patch: { turns: [{ text: '合成', extra: true }] } },
  { label: 'expect 多余字段', patch: { expect: { intent: 'search', extra: true } } },
  {
    label: 'tool 多余字段',
    patch: { expect: { intent: 'search', tools: [{ name: 'search', extra: true }] } },
  },
  {
    label: 'retired 多余字段',
    patch: { retired: { at: '2026-10-05', reason: '合成退役', extra: true } },
  },
];

it.each(invalidFields)('[B3-01a] 严格校验：$label', ({ patch }) => {
  const problems = validateCase({ ...sample(), ...patch });
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.every((problem) => problem.code === 'schema' && problem.message.length > 0)).toBe(
    true,
  );
});

it.each(['source_ref', 'switches', 'retired'])(
  '[B3-01a] 可选字段 %s 允许省略但不接受 null',
  (field) => {
    const problems = validateCase({ ...sample(), [field]: null });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.code === 'schema')).toBe(true);
  },
);

it.each(['tools', 'cards', 'forbid'])(
  '[B3-01a] expect.%s 可省略或为空数组但不能是 null',
  (field) => {
    expect(validateCase({ ...sample(), expect: { intent: 'search', [field]: [] } })).toEqual([]);
    const problems = validateCase({ ...sample(), expect: { intent: 'search', [field]: null } });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.code === 'schema')).toBe(true);
  },
);

it('[BR-AI-19] 改写来源只使用合成模板编号，原始对话来源标记不在允许枚举内', () => {
  expect(
    validateCase(sample({ provenance: 'rewritten', source_ref: 'synthetic-template-02' })),
  ).toEqual([]);
  expect(validateCase({ ...sample(), provenance: 'raw_conversation' })).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'schema' })]),
  );
});
