// CT-26x GET /admin/v1/product-feedbacks（adminListProductFeedbacks）的契约形状（任务书第 9 节第 2–6 项）。
// 独立预期，不从契约生成；静态读 contracts，不连库、不 listen。
import { expect, it } from 'vitest';
import {
  accepts,
  at,
  compile,
  check,
  contract,
  enumField,
  expand,
  field,
  list,
  missingRejected,
  object,
  resolve,
  response,
  text,
  yaml,
  type Obj,
} from '../admin-order-actions/kit.ts';
import { closed, examples } from '../order-claims/kit.ts';
import {
  badTimes,
  descriptionOf,
  forbiddenKey,
  goodTimes,
  guestItem,
  itemKeys,
  memberItem,
  operation,
  operationId,
  param,
  path,
  permission,
  rawParams,
  reasons,
} from './kit.ts';

const id = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f7c01';
const queryNames = ['page', 'page_size', 'platform', 'reason', 'from', 'to'];

function platformEnum(doc: Obj): unknown[] {
  return list(resolve(doc, at(doc, 'components', 'schemas', 'PlatformCode'))['enum']);
}

function page(doc: Obj): Obj {
  return resolve(doc, at(response(doc, path, 'get'), 'properties', 'data'));
}

function item(doc: Obj): Obj {
  return resolve(doc, at(page(doc), 'properties', 'items', 'items'));
}

// 展开后的 schema 里所有 properties 的键名（不看描述文字）。
function propertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(propertyNames);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Obj;
  const own =
    node['properties'] !== null && typeof node['properties'] === 'object'
      ? Object.keys(node['properties'] as Obj)
      : [];
  return [...own, ...Object.values(node).flatMap(propertyNames)];
}

it('[AC-CT-26x#5] 登记 GET /admin/v1/product-feedbacks：adminListProductFeedbacks、后台鉴权、planned、无幂等与 step-up、错误码恰为 10001/10403/20001', () => {
  const doc = contract();
  const op = operation(doc);
  expect(op).toMatchObject({ operationId, 'x-auth': 'admin', 'x-implementation': 'planned' });
  expect(op['security']).toEqual([{ adminBearerAuth: [] }]);
  for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
    expect([undefined, false], key).toContain(op[key]);
  expect(op).not.toHaveProperty('x-step-up');
  expect(op).not.toHaveProperty('requestBody');
  const names = rawParams(doc).map((raw) => text(resolve(doc, raw)['name']).toLowerCase());
  for (const name of ['x-step-up-token', 'idempotency-key', 'x-sign', 'x-app-id'])
    expect(names).not.toContain(name);
  const codes = list(op['x-error-codes']);
  expect(codes).toHaveLength(3);
  expect(codes).toEqual(expect.arrayContaining([10001, 10403, 20001]));
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']);
  for (const code of codes)
    expect(
      catalog.filter((entry) => at(entry)['code'] === code),
      String(code),
    ).toHaveLength(1);
});

it('[AC-CT-26x#6] 描述写明 feedback.view、只读无 step-up、不写审计、缺权限 10403 admin_permission_denied', () => {
  const desc = descriptionOf(contract());
  expect(desc).toContain(permission);
  expect(desc).toMatch(/只读|read[- ]only/i);
  expect(desc).toMatch(/(无|不需要?|不设|没有)\s*`?step-up|no\s+`?step-up|without\s+`?step-up/i);
  expect(desc).toMatch(
    /(不写|不记|不留|不产生|不落)\s*审计|(does not|doesn't|never|not)\s+(write|record|create)s?\s+(an?\s+)?audit|no\s+audit/i,
  );
  expect(desc).toContain('10403');
  expect(desc).toContain('admin_permission_denied');
});

it('[AC-CT-26x#7] 描述写明只列本控制台 app 的记录、注销用户的反馈已删除（BR-ID-28）、游客记录 user_id 为 null', () => {
  const desc = descriptionOf(contract());
  expect(desc).toMatch(/本控制台|本\s*app|(the|this|console's|own)\s+app\b/i);
  expect(desc).toContain('BR-ID-28');
  expect(desc).toMatch(/注销|account (deletion|closure)|deleted (user|account|member)s?/i);
  expect(desc).toMatch(/游客|guest/i);
  expect(desc).toMatch(/user_id`?[^。]{0,40}?null/);
});

