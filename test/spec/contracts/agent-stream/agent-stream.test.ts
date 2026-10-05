import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

// CT-08a: 04 §8.1–8.3 + task §9. No producer, transport or client implementation here.
type ObjectValue = Record<string, unknown>;
type Frame = { event: string; id: number; data: ObjectValue };
type Validator = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): Validator;
}

const root = new URL('../../../../', import.meta.url);
const knownCards = [
  'product_list',
  'rebate_quote',
  'order_status',
  'claim_draft',
  'handoff',
  'auth_required',
  'notice',
  'rule_ref',
];
const fixtures = [
  'normal',
  'tool-failed',
  'cancelled',
  'disconnected',
  'unknown-card',
  'error',
  'fallback',
];

function readText(path: string): string {
  const url = new URL(path, root);
  expect(existsSync(url), `缺少 ${path}`).toBe(true);
  let text = '';
  expect(() => {
    text = readFileSync(url, 'utf8');
  }, `无法读取 ${path}`).not.toThrow();
  return text;
}

function object(value: unknown): ObjectValue {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as ObjectValue;
}

function parseObject(text: string, location: string): ObjectValue {
  let value: unknown;
  expect(() => {
    value = JSON.parse(text) as unknown;
  }, `${location}: JSON 无效`).not.toThrow();
  return object(value);
}

function validators(): { frame: Validator; ping: Validator } {
  const schema = parseObject(readText('contracts/agent-stream.schema.json'), 'agent-stream schema');
  expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(object(schema['$defs'])['ping']).toBeDefined();
  // Reuse API dependencies per task §9; do not add dependencies to test/package.json.
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
  let ping: Validator | undefined;
  expect(() => {
    frame = ajv.compile(schema);
    // Keep local references resolvable, without registering the root $id twice.
    ping = ajv.compile({
      $schema: schema['$schema'],
      $defs: schema['$defs'],
      $ref: '#/$defs/ping',
    });
  }, 'Schema 必须能以 Ajv2020 strict 编译').not.toThrow();
  expect(frame).toBeTypeOf('function');
  expect(ping).toBeTypeOf('function');
  return { frame: frame!, ping: ping! };
}

function check(validate: Validator, value: unknown, expected: boolean): void {
  const valid = validate(value);
  expect(valid, JSON.stringify({ value, errors: validate.errors })).toBe(expected);
}

function card(type: string, data: ObjectValue): Frame {
  return {
    event: 'card',
    id: 2,
    data: { seq: 2, card_id: 'c1', type, schema_version: 1, data, fallback_text: '请查看查询结果' },
  };
}

const product = {
  card_id: 'c1',
  product_key: 'jd:demo-product',
  item_ref: 'demo-signed-reference',
  platform: 'jd',
  shop_type: null,
  title: '演示商品 500ml',
  image: 'https://example.com/product.png',
  shop_name: '演示店铺',
  price_fen: 3990,
  coupon_fen: 1000,
  final_price_fen: 2990,
  est_net_price_fen: 2890,
  rebate_min_fen: 100,
  rebate_max_fen: 100,
  rebate_basis: 'normal',
  benefit_tags: ['有券'],
  match_tag: 'matched',
  spec_text: '500ml',
  is_presale: false,
  link_id: '019a0000-0000-7000-8000-000000000004',
  cta: { text_key: 'btn.buy.coupon' },
  quoted_at: '2026-10-06T10:00:00+08:00',
  stale: false,
  age_sec: 0,
  source: 'jd_union',
  disclaimer_keys: ['price_basis'],
  ad_label: null,
  availability: 'ok',
};
const order = {
  order_id: '019a0000-0000-7000-8000-000000000005',
  platform: 'jd',
  title: '演示商品',
  is_other_product: false,
  display_status: 'WAITING',
  reason: null,
  est_rebate_fen: 100,
  expected_credit_period: '2026-11',
};
const eventData: Record<string, ObjectValue> = {
  meta: {
    session_id: '019a0000-0000-7000-8000-000000000001',
    run_id: '019a0000-0000-7000-8000-000000000002',
    message_id: '019a0000-0000-7000-8000-000000000003',
    prompt_version: 'demo-v1',
    model_label: '演示助手',
    ai_label: '内容由 AI 生成',
  },
  'text.delta': { seq: 2, delta: '这是查询结果，请查看卡片。' },
  'tool.status': { seq: 2, tool: 'search_products', phase: 'start', display_text: '正在查询商品' },
  card: card('product_list', { result_set_id: 'demo-results', items: [product], layout: 'list' })
    .data,
  suggestions: { items: [{ text: '换一批', send_text: '请换一批商品' }] },
  error: { code: 50001, msg: '服务暂不可用', retryable: true, fallback: 'search_page' },
  done: { finish_reason: 'stop', quota_left: 2 },
};

