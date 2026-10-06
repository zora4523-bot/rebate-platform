import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import * as enums from '../../../../packages/contracts-ts/src/enums.gen.ts';
import * as bridge from '../../../../packages/contracts-ts/src/bridge.gen.ts';

// CT-08b §9: wire contracts and fixture consistency only. Runtime classification,
// identity filtering, persistence and pending_action guards belong to later tasks.
type ObjectValue = Record<string, unknown>;
type Frame = { event: string; id: number; data: ObjectValue };
type Validator = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): Validator;
}

const root = new URL('../../../../', import.meta.url);
const guideRoutes = [
  'Wallet',
  'WithdrawRecords',
  'AuthManage',
  'OrderList',
  'InviteShare',
  'Messages',
];
const oldFixtures = [
  'normal',
  'tool-failed',
  'cancelled',
  'disconnected',
  'unknown-card',
  'error',
  'fallback',
];
const newFixtures = [
  'normal-page-guide',
  'normal-earnings',
  'normal-earnings-history',
  'unknown-card-page-guide',
];
const allFixtures = [...oldFixtures, ...newFixtures];
const actions = [
  { route: 'Wallet', text_key: 'agent.earnings.open_wallet' },
  { route: 'WithdrawRecords', text_key: 'agent.earnings.open_records' },
];
const asOf = '2026-10-06T10:00:00+08:00';
const latestWithdrawal = { title_key: 'withdraw_status.PENDING.title', amount_fen: 10000 };
const realtime: ObjectValue = {
  as_of: asOf,
  withdrawable_fen: 12345,
  estimated_total_fen: 23456,
  next_credit_period: '2026-11',
  credit_overdue: false,
  latest_withdrawal: latestWithdrawal,
  actions,
};
const history: ObjectValue = { as_of: asOf, actions };

function object(value: unknown): ObjectValue {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as ObjectValue;
}

function readText(path: string): string {
  const url = new URL(path, root);
  expect(existsSync(url), `缺少 ${path}`).toBe(true);
  let text = '';
  expect(() => {
    text = readFileSync(url, 'utf8');
  }, `无法读取 ${path}`).not.toThrow();
  return text;
}

function parseObject(text: string): ObjectValue {
  let value: unknown;
  expect(() => {
    value = JSON.parse(text) as unknown;
  }, 'JSON 必须合法').not.toThrow();
  return object(value);
}

function readObject(path: string): ObjectValue {
  return parseObject(readText(path));
}

function validators(definition?: string): { frame: Validator; selected: Validator } {
  const schema = readObject('contracts/agent-stream.schema.json');
  const name = definition ?? 'ping';
  expect(object(schema['$defs'])[name], `缺少 $defs/${name}`).toBeDefined();
  const apiRequire = createRequire(new URL('apps/api/package.json', root));
  const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
    Ajv2020: new (options: { strict: true; allErrors: true }) => AjvInstance;
  };
  const addFormats = apiRequire('ajv-formats') as (ajv: AjvInstance) => void;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  let frame: Validator | undefined;
  let selected: Validator | undefined;
  expect(() => {
    frame = ajv.compile(schema);
    selected = ajv.compile({
      $schema: schema['$schema'],
      $defs: schema['$defs'],
      $ref: `#/$defs/${name}`,
    });
  }, 'Schema 必须可由 Ajv2020 strict 编译').not.toThrow();
  expect(frame).toBeTypeOf('function');
  expect(selected).toBeTypeOf('function');
  return { frame: frame!, selected: selected! };
}

function check(validate: Validator, value: unknown, expected: boolean): void {
  expect(validate(value), JSON.stringify({ value, errors: validate.errors })).toBe(expected);
}

function card(type: string, data: ObjectValue): Frame {
  return {
    event: 'card',
    id: 2,
    data: {
      seq: 2,
      card_id: 'c1',
      type,
      schema_version: 1,
      data,
      fallback_text: '请到对应页面查看最新信息。',
    },
  };
}