it('[AC-CT-26x#8] 描述写明按 created_at 降序排列', () => {
  const desc = descriptionOf(contract());
  expect(desc).toMatch(/created_at`?\s*(降序|倒序|desc)/i);
});

it('[AC-CT-26x#9] 参数恰为 X-Trace-Id、page、page_size、platform、reason、from、to；前三个引用现有组件，筛选都可选', () => {
  const doc = contract();
  const raws = rawParams(doc);
  for (const name of ['TraceId', 'AdminPage', 'AdminPageSize'])
    expect(raws, name).toContainEqual({ $ref: `#/components/parameters/${name}` });
  const resolved = raws.map((raw) => resolve(doc, raw));
  expect(resolved.map((entry) => text(entry['name'])).sort()).toEqual(
    ['X-Trace-Id', ...queryNames].sort(),
  );
  expect(param(doc, 'X-Trace-Id')['in']).toBe('header');
  for (const name of queryNames) {
    const entry = param(doc, name);
    expect(entry['in'], name).toBe('query');
    expect([undefined, false], name).toContain(entry['required']);
  }
  const size = resolve(doc, at(param(doc, 'page_size'), 'schema'));
  expect(size['maximum']).toBe(200);
  accepts(doc, size, [1, 200], [0, 201, 1.5, '20']);
  accepts(doc, resolve(doc, at(param(doc, 'page'), 'schema')), [1, 2], [0, -1, 1.5]);
});

it('[AC-CT-26x#10] 筛选 platform 取 PlatformCode，reason 取 price / rebate / info / other', () => {
  const doc = contract();
  const platform = resolve(doc, at(param(doc, 'platform'), 'schema'));
  expect(list(platform['enum'])).toEqual(platformEnum(doc));
  accepts(doc, platform, ['taobao', 'jd', 'pdd'], ['unknown', '', 'TAOBAO', null, 1]);
  const holder = { type: 'object', properties: { reason: at(param(doc, 'reason'), 'schema') } };
  enumField(doc, holder, 'reason', reasons);
});

it('[AC-CT-26x#11] from（含）、to（不含）都是 date-time；from 不早于 to 时 20001 且 data.fields 为 from、to', () => {
  const doc = contract();
  for (const name of ['from', 'to']) {
    const schema = resolve(doc, at(param(doc, name), 'schema'));
    expect(schema['format'], name).toBe('date-time');
    accepts(doc, schema, goodTimes, badTimes);
  }
  const desc = descriptionOf(contract());
  expect(desc).toContain('20001');
  expect(desc).toMatch(/fields/);
  expect(desc).toMatch(/from[\s\S]{0,40}?to/);
  // 「含」不能借「不含」「不包含」凑数。
  expect(desc).toMatch(/inclusive|(?<!不)(?<!不包)含/i);
  expect(desc).toMatch(/exclusive|不含|不包含/i);
});

it('[AC-CT-26x#12] 200 响应是后台分页信封：code/msg/data/trace_id，data 含 items、page、page_size、total', () => {
  const doc = contract();
  const schema = response(doc, path, 'get');
  expect(list(schema['required'])).toEqual(
    expect.arrayContaining(['code', 'msg', 'data', 'trace_id']),
  );
  accepts(doc, at(schema, 'properties', 'code'), [0], [1, '0', null]);
  const data = page(doc);
  expect(list(data['required'])).toEqual(
    expect.arrayContaining(['items', 'page', 'page_size', 'total']),
  );
  expect(field(doc, data, 'items')['type']).toBe('array');
  accepts(doc, field(doc, data, 'page'), [1, 2], [0, -1, 1.5, '1', null]);
  accepts(doc, field(doc, data, 'page_size'), [1, 200], [0, 201, 1.5, '1', null]);
  accepts(doc, field(doc, data, 'total'), [0, 1], [-1, 1.5, '1', null]);
  accepts(
    doc,
    data,
    [{ items: [guestItem, memberItem], page: 1, page_size: 20, total: 2 }],
    [{ items: [guestItem], page: 1, page_size: 20 }],
  );
});

it('[AC-CT-26x#13] 列表项封闭且恰为 12 个字段，全部 required', () => {
  const doc = contract();
  const schema = item(doc);
  closed(schema, itemKeys);
  missingRejected(doc, schema, memberItem, itemKeys);
  accepts(doc, schema, [guestItem, memberItem], [{ ...guestItem, extra: 1 }]);
});

it('[AC-CT-26x#14] 列表项各字段的取值：金额为非负整数分，item_ref / shown_rebate_fen / note / user_id 可为 null，note ≤ 100', () => {
  const doc = contract();
  const schema = item(doc);
  accepts(doc, field(doc, schema, 'id'), [id], [null, 1]);
  accepts(doc, field(doc, schema, 'link_id'), [id], [null, 1]);
  accepts(doc, field(doc, schema, 'user_id'), [null, id], [1, {}]);
  expect(list(field(doc, schema, 'platform')['enum'])).toEqual(platformEnum(doc));
  accepts(doc, field(doc, schema, 'platform'), ['taobao', 'pdd'], ['unknown', null]);
  accepts(doc, field(doc, schema, 'product_key'), ['pdd:1234567890'], [null, 1]);
  accepts(doc, field(doc, schema, 'item_ref'), [null, 'opaque-item-ref'], [1, {}]);
  accepts(doc, field(doc, schema, 'shown_final_price_fen'), [0, 1990], [-1, 1.5, '1990', null]);
  accepts(doc, field(doc, schema, 'shown_rebate_fen'), [null, 0, 120], [-1, 1.5, '120']);
  accepts(
    doc,
    field(doc, schema, 'note'),
    [null, '价格不对', 'x'.repeat(100)],
    ['x'.repeat(101), 1],
  );
  enumField(doc, schema, 'reason', reasons);
  for (const name of ['quoted_at', 'created_at'])
    accepts(doc, field(doc, schema, name), goodTimes, badTimes);
});

it('[AC-CT-26x#15] 响应里不出现手机号、昵称、设备标识与 app_id', () => {
  const doc = contract();
  const schema = item(doc);
  const names = propertyNames(expand(doc, response(doc, path, 'get')));
  expect(names.filter((name) => forbiddenKey.test(name))).toEqual([]);
  const validate = compile(doc, schema);
  for (const extra of [
    { device_id: id },
    { device_hash: 'abc' },
    { phone: '13800000000' },
    { phone_masked: '138****0000' },
    { nickname: '小明' },
    { app_id: 'couli' },
  ])
    check(validate, { ...guestItem, ...extra }, false);
});

it('[AC-CT-26x#16] 200 示例过 schema，含一条游客记录（user_id null）与一条登录用户记录', () => {
  const doc = contract();
  const media = at(
    resolve(doc, at(operation(doc), 'responses', '200')),
    'content',
    'application/json',
  );
  const validate = compile(doc, response(doc, path, 'get'));
  const samples = examples(doc, media);
  for (const sample of samples) check(validate, sample, true);
  const items = samples.flatMap((sample) => list(at(sample, 'data')['items']).map(object));
  expect(items.some((entry) => entry['user_id'] === null)).toBe(true);
  expect(items.some((entry) => typeof entry['user_id'] === 'string')).toBe(true);
});
