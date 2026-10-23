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
  failureReasons,
  field,
  from,
  id,
  importPath,
  item,
  missingRejected,
  multipartSchema,
  op,
  propertiesIn,
  required,
  resolve,
  statuses,
  to,
} from './kit.ts';

it('[AC-CT-24n#9] Excel 仅走 multipart，三种 kind 与渠道账号条件必填', () => {
  const doc = contract();
  const request = resolve(doc, at(op(doc, importPath), 'requestBody'));
  expect(at(request, 'content')).not.toHaveProperty('application/json');
  const files = propertiesIn(doc, body(doc, importPath, true), 'file');
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) expect(file).toMatchObject({ type: 'string', format: 'binary' });
  const schema = multipartSchema(doc);
  const validate = compile(doc, schema);
  const base = { kind: 'rights', platform: 'pdd', file: 'synthetic-xlsx-bytes' };
  missingRejected(doc, schema, base, ['kind', 'platform', 'file']);
  check(validate, { ...base, kind: 'punish' }, true);
  const channel = { ...base, kind: 'channel', union_account_id: id };
  missingRejected(doc, schema, channel, ['kind', 'platform', 'file', 'union_account_id']);
  for (const patch of [
    { kind: 'other' },
    { kind: null },
    { file: 1 },
    { file: null },
    { platform: 'unknown' },
    { platform: null },
    { app_id: id },
    { created_by: id },
    { step_up_token: 'token-must-be-in-header' },
  ])
    check(validate, { ...base, ...patch }, false);
  check(validate, { ...channel, union_account_id: null }, false);
  check(validate, { ...channel, union_account_id: '' }, false);
});

it('[AC-CT-24n#10] rights/punish 可按付款或收货筛选，channel 禁止三个时间字段', () => {
  const doc = contract();
  const schema = multipartSchema(doc);
  const validate = compile(doc, schema);
  const base = { platform: 'pdd', file: 'synthetic-xlsx-bytes' };
  for (const kind of ['rights', 'punish']) {
    check(validate, { ...base, kind }, true);
    for (const time_basis of ['paid', 'received'])
      check(validate, { ...base, kind, time_basis, from, to }, true);
    for (const patch of [
      { from },
      { to },
      { from, to },
      { time_basis: 'created' },
      { time_basis: null },
      { time_basis: 'paid', from: 'yesterday', to },
    ])
      check(validate, { ...base, kind, ...patch }, false);
  }
  for (const patch of [
    { time_basis: 'paid' },
    { time_basis: 'received' },
    { from },
    { to },
    { time_basis: 'paid', from, to },
    { time_basis: null },
    { from: null },
    { to: null },
  ])
    check(validate, { ...base, kind: 'channel', union_account_id: id, ...patch }, false);
});

it('[AC-CT-24n#11] 上传限制 xlsx / 万行，过大 HTTP 413 + 20001，重复文件仍建新任务', () => {
  const doc = contract();
  const desc = description(doc, importPath);
  expect(desc).toMatch(/xlsx/i);
  expect(desc).toMatch(/10[,_]?000|1\s*万|一万/);
  expect(desc).toContain('duplicate_rows');
  expect(desc).toMatch(/new (?:task|import|request)|新任务|新建任务/i);
  expect(desc).toContain('sub_order_no_missing');
  expect(desc).toMatch(/PUNISH/);
  expect(desc).toMatch(/relation_id/);
  for (const name of ['file', 'kind', 'time_basis', 'from', 'to'])
    errorWith(doc, importPath, 20001, { fields: [name] });
  const response = resolve(doc, at(op(doc, importPath), 'responses', '413'));
  expect(at(response, 'content', 'application/json')).toHaveProperty('schema');
  expect(errorExamples(doc, importPath, 'post', '413')).toContainEqual(
    expect.objectContaining({
      code: 20001,
      data: expect.objectContaining({ fields: ['body'] }),
    }),
  );
  const created = data(doc, importPath);
  missingRejected(doc, created, { import_id: id, status: 'queued' }, ['import_id', 'status']);
  accepts(doc, field(doc, created, 'status'), ['queued'], ['pending', null, 1]);
});

it.each(['list', 'detail'])('[AC-CT-24n#12] 导入 %s 返回状态、五类行数、操作者与时间', (kind) => {
  const doc = contract();
  const schema =
    kind === 'list' ? item(doc, importPath) : data(doc, `${importPath}/{import_id}`, 'get');
  required(schema, [
    'import_id',
    'kind',
    'platform',
    'status',
    'total_rows',
    'succeeded_rows',
    'failed_rows',
    'skipped_rows',
    'duplicate_rows',
    'created_by',
    'created_by_name',
    'created_at',
    'finished_at',
  ]);
  enumField(doc, schema, 'kind', ['rights', 'punish', 'channel']);
  enumField(doc, schema, 'status', statuses);
  for (const name of [
    'total_rows',
    'succeeded_rows',
    'failed_rows',
    'skipped_rows',
    'duplicate_rows',
  ])
    accepts(doc, field(doc, schema, name), [0, 1, 10000], [-1, 1.5, '1', null]);
  accepts(doc, field(doc, schema, 'created_by_name'), [null, '张三', 'ops01'], [1, {}]);
  accepts(doc, field(doc, schema, 'created_at'), [from], ['yesterday', null]);
  accepts(doc, field(doc, schema, 'finished_at'), [from, null], ['yesterday', 1]);
  const desc =
    JSON.stringify(expand(doc, schema)) +
    description(doc, kind === 'list' ? importPath : `${importPath}/{import_id}`, 'get');
  expect(desc).toContain('display_name');
  expect(desc).toMatch(/username|用户名/);
  expect(desc).toMatch(/deleted|删除/i);
});

it('[AC-CT-24n#13] 列表不带失败明细，详情返回全部逐行失败且原因是独立枚举', () => {
  const doc = contract();
  const summary = item(doc, importPath);
  expect(at(summary, 'properties')).not.toHaveProperty('failures');
  expect(summary['additionalProperties']).toBe(false);
  const detail = data(doc, `${importPath}/{import_id}`, 'get');
  required(detail, ['failures']);
  const failures = field(doc, detail, 'failures');
  expect(failures['type']).toBe('array');
  const failure = resolve(doc, at(failures, 'items'));
  required(failure, ['row_no', 'reason']);
  enumField(doc, failure, 'reason', failureReasons);
  accepts(doc, field(doc, failure, 'row_no'), [1, 2, 10000], [0, -1, 1.5, '1']);
  const validate = compile(doc, failures);
  check(validate, [], true);
  check(
    validate,
    failureReasons.map((reason, index) => ({ row_no: index + 1, reason })),
    true,
  );
  check(
    validate,
    Array.from({ length: 10000 }, (_, index) => ({ row_no: index + 1, reason: 'invalid_row' })),
    true,
  );
  for (const invalid of [
    [{ row_no: 1 }],
    [{ reason: 'invalid_row' }],
    [{ row_no: 1, reason: 20001 }],
    [{ row_no: 1, reason: 'unknown' }],
  ])
    check(validate, invalid, false);
});
