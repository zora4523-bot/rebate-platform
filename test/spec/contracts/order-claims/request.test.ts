import { expect, it } from 'vitest';
import { at, check, closed, compile, contract, request, requestSchema, resolve } from './kit.ts';

it('[CT-04f#4] 请求仅有三个必填字段，复用平台枚举并约束日期和单号长度', () => {
  const doc = contract();
  const schema = requestSchema(doc);
  closed(schema, ['platform', 'order_no', 'paid_date']);
  expect(at(schema, 'properties', 'platform')['$ref']).toBe('#/components/schemas/PlatformCode');
  expect(resolve(doc, at(schema, 'properties', 'order_no'))).toMatchObject({
    type: 'string',
    minLength: 1,
    maxLength: 64,
  });
  expect(resolve(doc, at(schema, 'properties', 'paid_date'))).toMatchObject({
    type: 'string',
    format: 'date',
  });
});

it('[CT-04f#5] Ajv2020 strict 接受合法请求及单号长度两端，拒绝缺字段、错日期和扩展字段', () => {
  const doc = contract();
  const validate = compile(doc, requestSchema(doc));
  for (const order_no of ['1', request.order_no, '2310061234567890', '1'.repeat(64)]) {
    check(validate, { ...request, order_no }, true);
  }
  for (const key of ['platform', 'order_no', 'paid_date']) {
    const missing: Record<string, unknown> = { ...request };
    delete missing[key];
    check(validate, missing, false);
  }
  for (const patch of [
    { paid_date: '2026/10/20' },
    { paid_date: '2026-02-30' },
    { paid_date: null },
    { paid_date: '2026-10-20T00:00:00+08:00' },
    { order_no: '' },
    { order_no: '1'.repeat(65) },
    { order_no: 2310061234567890 },
    { platform: 'unknown' },
    { platform: null },
    { diagnostic: {} },
    { user_id: 'other-user' },
    { app_id: 'other-app' },
  ])
    check(validate, { ...request, ...patch }, false);
  for (const invalid of [null, [], '231006-1234567890']) check(validate, invalid, false);
});