function without(value: ObjectValue, key: string): ObjectValue {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function routes(): ObjectValue {
  return object(readObject('contracts/routes.json')['routes']);
}

// ops.yaml uses two-space enum names and six-space value keys.
// Read the source too: generated exports alone must not hide a stale source enum.
function sourceEnum(name: string): string[] {
  const lines = readText('contracts/enums/ops.yaml').split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `缺少源枚举 ${name}`).toBeGreaterThanOrEqual(0);
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^  \S/u.test(line)) break;
    const match = /^      ([A-Za-z0-9_]+):/u.exec(line);
    if (match?.[1]) values.push(match[1]);
  }
  return values;
}

it.each([
  [
    'agent_intent',
    [
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
    ],
  ],
  [
    'agent_card_type',
    [
      'product_list',
      'rebate_quote',
      'order_status',
      'claim_draft',
      'handoff',
      'auth_required',
      'notice',
      'rule_ref',
      'page_guide',
      'earnings_summary',
    ],
  ],
  [
    'page_guide_reject_reason',
    ['not_allowed', 'extra_fields', 'disabled', 'untrusted_input', 'params_requested'],
  ],
] as const)(
  '[CT-08b] [BR-AI-01] [BR-AI-18] %s 源枚举与生成枚举恰好为规定集合',
  (name, expected) => {
    expect(sourceEnum(name).sort()).toEqual([...expected].sort());
    const generated = (enums as ObjectValue)[name];
    expect(generated, `缺少生成枚举 ${name}`).toBeDefined();
    expect(Array.isArray(generated)).toBe(true);
    expect([...(generated as string[])].sort()).toEqual([...expected].sort());
  },
);

it('[CT-08b] [BR-AI-01] [BR-ID-10] 仅六条路由允许 Agent 引导且入口恰为 in_app、push', () => {
  const entries = Object.entries(routes());
  const enabled = entries.filter(([, value]) => object(value)['agent_guide'] === true);
  expect(enabled.map(([name]) => name).sort()).toEqual([...guideRoutes].sort());
  for (const [, value] of entries) {
    const route = object(value);
    if ('agent_guide' in route) expect(typeof route['agent_guide']).toBe('boolean');
    if (route['agent_guide'] === true) {
      expect(route['entry']).toContain('in_app');
      expect(Array.isArray(route['entry'])).toBe(true);
      expect([...(route['entry'] as unknown[])].sort()).toEqual(['in_app', 'push']);
      expect(route['agent_guide_account']).toBeUndefined();
    }
  }
});

it('[CT-08b] [BR-AI-01] [BR-ID-10] 账户安全分类与 page 双向匹配，禁止引导与深链', () => {
  const entries = Object.entries(routes()).map(([name, value]) => [name, object(value)] as const);
  const groups: [string, RegExp][] = [
    ['phone', /换手机号|更换手机号|绑定手机号|绑手机/u],
    ['delete', /注销/u],
    ['fund', /实名|收款账号|提现申请|劳务协议/u],
  ];
  for (const [account, pattern] of groups) {
    const matching = entries.filter(
      ([, route]) => typeof route['page'] === 'string' && pattern.test(route['page']),
    );
    expect(matching.length, `缺少 ${account} 类现有路由`).toBeGreaterThan(0);
    for (const [name, route] of matching) expect(route['agent_guide_account'], name).toBe(account);
  }
  for (const [name, route] of entries) {
    if ('agent_guide_account' in route) {
      expect(['phone', 'delete', 'fund']).toContain(route['agent_guide_account']);
      expect(route['agent_guide'], name).not.toBe(true);
      expect(guideRoutes).not.toContain(name);
      expect(Array.isArray(route['entry']), name).toBe(true);
      expect(route['entry'], name).not.toContain('deeplink');
      const group = groups.find(([account]) => account === route['agent_guide_account']);
      expect(group, name).toBeDefined();
      expect(typeof route['page'], name).toBe('string');
      expect(route['page'], name).toMatch(group![1]);
    }
  }
});