it.each(Object.entries(eventData))(
  '[CT-08a] %s：接受完整帧，拒绝缺字段和额外字段',
  (event, data) => {
    const { frame } = validators();
    const valid = { event, id: 2, data };
    check(frame, valid, true);
    check(frame, { ...valid, extra: true }, false);
    check(frame, { ...valid, data: { ...data, extra: true } }, false);
    for (const key of Object.keys(data)) {
      const incomplete = { ...data };
      delete incomplete[key];
      check(frame, { ...valid, data: incomplete }, false);
    }
    for (const key of ['event', 'id', 'data']) {
      const incomplete: ObjectValue = { ...valid };
      delete incomplete[key];
      check(frame, incomplete, false);
    }
  },
);

it('[CT-08a] 帧 id 是整数，未知事件不是可接受的卡片回退', () => {
  const { frame } = validators();
  for (const id of ['2', 1.5, null])
    check(frame, { event: 'done', id, data: eventData['done'] }, false);
  check(frame, { event: 'future.event', id: 2, data: {} }, false);
});

it('[CT-08a] 心跳仅由 $defs/ping 校验，不冒充事件帧', () => {
  const { frame, ping } = validators();
  check(ping, { comment: 'ping' }, true);
  check(frame, { comment: 'ping' }, false);
  for (const value of [{ comment: 'pong' }, {}, { comment: 'ping', id: 2 }])
    check(ping, value, false);
});

it('[CT-08a] done 接受全部九种原因并拒绝越界值', () => {
  const { frame } = validators();
  for (const finish_reason of [
    'stop',
    'cancelled',
    'limit',
    'budget',
    'error',
    'auth_required',
    'safety',
    'fallback',
    'timeout',
  ]) {
    check(frame, { event: 'done', id: 2, data: { finish_reason, quota_left: 0 } }, true);
  }
  check(frame, { event: 'done', id: 2, data: { finish_reason: 'complete', quota_left: 0 } }, false);
});

it('[CT-08a] tool.status 只接受 start/end/failed，不泄露参数原文', () => {
  const { frame } = validators();
  for (const phase of ['start', 'end', 'failed']) {
    check(
      frame,
      { event: 'tool.status', id: 2, data: { ...eventData['tool.status'], phase } },
      true,
    );
  }
  for (const patch of [{ phase: 'running' }, { arguments: { query: '原始参数' } }]) {
    check(
      frame,
      { event: 'tool.status', id: 2, data: { ...eventData['tool.status'], ...patch } },
      false,
    );
  }
});

it('[BR-AI-06] suggestions 接受零至三项，拒绝第四项和缺少 send_text', () => {
  const { frame } = validators();
  const item = { text: '换一批', send_text: '请换一批商品' };
  for (const count of [0, 1, 3, 4]) {
    check(
      frame,
      { event: 'suggestions', id: 2, data: { items: Array.from({ length: count }, () => item) } },
      count <= 3,
    );
  }
  check(frame, { event: 'suggestions', id: 2, data: { items: [{ text: '换一批' }] } }, false);
});

it.each(knownCards)('[CT-08a] 已知卡片 %s 不能借未知类型分支放行无效 data', (type) => {
  const { frame } = validators();
  check(frame, card(type, {}), false);
  check(frame, card(type, { unexpected_field: true }), false);
});

it.each(['future_card', 'page_guide', 'earnings_summary', 'watch_confirm', 'watch_list'])(
  '[CT-08a] %s 本阶段走未知卡片外壳与 fallback_text',
  (type) => {
    const { frame } = validators();
    const valid = card(type, { future_field: { nested: ['任意扩展'] } });
    check(frame, valid, true);
    for (const key of Object.keys(valid.data)) {
      const incomplete = { ...valid.data };
      delete incomplete[key];
      check(frame, { ...valid, data: incomplete }, false);
    }
    for (const patch of [
      { fallback_text: '' },
      { data: [] },
      { data: null },
      { data: 'text' },
      { seq: '2' },
      { type: 42 },
    ]) {
      check(frame, { ...valid, data: { ...valid.data, ...patch } }, false);
    }
  },
);

it('[CT-08a] order_status 支持分享单空标题，禁止订单号与多余字段', () => {
  const { frame } = validators();
  for (const data of [order, { ...order, title: null, is_other_product: true }]) {
    check(frame, card('order_status', data), true);
    check(frame, card('order_status', { ...data, order_no: 'demo-order-no' }), false);
    check(frame, card('order_status', { ...data, extra: true }), false);
    const missing: ObjectValue = { ...data };
    delete missing['is_other_product'];
    check(frame, card('order_status', missing), false);
  }
  check(frame, card('order_status', { ...order, expected_credit_period: '2026-13' }), false);
});

it('[CT-08a] notice.level 与 auth_required.reason 为枚举', () => {
  const { frame } = validators();
  for (const level of ['info', 'warn', 'debug']) {
    const value = card('notice', { level, text_key: 'agent.demo.notice', actions: [] });
    check(frame, value, level !== 'debug');
    check(
      frame,
      { ...value, data: { ...value.data, data: { ...object(value.data['data']), extra: true } } },
      false,
    );
  }
  for (const reason of ['union_auth', 'login', 'bind_phone', 'password']) {
    check(
      frame,
      card('auth_required', { platform: 'taobao', reason, resume_link_id: 'demo-resume' }),
      reason !== 'password',
    );
  }
});

