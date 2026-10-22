import { expect, it } from 'vitest';
import {
  accepts,
  at,
  body,
  check,
  compile,
  contract,
  data,
  description,
  enumField,
  errorExamples,
  errorWith,
  expand,
  field,
  from,
  id,
  item,
  list,
  missingRejected,
  object,
  op,
  propertiesIn,
  required,
  resolve,
  statuses,
  syncPath,
  to,
} from './kit.ts';

it('[AC-CT-24n#4] 手动同步请求二选一，子单号数量 1–50，禁止混合模式和身份注入', () => {
  const doc = contract();
  const schema = body(doc, syncPath);
  expect(propertiesIn(doc, schema, 'status_filter').length).toBeGreaterThan(0);
  const validate = compile(doc, schema);
  const window = { platform: 'pdd', from, to };
  const numbers = { platform: 'pdd', order_nos: ['231006-1234567891'] };
  missingRejected(doc, schema, window, ['platform', 'from', 'to']);
  missingRejected(doc, schema, numbers, ['platform', 'order_nos']);
  check(
    validate,
    { ...numbers, order_nos: Array.from({ length: 50 }, (_, n) => `sub-${n}`) },
    true,
  );
  for (const invalid of [
    { ...numbers, order_nos: [] },
    { ...numbers, order_nos: Array.from({ length: 51 }, (_, n) => `sub-${n}`) },
    { ...numbers, order_nos: [''] },
    { ...numbers, order_nos: [1] },
    { ...numbers, order_nos: '231006-1234567891' },
    { ...window, order_nos: numbers.order_nos },
    { ...numbers, from },
    { ...numbers, to },
    { ...window, status: 'queued' },
    { ...window, from: 'yesterday' },
    { ...window, to: '2026-02-30T00:00:00Z' },
    { ...window, platform: 'unknown' },
    { ...numbers, platform: null },
    { ...window, status_filter: {} },
    { ...numbers, status_filter: 'PAID' },
  ])
    check(validate, invalid, false);
  for (const value of [window, numbers]) {
    for (const key of ['app_id', 'requested_by', 'user_id', 'step_up_token'])
      check(validate, { ...value, [key]: id }, false);
  }
  // 平台登记值、回扫范围和跨字段时间比较由处理器验证，不能臆造平台报文或状态值。
  const desc = description(doc, syncPath) + JSON.stringify(expand(doc, schema));
  expect(desc).toContain('status_filter');
  expect(desc).toMatch(/specs\/union|登记|registered/i);
  expect(desc).toMatch(/earliest_from|回扫|lookback|look-back/i);
  expect(desc).toMatch(/20001/);
  errorWith(doc, syncPath, 20001, { fields: ['status_filter'] });
});

it('[AC-CT-24n#5] 创建同步返回任务身份、状态、复用标记与创建时间', () => {
  const doc = contract();
  const schema = data(doc, syncPath);
  const value = { sync_id: id, status: 'queued', reused: false, created_at: from };
  missingRejected(doc, schema, value, ['sync_id', 'status', 'reused', 'created_at']);
  const validate = compile(doc, schema);
  for (const reused of [true, false]) check(validate, { ...value, reused }, true);
  check(validate, { ...value, status: 'running', reused: true }, true);
  check(validate, { ...value, reused: 'true' }, false);
  check(validate, { ...value, created_at: 'yesterday' }, false);
  check(validate, { ...value, status: 'pending' }, false);
  const desc = description(doc, syncPath);
  expect(desc).toMatch(/queued|排队/);
  expect(desc).toMatch(/running|执行/);
  expect(desc).toMatch(/reus|复用|原请求|去重/i);
});

it('[AC-CT-24n#6] 同步记录包含筛选、计数、操作者和可空完成时间', () => {
  const doc = contract();
  const schema = item(doc, syncPath);
  const keys = [
    'sync_id',
    'platform',
    'mode',
    'from',
    'to',
    'status_filter',
    'order_nos',
    'status',
    'requested_by',
    'requested_by_name',
    'fetched_count',
    'stored_count',
    'created_at',
    'finished_at',
  ];
  required(schema, keys);
  enumField(doc, schema, 'mode', ['window', 'order_nos']);
  enumField(doc, schema, 'status', statuses);
  for (const name of ['from', 'to', 'finished_at'])
    accepts(doc, field(doc, schema, name), [null, from], ['yesterday', 1]);
  accepts(doc, field(doc, schema, 'order_nos'), [null, ['231006-1234567891']], [1, [''], [1]]);
  accepts(doc, field(doc, schema, 'status_filter'), [null], [{}, []]);
  accepts(doc, field(doc, schema, 'requested_by_name'), [null, '张三', 'ops01'], [1, {}]);
  for (const name of ['fetched_count', 'stored_count'])
    accepts(doc, field(doc, schema, name), [0, 1, 10000], [-1, 1.5, '1', null]);
  const desc = JSON.stringify(expand(doc, schema)) + description(doc, syncPath, 'get');
  expect(desc).toContain('display_name');
  expect(desc).toMatch(/username|用户名/);
  expect(desc).toMatch(/deleted|删除/i);
});

it('[AC-CT-24n#7] limits 按平台给最早起点与最多单号数，不把回扫日期写死', () => {
  const doc = contract();
  const schema = data(doc, `${syncPath}/limits`, 'get');
  // 任务未指定 limits 外层容器名；支持数组、items/platforms 数组或平台键对象。
  let entries: ReturnType<typeof object>[];
  let namedEntries = schema['type'] === 'array';
  if (schema['type'] === 'array') entries = [resolve(doc, at(schema, 'items'))];
  else {
    const properties = at(schema, 'properties');
    const array = Object.values(properties)
      .map((value) => resolve(doc, value))
      .find((value) => value['type'] === 'array');
    if (array !== undefined) {
      namedEntries = true;
      entries = [resolve(doc, at(array, 'items'))];
    } else entries = Object.values(properties).map((value) => resolve(doc, value));
  }
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    required(entry, ['earliest_from', 'max_order_nos']);
    if (namedEntries) required(entry, ['platform']);
    expect(field(doc, entry, 'earliest_from')).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
    accepts(doc, field(doc, entry, 'max_order_nos'), [50], [0, -1, 51, '50']);
  }
  const desc = description(doc, `${syncPath}/limits`, 'get');
  expect(desc).toMatch(/02\s*§?7\.1|02\s*§\s*7\.1/);
});

it('[AC-CT-24n#8] 站长授权暂停拒绝 30156，HTTP 422 并给出平台', () => {
  const doc = contract();
  expect(list(op(doc, syncPath)['x-error-codes'])).toContain(30156);
  expect(errorExamples(doc, syncPath, 'post', '422')).toContainEqual(
    expect.objectContaining({
      code: 30156,
      data: expect.objectContaining({ platform: expect.any(String) }),
    }),
  );
  expect(description(doc, syncPath)).toMatch(/BR-ID-24|站长|webmaster|site.owner/i);
});