it('[CT-08b] [BR-ID-10] 生成桥导出六条引导路由清单并保留路由标记', () => {
  // The task does not prescribe an export identifier; check the exported list by value.
  const exportedLists = Object.values(bridge as ObjectValue)
    .filter((value): value is unknown[] => Array.isArray(value))
    .map((value) => [...value].sort());
  expect(exportedLists).toContainEqual([...guideRoutes].sort());
  for (const [name, value] of Object.entries(routes())) {
    const source = object(value);
    const generated = object((bridge.routes as ObjectValue)[name]);
    expect(generated['agent_guide'] ?? false, name).toBe(source['agent_guide'] ?? false);
  }
});

it('[CT-08b] [BR-AI-01] page_guide 仅两个必填字段，路由语法不限定六条白名单', () => {
  const { frame } = validators();
  const data = { route: 'Wallet', text_key: 'agent.guide.Wallet' };
  for (const route of [...guideRoutes, 'Settings', 'FuturePage2']) {
    check(frame, card('page_guide', { route, text_key: `agent.guide.${route}` }), true);
  }
  for (const key of Object.keys(data)) check(frame, card('page_guide', without(data, key)), false);
  for (const patch of [
    { params: {} },
    { url: 'https://example.com' },
    { amount_fen: 1 },
    { extra: true },
  ]) {
    check(frame, card('page_guide', { ...data, ...patch }), false);
  }
  for (const route of [
    '',
    'wallet',
    'https://example.com',
    'Wallet?x=1',
    'Wallet/Other',
    null,
    12,
  ]) {
    check(frame, card('page_guide', { ...data, route }), false);
  }
  for (const text_key of ['', 'agent.earnings.open_wallet', 'agent.guide.wallet', null, 12]) {
    check(frame, card('page_guide', { ...data, text_key }), false);
  }
  const valid = card('page_guide', data);
  check(frame, { ...valid, data: { ...valid.data, fallback_text: '' } }, false);
});

it('[CT-08b] [BR-AI-01] earnings_summary 实时必填字段不能缺失且允许空提现、空月份', () => {
  const { frame } = validators();
  check(frame, card('earnings_summary', realtime), true);
  check(
    frame,
    card('earnings_summary', { ...realtime, latest_withdrawal: null, next_credit_period: null }),
    true,
  );
  check(
    frame,
    card('earnings_summary', {
      ...realtime,
      withdrawable_fen: 0,
      estimated_total_fen: 0,
      credit_overdue: true,
    }),
    true,
  );
  for (const key of Object.keys(realtime))
    check(frame, card('earnings_summary', without(realtime, key)), false);
  check(frame, card('earnings_summary', { ...realtime, extra: true }), false);
  for (const credit_overdue of [null, 0, 'false'])
    check(frame, card('earnings_summary', { ...realtime, credit_overdue }), false);
});

it('[CT-08b] [BR-AI-01] 收益金额是非空 int64 整数，最近提现仅标题键和申请金额', () => {
  const { frame } = validators();
  check(frame, card('earnings_summary', realtime), true);
  for (const key of ['withdrawable_fen', 'estimated_total_fen']) {
    for (const value of [100.5, '100', null, Number.MAX_SAFE_INTEGER + 1])
      check(frame, card('earnings_summary', { ...realtime, [key]: value }), false);
    check(frame, card('earnings_summary', { ...realtime, [key]: Number.MAX_SAFE_INTEGER }), true);
  }
  for (const amount_fen of [100.5, '100', null, Number.MAX_SAFE_INTEGER + 1]) {
    check(
      frame,
      card('earnings_summary', {
        ...realtime,
        latest_withdrawal: { ...latestWithdrawal, amount_fen },
      }),
      false,
    );
  }
  for (const key of Object.keys(latestWithdrawal)) {
    check(
      frame,
      card('earnings_summary', { ...realtime, latest_withdrawal: without(latestWithdrawal, key) }),
      false,
    );
  }
  for (const title_key of [null, 1]) {
    check(
      frame,
      card('earnings_summary', {
        ...realtime,
        latest_withdrawal: { ...latestWithdrawal, title_key },
      }),
      false,
    );
  }
  for (const [key, value] of Object.entries({
    net_amount_fen: 9200,
    tax_fen: 800,
    fee_fen: 100,
    reason: '失败原因',
    expected_at: asOf,
    confirm_deadline: asOf,
    extra: true,
  })) {
    check(
      frame,
      card('earnings_summary', {
        ...realtime,
        latest_withdrawal: { ...latestWithdrawal, [key]: value },
      }),
      false,
    );
  }
});

