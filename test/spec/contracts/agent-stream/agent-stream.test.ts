import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  agent_card_type,
  agent_finish_reason,
  availability,
  match_tag,
  platform,
  rebate_basis,
} from '../../../../packages/contracts-ts/src/enums.gen.ts';

// CT-08a: 04 §8.1–8.3 + task §9–10. Only the wire contract, not producer/client logic.
type ObjectValue = Record<string, unknown>;
type Frame = { event: string; id: number; data: ObjectValue };
type Validator = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): Validator;
}

const root = new URL('../../../../', import.meta.url);
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

function validators(): { frame: Validator; ping: Validator; schema: ObjectValue } {
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
  return { frame: frame!, ping: ping!, schema };
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
  card_id: 'c2',
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
  tlj: null,
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
const material = {
  title_hint: '演示素材标题',
  spec: '500ml',
  claimed_price_fen: 2990,
  claimed_unit_price_fen: 2990,
  conditions: ['88vip'],
  benefits: ['coupon'],
  tpwd: null,
};
const tlj = { amount_fen: 100, remain: 2, kind: 'ours' };
// §8.3 does not name the nested product key; use `product` consistently in quote data.
const cardData = {
  product_list: { result_set_id: 'demo-results', items: [product], layout: 'list' },
  rebate_quote: { product, material, tlj_kind: 'unknown' },
  order_status: order,
  claim_draft: {
    platform: 'jd',
    order_no: 'demo-order-no',
    click_times: ['2026-10-06T10:00:00+08:00'],
    evidence_summary: null,
    submit_action: { text_key: 'btn.submit', action: 'submit_claim' },
  },
  handoff: { entry: 'customer_service', summary: '请协助查询订单' },
  auth_required: { platform: 'taobao', reason: 'union_auth', resume_link_id: 'demo-resume' },
  notice: { level: 'info', text_key: 'agent.demo.notice', actions: [] },
  rule_ref: {
    chunk_id: '019a0000-0000-7000-8000-000000000006',
    title: '演示规则',
    excerpt: '规则摘要',
    published_version: 'demo-v1',
    action: { route: 'Rules', params: {} },
  },
};
const productContainers: [string, (item: ObjectValue) => Frame][] = [
  ['product_list', (item) => card('product_list', { ...cardData.product_list, items: [item] })],
  ['rebate_quote', (item) => card('rebate_quote', { ...cardData.rebate_quote, product: item })],
];

function without(value: ObjectValue, key: string): ObjectValue {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

// Probe all declared enum literals as well as an out-of-range sentinel. This catches extra
// values as well as omissions without assuming $defs names or oneOf/$ref layout.
function enumCandidates(schema: ObjectValue, expected: readonly string[]): string[] {
  const values = new Set([...expected, '__outside_contract__']);
  function visit(node: unknown): void {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === 'object') {
      const record = node as ObjectValue;
      if (Array.isArray(record['enum'])) {
        for (const value of record['enum']) if (typeof value === 'string') values.add(value);
      }
      if (typeof record['const'] === 'string') values.add(record['const']);
      Object.values(record).forEach(visit);
    }
  }
  visit(schema);
  return [...values];
}

function checkEnum(
  frame: Validator,
  schema: ObjectValue,
  expected: readonly string[],
  makeFrame: (value: string) => Frame,
): void {
  const accepted = enumCandidates(schema, expected).filter((value) => frame(makeFrame(value)));
  expect(accepted.sort()).toEqual([...expected].sort());
}
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
  card: card('product_list', cardData.product_list).data,
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
    for (const otherEvent of Object.keys(eventData)) {
      if (otherEvent !== event) check(frame, { ...valid, event: otherEvent }, false);
    }
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

it('[CT-08a] done.finish_reason 与生成枚举完全一致', () => {
  const { frame, schema } = validators();
  checkEnum(frame, schema, agent_finish_reason, (finish_reason) => ({
    event: 'done',
    id: 2,
    data: { finish_reason, quota_left: 0 },
  }));
});

it('[CT-08a] error.code 为五位整数，包含两个边界', () => {
  const { frame } = validators();
  for (const code of [10000, 99999])
    check(frame, { event: 'error', id: 2, data: { ...eventData['error'], code } }, true);
  for (const code of [9999, 100000, 50001.5, '50001', null])
    check(frame, { event: 'error', id: 2, data: { ...eventData['error'], code } }, false);
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
  check(frame, { event: 'suggestions', id: 2, data: { items: [{ send_text: '换一批' }] } }, false);
  check(
    frame,
    {
      event: 'suggestions',
      id: 2,
      data: { items: [{ ...item, url: 'https://example.com' }] },
    },
    false,
  );
});

it.each(Object.entries(cardData))(
  '[CT-08a] %s 全字段合法，逐键必填、封闭且与其他七种卡片不能错配',
  (type, data) => {
    const { frame } = validators();
    check(frame, card(type, data), true);
    check(frame, card(type, {}), false);
    check(frame, card(type, { ...data, unexpected_field: true }), false);
    for (const key of Object.keys(data)) check(frame, card(type, without(data, key)), false);
    for (const otherType of Object.keys(cardData)) {
      if (otherType !== type) check(frame, card(otherType, data), false);
    }
  },
);

it('[CT-08a] 严格校验 data 的已知卡片集合与生成枚举完全一致', () => {
  const { frame, schema } = validators();
  const candidates = enumCandidates(schema, agent_card_type);
  // Unknown card types must accept arbitrary object data; registered types must not.
  const registered = candidates.filter(
    (type) => !frame(card(type, { future_field: { nested: ['扩展'] } })),
  );
  expect(registered.sort()).toEqual([...agent_card_type].sort());
});

it('[CT-08a] future_card 走封闭的未知卡片外壳与非空 fallback_text', () => {
  const { frame } = validators();
  const valid = card('future_card', { future_field: { nested: ['任意扩展'] } });
  check(frame, valid, true);
  check(frame, { ...valid, data: { ...valid.data, extra: true } }, false);
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
});

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

it.each(productContainers)(
  '[BR-AI-04] %s 商品必需字段不能缺失或为 null，无券的 0 合法',
  (_name, wrap) => {
    const { frame } = validators();
    check(frame, wrap(product), true);
    for (const key of [
      'price_fen',
      'coupon_fen',
      'final_price_fen',
      'rebate_basis',
      'availability',
      'quoted_at',
      'source',
    ]) {
      check(frame, wrap(without(product, key)), false);
      check(frame, wrap({ ...product, [key]: null }), false);
    }
    check(
      frame,
      wrap({ ...product, coupon_fen: 0, final_price_fen: 3990, cta: { text_key: 'btn.buy' } }),
      true,
    );
    for (const quoted_at of [
      'invalid',
      '2026-10-06',
      '2026-10-06T10:00:00Z',
      '2026-10-06T10:00:00+00:00',
    ]) {
      check(frame, wrap({ ...product, quoted_at }), false);
    }
    check(frame, wrap({ ...product, recommendation_reason: '模型逐张推荐理由' }), false);
    check(frame, wrap(without(product, 'link_id')), false);
  },
);

it.each(productContainers)(
  '[BR-AI-04] %s 返利上下界按 rebate_basis 约束整数与 null',
  (_name, wrap) => {
    const { frame } = validators();
    for (const basis of rebate_basis.filter((value) => value !== 'no_rebate')) {
      const nullable = basis === 'amount_unknown' || basis === 'login_required';
      const value = {
        ...product,
        rebate_basis: basis,
        rebate_min_fen: nullable ? null : 100,
        rebate_max_fen: nullable ? null : 100,
        est_net_price_fen: nullable ? null : 2890,
      };
      check(frame, wrap(value), true);
      for (const key of ['rebate_min_fen', 'rebate_max_fen']) {
        check(frame, wrap(without(value, key)), false);
        for (const invalid of [nullable ? 100 : null, 100.5, '100']) {
          check(frame, wrap({ ...value, [key]: invalid }), false);
        }
      }
    }
    check(
      frame,
      wrap({ ...product, rebate_basis: 'no_rebate', rebate_min_fen: 0, rebate_max_fen: 0 }),
      false,
    );
    check(
      frame,
      wrap({ ...product, rebate_basis: 'no_rebate', rebate_min_fen: null, rebate_max_fen: null }),
      false,
    );
    check(frame, wrap({ ...product, no_rebate_cause: 'price_compare' }), false);
    check(frame, wrap({ ...product, no_rebate_cause: null }), false);
  },
);

it.each(productContainers)(
  '[BR-AI-04] %s availability/platform/rebate_basis/source 的接受集合与契约一致',
  (_name, wrap) => {
    const { frame, schema } = validators();
    checkEnum(frame, schema, availability, (value) => wrap({ ...product, availability: value }));
    checkEnum(frame, schema, platform, (value) => wrap({ ...product, platform: value }));
    checkEnum(frame, schema, ['taobao_union', 'jd_union', 'pdd_union'], (value) =>
      wrap({ ...product, source: value }),
    );
    checkEnum(
      frame,
      schema,
      rebate_basis.filter((value) => value !== 'no_rebate'),
      (value) => {
        const nullable = value === 'amount_unknown' || value === 'login_required';
        return wrap({
          ...product,
          rebate_basis: value,
          rebate_min_fen: nullable ? null : 100,
          rebate_max_fen: nullable ? null : 100,
          est_net_price_fen: nullable ? null : 2890,
        });
      },
    );
  },
);

it.each(['order_status', 'claim_draft', 'auth_required'] as const)(
  '[CT-08a] %s.platform 与生成枚举完全一致',
  (type) => {
    const { frame, schema } = validators();
    checkEnum(frame, schema, platform, (value) =>
      card(type, { ...cardData[type], platform: value }),
    );
  },
);

it.each(productContainers)(
  '[BR-AI-24] %s match_tag 与枚举一致且必填，spec_text 必填且仅字符串或 null',
  (_name, wrap) => {
    const { frame, schema } = validators();
    checkEnum(frame, schema, match_tag, (value) => wrap({ ...product, match_tag: value }));
    for (const key of ['match_tag', 'spec_text']) check(frame, wrap(without(product, key)), false);
    check(frame, wrap({ ...product, match_tag: null }), false);
    for (const value of ['500ml', null]) check(frame, wrap({ ...product, spec_text: value }), true);
    for (const value of [123, false, {}, []])
      check(frame, wrap({ ...product, spec_text: value }), false);
  },
);

it.each(productContainers)(
  '[BR-AI-04] %s disclaimer_keys 必带且为非空字符串数组',
  (_name, wrap) => {
    const { frame } = validators();
    check(frame, wrap(product), true);
    check(frame, wrap(without(product, 'disclaimer_keys')), false);
    for (const value of [[], null, 'price_basis', [123], ['price_basis', 123]]) {
      check(frame, wrap({ ...product, disclaimer_keys: value }), false);
    }
  },
);

it.each(productContainers)(
  '[BR-AI-04] %s 每个商品金额与淘礼金金额拒绝小数和字符串',
  (_name, wrap) => {
    const { frame } = validators();
    check(frame, wrap({ ...product, tlj }), true);
    for (const key of Object.keys(product).filter((key) => key.endsWith('_fen'))) {
      for (const value of [100.5, '100']) check(frame, wrap({ ...product, [key]: value }), false);
    }
    for (const value of [100.5, '100'])
      check(frame, wrap({ ...product, tlj: { ...tlj, amount_fen: value } }), false);
  },
);

it('[CT-08a] order_status 和素材的每个金额拒绝小数和字符串', () => {
  const { frame } = validators();
  check(frame, card('order_status', order), true);
  check(frame, card('rebate_quote', cardData.rebate_quote), true);
  for (const value of [100.5, '100']) {
    check(frame, card('order_status', { ...order, est_rebate_fen: value }), false);
    for (const key of ['claimed_price_fen', 'claimed_unit_price_fen']) {
      check(
        frame,
        card('rebate_quote', {
          ...cardData.rebate_quote,
          material: { ...material, [key]: value },
        }),
        false,
      );
    }
  }
});

it('[CT-08a] rebate_quote 的素材逐字段必填且封闭，claim_draft 的 MVP 证据仅 null', () => {
  const { frame } = validators();
  check(frame, card('rebate_quote', cardData.rebate_quote), true);
  for (const key of Object.keys(material)) {
    check(
      frame,
      card('rebate_quote', { ...cardData.rebate_quote, material: without(material, key) }),
      false,
    );
  }
  check(
    frame,
    card('rebate_quote', {
      ...cardData.rebate_quote,
      material: { ...material, extra: true },
    }),
    false,
  );
  check(frame, card('claim_draft', cardData.claim_draft), true);
  check(
    frame,
    card('claim_draft', { ...cardData.claim_draft, evidence_summary: '模型生成的证据' }),
    false,
  );
});

it.each(productContainers)('[BR-AI-06] %s 商品 cta/tlj 对象封闭且内部字段必填', (_name, wrap) => {
  const { frame } = validators();
  check(frame, wrap({ ...product, tlj }), true);
  check(frame, wrap({ ...product, cta: {} }), false);
  check(frame, wrap({ ...product, cta: { ...product.cta, url: 'https://example.com' } }), false);
  check(frame, wrap({ ...product, tlj: { ...tlj, extra: true } }), false);
  for (const key of Object.keys(tlj)) {
    check(frame, wrap({ ...product, tlj: without(tlj, key) }), false);
    check(frame, wrap({ ...product, tlj: { ...tlj, [key]: null } }), false);
  }
});

it.each(productContainers)(
  '[BR-AI-04] %s tlj 键必带，淘礼金标签与 claim_tlj 前缀各自要求非空 tlj',
  (_name, wrap) => {
    const { frame } = validators();
    check(frame, wrap(product), true);
    check(frame, wrap(without(product, 'tlj')), false);
    const signals = [
      { benefit_tags: ['taolijin'] },
      { cta: { text_key: 'claim_tlj' } },
      { cta: { text_key: 'claim_tlj_coupon' } },
    ];
    for (const signal of signals) {
      check(frame, wrap({ ...product, ...signal, tlj }), true);
      check(frame, wrap({ ...product, ...signal, tlj: null }), false);
    }
  },
);

it('[CT-08a] 两级 card_id 只接受 c 加非零开头整数', () => {
  const { frame } = validators();
  for (const card_id of ['c1', 'c2', 'c10', 'c123']) {
    const value = card('future_card', {});
    check(frame, { ...value, data: { ...value.data, card_id } }, true);
    for (const [, wrap] of productContainers) check(frame, wrap({ ...product, card_id }), true);
  }
  for (const card_id of ['c0', 'c01', 'c-1', 'c1.5', 'C1', 'c1x', 'xc1', '', 1, null]) {
    for (const type of [...Object.keys(cardData), 'future_card']) {
      const data = type in cardData ? cardData[type as keyof typeof cardData] : {};
      const value = card(type, data);
      check(frame, { ...value, data: { ...value.data, card_id } }, false);
    }
    for (const [, wrap] of productContainers) check(frame, wrap({ ...product, card_id }), false);
  }
  for (const [, wrap] of productContainers) check(frame, wrap(without(product, 'card_id')), false);
});

it('[BR-AI-06] product_list 数量为 1–8，布局仅 list/grid，已知卡片拒绝多余字段', () => {
  const { frame } = validators();
  check(frame, card('product_list', { ...cardData.product_list, layout: 'grid' }), true);
  for (const count of [0, 1, 8, 9]) {
    const items = Array.from({ length: count }, (_, index) => ({
      ...product,
      card_id: `c${index + 2}`,
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
  expect(frames[0]?.event).toBe('meta');
  expect(frames.filter((row) => row.event === 'meta')).toHaveLength(1);
  let previous: number | undefined;
  const cardIds: unknown[] = [];
  for (const current of frames) {
    if (previous !== undefined) expect(current.id).toBeGreaterThan(previous);
    previous = current.id;
    if (['text.delta', 'tool.status', 'card'].includes(current.event)) {
      expect(current.data['seq']).toBe(current.id);
    }
    if (current.event === 'card') {
      cardIds.push(current.data['card_id']);
      const data = object(current.data['data']);
      if (current.data['type'] === 'product_list') {
        expect(Array.isArray(data['items'])).toBe(true);
        for (const item of data['items'] as unknown[]) cardIds.push(object(item)['card_id']);
      }
      if (current.data['type'] === 'rebate_quote') {
        cardIds.push(object(data['product'])['card_id']);
      }
    }
  }
  expect(cardIds).toEqual(cardIds.map((_, index) => `c${index + 1}`));
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
    expect(frames.some((row) => row.event === 'card' && row.data['type'] === 'future_card')).toBe(
      true,
    );
  }
  if (name === 'error') expect(frames.at(-1)?.event).toBe('error');
});