it('[BR-AI-04] 商品卡保留来源与取数时间，金额以整数分表达', () => {
  const { frame } = validators();
  const list = (item: ObjectValue): Frame =>
    card('product_list', { result_set_id: 'demo-results', items: [item], layout: 'list' });
  check(frame, list(product), true);
  for (const key of [
    'price_fen',
    'coupon_fen',
    'final_price_fen',
    'rebate_min_fen',
    'rebate_max_fen',
    'rebate_basis',
    'availability',
    'quoted_at',
    'source',
  ]) {
    const incomplete: ObjectValue = { ...product };
    delete incomplete[key];
    check(frame, list(incomplete), false);
  }
  for (const patch of [
    { price_fen: 29.9 },
    { coupon_fen: '1000' },
    { source: 'model' },
    { quoted_at: 'invalid' },
    { recommendation_reason: '模型逐张推荐理由' },
  ]) {
    check(frame, list({ ...product, ...patch }), false);
  }
  for (const rebate_basis of ['amount_unknown', 'login_required']) {
    check(
      frame,
      list({
        ...product,
        rebate_basis,
        rebate_min_fen: null,
        rebate_max_fen: null,
        est_net_price_fen: null,
      }),
      true,
    );
  }
});

it('[BR-AI-24] match_tag 只接受三种条件标记', () => {
  const { frame } = validators();
  for (const match_tag of ['matched', 'relaxed', 'spec_unconfirmed', 'recommended']) {
    check(
      frame,
      card('product_list', {
        result_set_id: 'demo-results',
        items: [{ ...product, match_tag }],
        layout: 'grid',
      }),
      match_tag !== 'recommended',
    );
  }
});

it('[BR-AI-06] product_list 数量为 1–8，布局仅 list/grid，已知卡片拒绝多余字段', () => {
  const { frame } = validators();
  for (const count of [0, 1, 8, 9]) {
    const items = Array.from({ length: count }, (_, index) => ({
      ...product,
      card_id: `c${index + 1}`,
    }));
    check(
      frame,
      card('product_list', { result_set_id: 'demo-results', items, layout: 'list' }),
      count >= 1 && count <= 8,
    );
  }
  for (const patch of [{ layout: 'carousel' }, { extra: true }]) {
    check(
      frame,
      card('product_list', {
        result_set_id: 'demo-results',
        items: [product],
        layout: 'list',
        ...patch,
      }),
      false,
    );
  }
});

function readFixture(name: string): ObjectValue[] {
  const path = `contracts/fixtures/agent-streams/${name}.ndjson`;
  const text = readText(path).trimEnd();
  expect(text.length, `${path} 不能为空`).toBeGreaterThan(0);
  return text.split(/\r?\n/u).map((line, index) => parseObject(line, `${path}:${index + 1}`));
}

it('[CT-08a] 七类固定文件名的 NDJSON 样例齐全且非空', () => {
  for (const name of fixtures) expect(readFixture(name).length).toBeGreaterThan(0);
});

it.each(fixtures)('[CT-08a] %s：逐行校验，帧序递增，卡片不复用，终止帧唯一且最后出现', (name) => {
  const { frame, ping } = validators();
  const rows = readFixture(name);
  const frames: Frame[] = [];
  for (const row of rows) {
    if ('comment' in row) check(ping, row, true);
    else {
      check(frame, row, true);
      frames.push(row as Frame);
    }
  }
  expect(frames.length).toBeGreaterThan(0);
  let previous: number | undefined;
  let cardNumber = 0;
  for (const current of frames) {
    if (previous !== undefined) expect(current.id).toBeGreaterThan(previous);
    previous = current.id;
    if (['text.delta', 'tool.status', 'card'].includes(current.event)) {
      expect(current.data['seq']).toBe(current.id);
    }
    if (current.event === 'card') {
      cardNumber += 1;
      expect(current.data['card_id']).toBe(`c${cardNumber}`);
    }
  }
  const terminals = frames.filter((row) => row.event === 'done' || row.event === 'error');
  expect(terminals).toHaveLength(name === 'disconnected' ? 0 : 1);
  if (name !== 'disconnected') {
    expect(frames.at(-1)).toBe(terminals[0]);
  }
  if (name === 'normal') {
    expect(frames.some((row) => row.event === 'card')).toBe(true);
    expect(frames.at(-1)?.data['finish_reason']).toBe('stop');
  }
  if (name === 'tool-failed') {
    expect(
      frames.some((row) => row.event === 'tool.status' && row.data['phase'] === 'failed'),
    ).toBe(true);
  }
  if (name === 'cancelled' || name === 'fallback') {
    expect(frames.at(-1)?.event).toBe('done');
    expect(frames.at(-1)?.data['finish_reason']).toBe(name);
  }
  if (name === 'unknown-card') {
    expect(
      frames.some((row) => row.event === 'card' && !knownCards.includes(String(row.data['type']))),
    ).toBe(true);
  }
  if (name === 'error') expect(frames.at(-1)?.event).toBe('error');
});