it('[CT-08b] [BR-AI-01] 收益卡历史重载只允许 as_of 与 actions，拒绝部分金额快照', () => {
  const { frame } = validators();
  check(frame, card('earnings_summary', history), true);
  for (const key of Object.keys(history))
    check(frame, card('earnings_summary', without(history, key)), false);
  for (const key of Object.keys(realtime).filter((key) => !(key in history))) {
    check(frame, card('earnings_summary', { ...history, [key]: realtime[key] }), false);
  }
  check(frame, card('earnings_summary', { ...history, extra: true }), false);
});

it.each([
  ['实时', realtime],
  ['历史', history],
] as const)(
  '[CT-08b] [BR-AI-01] %s 收益卡时间为 +08:00，按钮固定顺序、目标和文案且封闭',
  (_label, data) => {
    const { frame } = validators();
    check(frame, card('earnings_summary', data), true);
    for (const as_of of [
      '2026-10-06T10:00:00Z',
      '2026-10-06T10:00:00+00:00',
      '2026-13-06T10:00:00+08:00',
      '2026-10-06',
      'invalid',
      null,
    ]) {
      check(frame, card('earnings_summary', { ...data, as_of }), false);
    }
    const invalidActions = [
      [],
      [actions[0]],
      [...actions, actions[0]],
      [...actions].reverse(),
      [{ ...actions[0], params: {} }, actions[1]],
      [actions[0], { ...actions[1], params: {} }],
      [{ ...actions[0], route: 'Withdraw' }, actions[1]],
      [actions[0], { ...actions[1], text_key: 'agent.earnings.open_wallet' }],
      [{ route: 'Wallet' }, actions[1]],
      [actions[0], { text_key: 'agent.earnings.open_records' }],
      [{ ...actions[0], url: 'https://example.com' }, actions[1]],
      null,
    ];
    for (const value of invalidActions)
      check(frame, card('earnings_summary', { ...data, actions: value }), false);
  },
);

it('[CT-08b] [BR-AI-01] 预计结算月份只接受 YYYY-MM 或 null', () => {
  const { frame } = validators();
  for (const next_credit_period of [null, '2026-01', '2026-12'])
    check(frame, card('earnings_summary', { ...realtime, next_credit_period }), true);
  for (const next_credit_period of [
    '2026-00',
    '2026-13',
    '2026-1',
    '26-01',
    '2026-01-01',
    '',
    202611,
  ])
    check(frame, card('earnings_summary', { ...realtime, next_credit_period }), false);
});

it('[CT-08b] [BR-AI-01] page_guide_intent 模型输出仅意图与字符串路由', () => {
  const { selected } = validators('page_guide_intent');
  const valid = { agent_intent: 'page_guide', guide_route: 'Wallet' };
  check(selected, valid, true);
  check(selected, { ...valid, guide_route: 'Settings' }, true);
  for (const key of Object.keys(valid)) check(selected, without(valid, key), false);
  for (const guide_route of [null, 1, {}, []]) check(selected, { ...valid, guide_route }, false);
  for (const agent_intent of ['earnings_query', 'search', null])
    check(selected, { ...valid, agent_intent }, false);
  for (const patch of [
    { params: {} },
    { url: 'https://example.com' },
    { amount_fen: 100 },
    { extra: true },
  ])
    check(selected, { ...valid, ...patch }, false);
});

it('[CT-08b] [BR-AI-01] get_my_earnings_args 只接受空对象，拒绝身份与其他参数', () => {
  const { selected } = validators('get_my_earnings_args');
  check(selected, {}, true);
  for (const value of [null, [], '', 0]) check(selected, value, false);
  for (const key of [
    'user_id',
    'app_id',
    'device_id',
    'scene',
    'relation_id',
    'special_id',
    'subUnionId',
    'custom_parameters',
    'page',
    'extra',
  ])
    check(selected, { [key]: 'untrusted' }, false);
});

