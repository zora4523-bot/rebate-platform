import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
  prop,
  reasons,
  refunds,
  request,
  required,
  resolveEndpoint,
  values,
} from './kit.ts';

it('[AC-CT-21e#7] 人工处置只能提交 PENDING + query_and_settle，不能上传终态或自造渠道证据', () => {
  const doc = contract();
  const schema = request(doc, resolveEndpoint);
  required(schema, ['expected_status', 'action']);
  expect(Object.keys(at(schema, 'properties')).toSorted()).toEqual(['action', 'expected_status']);
  expect(values(prop(doc, schema, 'expected_status'))).toEqual(['PENDING']);
  expect(values(prop(doc, schema, 'action'))).toEqual(['query_and_settle']);
  const validate = compile(doc, schema);
  const valid = { expected_status: 'PENDING', action: 'query_and_settle' };
  check(validate, valid, true);
  for (const key of ['expected_status', 'action']) {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[key];
    check(validate, missing, false);
  }
  for (const patch of [
    { expected_status: 'PAID' },
    { expected_status: 'CLOSED' },
    { expected_status: null },
    { action: 'mark_paid' },
    { action: 'close' },
    { action: 'refund' },
    { action: null },
    { status: 'PAID' },
    { channel_result: 'PAID' },
    { evidence: 'client-supplied' },
    { needs_manual: true },
    { user_id: 'another-user' },
    { app_id: 'another-app' },
  ])
    check(validate, { ...valid, ...patch }, false);
  for (const invalid of [null, [], 'query_and_settle']) check(validate, invalid, false);
});

it.each(refunds)('[AC-CT-21e#8] %s %s 退款金额为正整数分且原因码必选', (...endpoint) => {
  const doc = contract();
  const schema = request(doc, endpoint);
  required(schema, ['amount_fen', 'reason_code']);
  expect(schema['required']).not.toContain('note');
  expect(Object.keys(at(schema, 'properties')).toSorted()).toEqual([
    'amount_fen',
    'note',
    'reason_code',
  ]);
  expect(prop(doc, schema, 'amount_fen')).toMatchObject({ type: 'integer', format: 'int64' });
  expect(values(prop(doc, schema, 'reason_code')).toSorted()).toEqual(reasons.toSorted());
  expect(JSON.stringify(at(schema, 'properties', 'reason_code'))).toContain('$ref');
  const validate = compile(doc, schema);
  const valid = { amount_fen: 1, reason_code: 'USER_REQUEST' };
  for (const reason_code of reasons) {
    check(validate, { ...valid, reason_code }, true);
    check(validate, { ...valid, amount_fen: 12345, reason_code, note: '人工核实后原路退回' }, true);
  }
  for (const key of ['amount_fen', 'reason_code']) {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[key];
    check(validate, missing, false);
  }
  for (const amount_fen of [0, -1, 0.1, 1.5, '1', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    check(validate, { ...valid, amount_fen }, false);
  }
  for (const reason_code of ['', 'unknown', 'user_request', null, 1]) {
    check(validate, { ...valid, reason_code }, false);
  }
  // 原路退款：目标由路径确定，账号、操作人、单号和终态均不能由请求体覆写。
  for (const patch of [
    { target_id: 'another-target' },
    { target_type: 'pay_anomaly' },
    { pay_channel: 'alipay' },
    { payout_account: 'other-account' },
    { operator: 'another-admin' },
    { out_refund_no: 'client-assigned' },
    { status: 'SUCCESS' },
    { user_id: 'another-user' },
    { app_id: 'another-app' },
  ])
    check(validate, { ...valid, ...patch }, false);
  for (const invalid of [null, [], 'refund']) check(validate, invalid, false);
});