it('[CT-08b] [BR-AI-01] get_my_earnings_result 两种封闭结果均不向模型泄露金额、月份、提现状态', () => {
  const { selected } = validators('get_my_earnings_result');
  const shown = { card_id: 'c1', status: 'shown' };
  const unavailable = { status: 'unavailable' };
  check(selected, shown, true);
  check(selected, unavailable, true);
  for (const card_id of [null, 1, {}, []]) check(selected, { ...shown, card_id }, false);
  for (const value of [
    null,
    [],
    'shown',
    {},
    { status: 'shown' },
    { card_id: 'c1' },
    { ...unavailable, card_id: 'c1' },
    { status: 'failed' },
  ])
    check(selected, value, false);
  for (const base of [shown, unavailable]) {
    for (const [key, value] of Object.entries({
      withdrawable_fen: 100,
      estimated_total_fen: 100,
      amount_fen: 100,
      next_credit_period: '2026-11',
      latest_withdrawal: latestWithdrawal,
      withdrawal_status: 'PENDING',
      title_key: latestWithdrawal.title_key,
      credit_overdue: false,
      as_of: asOf,
      extra: true,
    }))
      check(selected, { ...base, [key]: value }, false);
  }
});

function readFixture(name: string): ObjectValue[] {
  const text = readText(`contracts/fixtures/agent-streams/${name}.ndjson`).trimEnd();
  expect(text.length, `${name} 不得为空`).toBeGreaterThan(0);
  return text.split(/\r?\n/u).map(parseObject);
}

function fixtureFrames(name: string): Frame[] {
  const { frame, selected: ping } = validators();
  const rows = readFixture(name);
  const frames: Frame[] = [];
  for (const row of rows) {
    if ('comment' in row) check(ping, row, true);
    else {
      check(frame, row, true);
      frames.push(row as Frame);
    }
  }
  return frames;
}

function products(frame: Frame): ObjectValue[] {
  if (frame.event !== 'card') return [];
  const data = object(frame.data['data']);
  if (frame.data['type'] === 'rebate_quote') return [object(data['product'])];
  if (frame.data['type'] === 'product_list') {
    expect(Array.isArray(data['items'])).toBe(true);
    return (data['items'] as unknown[]).map(object);
  }
  return [];
}

function singleCard(frames: Frame[], type: string): Frame {
  const cards = frames.filter((frame) => frame.event === 'card');
  expect(cards).toHaveLength(1);
  expect(cards[0]?.data['type']).toBe(type);
  return cards[0]!;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value !== null && typeof value === 'object')
    return Object.values(value as ObjectValue).flatMap(stringValues);
  return [];
}

it.each(newFixtures)(
  '[CT-08b] [BR-AI-01] %s 样例存在、逐行合法且符合一轮流或历史重载边界',
  (name) => {
    const frames = fixtureFrames(name);
    if (name === 'normal-earnings-history') {
      expect(readFixture(name)).toHaveLength(1);
      expect(frames).toHaveLength(1);
      const value = singleCard(frames, 'earnings_summary');
      expect(Object.keys(object(value.data['data'])).sort()).toEqual(['actions', 'as_of']);
      return;
    }
    expect(frames[0]?.event).toBe('meta');
    expect(frames.filter((frame) => frame.event === 'meta')).toHaveLength(1);
    const terminals = frames.filter((frame) => ['done', 'error'].includes(frame.event));
    expect(terminals).toHaveLength(1);
    expect(frames.at(-1)).toBe(terminals[0]);
    expect(terminals[0]?.event).toBe('done');
    expect(terminals[0]?.data['finish_reason']).toBe('stop');
    const cardIds: unknown[] = [];
    for (const [index, frame] of frames.entries()) {
      if (index > 0) expect(frame.id).toBeGreaterThan(frames[index - 1]!.id);
      if (['card', 'tool.status', 'text.delta'].includes(frame.event))
        expect(frame.data['seq']).toBe(frame.id);
      if (frame.event === 'card') {
        cardIds.push(frame.data['card_id']);
        cardIds.push(...products(frame).map((product) => product['card_id']));
      }
    }
    expect(cardIds).toEqual(cardIds.map((_, index) => `c${index + 1}`));
    if (name === 'normal-earnings') {
      expect(frames.map((frame) => frame.event)).toEqual([
        'meta',
        'tool.status',
        'tool.status',
        'card',
        'text.delta',
        'done',
      ]);
      expect(
        frames
          .filter((frame) => frame.event === 'tool.status')
          .map((frame) => [frame.data['tool'], frame.data['phase']]),
      ).toEqual([
        ['get_my_earnings', 'start'],
        ['get_my_earnings', 'end'],
      ]);
      expect(
        Object.keys(object(singleCard(frames, 'earnings_summary').data['data'])).sort(),
      ).toEqual(Object.keys(realtime).sort());
      const text = frames
        .filter((frame) => frame.event === 'text.delta')
        .map((frame) => frame.data['delta'])
        .join('');
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/[0-9０-９]/u);
      for (const frame of frames.filter((value) => value.event !== 'card')) {
        const data = { ...frame.data };
        // BR-AI-01 禁止卡外金额；UUID 与提示词版本是协议元数据，不是展示文案。
        // 只豁免 meta 的这四个字段，其余字符串（含 display_text）递归检查。
        if (frame.event === 'meta') {
          for (const key of ['session_id', 'run_id', 'message_id', 'prompt_version'])
            delete data[key];
        }
        for (const value of stringValues({ ...frame, data }))
          expect(value, `${name}: ${frame.event} 帧卡外字符串`).not.toMatch(/[0-9０-９]/u);
      }
    } else {
      expect(frames.map((frame) => frame.event)).toEqual(['meta', 'card', 'done']);
      const data = object(singleCard(frames, 'page_guide').data['data']);
      expect(typeof data['route']).toBe('string');
      const route = data['route'] as string;
      expect(routes()[route]).toBeDefined();
      if (name === 'normal-page-guide') {
        expect(route).toBe('WithdrawRecords');
        expect(guideRoutes).toContain(route);
        expect(object(routes()[route])['agent_guide']).toBe(true);
      } else {
        expect(guideRoutes).not.toContain(route);
        expect(object(routes()[route])['agent_guide']).not.toBe(true);
      }
    }
  },
);

it('[CT-08b] [BR-AI-01] 引导与收益回退文案不含数字、URL、卡片或按钮，引导文案键与路由一致', () => {
  const cards = allFixtures
    .flatMap(fixtureFrames)
    .filter(
      (frame) =>
        frame.event === 'card' &&
        ['page_guide', 'earnings_summary'].includes(String(frame.data['type'])),
    );
  expect(cards).toHaveLength(4);
  for (const frame of cards) {
    const fallback = frame.data['fallback_text'];
    expect(typeof fallback).toBe('string');
    expect(fallback).not.toBe('');
    expect(fallback).not.toMatch(/[0-9０-９]|[a-z][a-z0-9+.-]*:\/\/|www\./iu);
    expect(fallback).not.toMatch(/卡片|按钮/u);
    const data = object(frame.data['data']);
    if (frame.data['type'] === 'page_guide')
      expect(data['text_key']).toBe(`agent.guide.${String(data['route'])}`);
    else {
      expect(data['actions']).toEqual(actions);
    }
  }
});

it('[CT-08b] 所有样例 meta.ai_label 和 error.msg 使用默认文案', () => {
  const texts = object(readObject('contracts/texts.default.json')['texts']);
  expect(texts['ai_label'], '缺少 BR-TEXT-16 默认文案键 ai_label').toBe('内容由 AI 生成，仅供参考');
  const frames = allFixtures.flatMap(fixtureFrames);
  const metas = frames.filter((frame) => frame.event === 'meta');
  const errors = frames.filter((frame) => frame.event === 'error');
  expect(metas).toHaveLength(10);
  expect(errors.length).toBeGreaterThan(0);
  for (const frame of metas) expect(frame.data['ai_label']).toBe(texts['ai_label']);
  for (const frame of errors) {
    const key = `error.${String(frame.data['code'])}`;
    expect(typeof texts[key], key).toBe('string');
    expect(frame.data['msg']).toBe(texts[key]);
  }
});

it('[CT-08b] 每个完整或断开流样例都属于不同会话，历史单卡不引入 meta', () => {
  const metas = allFixtures.flatMap(fixtureFrames).filter((frame) => frame.event === 'meta');
  expect(metas).toHaveLength(10);
  const sessions = metas.map((frame) => frame.data['session_id']);
  expect(new Set(sessions).size).toBe(sessions.length);
});

it.each(['login', 'bind_phone'])(
  '[CT-08b] [BR-AI-01] auth_required(%s) 可不对应联盟平台，union_auth 必须有平台',
  (reason) => {
    const { frame } = validators();
    const data = { platform: null, reason, resume_link_id: 'demo-resume' };
    check(frame, card('auth_required', data), true);
    check(frame, card('auth_required', { ...data, reason: 'union_auth' }), false);
    for (const platform of enums.platform) {
      check(frame, card('auth_required', { ...data, platform }), true);
      check(frame, card('auth_required', { ...data, platform, reason: 'union_auth' }), true);
    }
  },
);

it('[CT-08b] rule_ref.action 与 RouteTarget 一致，允许省略 params', () => {
  const { frame } = validators();
  const data = {
    chunk_id: '019a0000-0000-7000-8000-000000000006',
    title: '演示规则',
    excerpt: '规则摘要',
    published_version: 'demo-v1',
    action: { route: 'Help' },
  };
  check(frame, card('rule_ref', data), true);
  check(frame, card('rule_ref', { ...data, action: { route: 'Help', params: {} } }), true);
  check(frame, card('rule_ref', { ...data, action: { params: {} } }), false);
});

it('[CT-08b] 两类商品卡 disclaimer_keys 必含一种价格口径键，但 schema 不按券额强制选择', () => {
  const { frame } = validators();
  const cards = fixtureFrames('normal').filter(
    (value) =>
      value.event === 'card' &&
      ['product_list', 'rebate_quote'].includes(String(value.data['type'])),
  );
  expect(cards.map((value) => value.data['type']).sort()).toEqual(['product_list', 'rebate_quote']);
  for (const value of cards) {
    const original = object(value.data['data']);
    const product = products(value)[0];
    expect(product).toBeDefined();
    for (const disclaimer_keys of [
      ['agent.disclaimer.commission'],
      ['unrelated'],
      ['price_basis.general'],
      ['price_basis'],
    ]) {
      const updated = { ...product, coupon_fen: 0, disclaimer_keys };
      const data =
        value.data['type'] === 'product_list'
          ? { ...original, items: [updated] }
          : { ...original, product: updated };
      check(
        frame,
        card(String(value.data['type']), data),
        disclaimer_keys.some((key) => key === 'price_basis' || key === 'price_basis.general'),
      );
    }
  }
});

it('[CT-08b] 所有商品样例按有券与无券选择价格口径键并披露佣金', () => {
  const items = allFixtures.flatMap(fixtureFrames).flatMap(products);
  expect(items.some((item) => item['coupon_fen'] === 0)).toBe(true);
  expect(
    items.some((item) => typeof item['coupon_fen'] === 'number' && item['coupon_fen'] > 0),
  ).toBe(true);
  for (const item of items) {
    const hasCoupon = (item['coupon_fen'] as number) > 0;
    expect(item['disclaimer_keys']).toContain(hasCoupon ? 'price_basis' : 'price_basis.general');
    expect(item['disclaimer_keys']).not.toContain(
      hasCoupon ? 'price_basis.general' : 'price_basis',
    );
    expect(item['disclaimer_keys']).toContain('agent.disclaimer.commission');
  }
});
