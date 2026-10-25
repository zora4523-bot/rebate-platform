import { expect, it } from 'vitest';
import { definedVariablesOf } from './catalog.ts';
import { chineseNumber, previewProblem } from './preview.ts';
import { createFakeNotifySmsTestSender } from './sms-test-sender.ts';
import { itemOf, type TemplateRow } from './view.ts';

const none = (): readonly string[] => [];
const AT = new Date('2026-10-08T01:00:00.000Z');

function row(patch: Partial<TemplateRow>): TemplateRow {
  return {
    code: 'WD_FAILED',
    variant: 'default',
    category: 'service',
    channels: ['push', 'inbox', 'sms'],
    row_version: 0,
    updated_at: AT,
    sms_sign_name: null,
    sms_template_code: null,
    sms_template_type: null,
    sms_preview_text: null,
    sms_pending_sign_name: null,
    sms_pending_template_code: null,
    sms_pending_template_type: null,
    sms_pending_preview_text: null,
    sms_test_status: null,
    sms_tested_at: null,
    ...patch,
  };
}

it('[AC-B1-12z#35] preview placeholders must be exactly the variables of the variant', () => {
  const check = { variables: ['code'], signName: '凑狸', codeTtlSec: null, bannedWords: none };
  expect(previewProblem({ ...check, text: '你的验证码是${code}。' })).toBeUndefined();
  const texts = ['你的验证码。', '你的验证码是${code}，${nickname}。', '你的${verify_code}。'];
  for (const text of texts) {
    expect(previewProblem({ ...check, text }), text).toEqual({
      reason: 'notify_preview_vars_mismatch',
    });
  }
});

it('[AC-B1-12z#36] a stated validity must equal the code validity; none stated passes', () => {
  const check = { variables: ['code'], signName: '凑狸', codeTtlSec: 300, bannedWords: none };
  expect(previewProblem({ ...check, text: '验证码${code}，5分钟内有效。' })).toBeUndefined();
  expect(previewProblem({ ...check, text: '验证码${code}。' })).toBeUndefined();
  expect(previewProblem({ ...check, text: '验证码${code}，10分钟内有效。' })).toEqual({
    reason: 'notify_code_ttl_mismatch',
  });
});

it('[AC-B1-12z#36] Chinese numerals before 分钟 count; 分钟 without a number fails', () => {
  const check = { variables: ['code'], signName: '凑狸', codeTtlSec: 300, bannedWords: none };
  const mismatch = { reason: 'notify_code_ttl_mismatch' };
  expect(previewProblem({ ...check, text: '验证码${code}，五分钟内有效。' })).toBeUndefined();
  for (const text of ['${code}，十分钟内有效', '${code}，两分钟内有效', '${code}，几分钟内有效']) {
    expect(previewProblem({ ...check, text }), text).toEqual(mismatch);
  }
  expect(chineseNumber('十五')).toBe(15);
  expect(chineseNumber('二十')).toBe(20);
  expect(chineseNumber('一百零五')).toBe(105);
  expect(chineseNumber('一二')).toBeNull();
});

it('[AC-B1-12z#37] platform name, 官方 and forbidden words follow the field', () => {
  const check = { variables: ['code'], signName: '凑狸', codeTtlSec: null };
  const banned = (text: string): readonly string[] => (text.includes('稳赚') ? ['稳赚'] : []);
  const leading = previewProblem({ ...check, bannedWords: banned, text: '淘宝：${code}稳赚' });
  expect(leading).toEqual({ words: ['淘宝', '稳赚'] });
  const official = previewProblem({ ...check, bannedWords: none, text: '【凑狸】官方：${code}' });
  expect(official).toEqual({ words: ['官方'] });
  // Only the registration's own signature is taken off before the platform-name check.
  const other = previewProblem({ ...check, bannedWords: none, text: '【京东】你的${code}' });
  expect(other).toEqual({ words: ['京东'] });
  const own = previewProblem({ ...check, bannedWords: none, text: '【凑狸】京东：${code}' });
  expect(own).toEqual({ words: ['京东'] });
});

it('[AC-B1-12z#31] SMS variables are per variant, with no fallback to default', () => {
  expect(definedVariablesOf('CLAIM_RESULT', 'approved')).toEqual(['rebate']);
  expect(definedVariablesOf('CLAIM_RESULT', 'rejected')).toEqual(['reason']);
  expect(definedVariablesOf('CLAIM_RESULT', 'default')).toBeUndefined();
  expect(definedVariablesOf('WD_REJECTED', 'negative_balance')).toEqual(['reason']);
  expect(definedVariablesOf('WD_FAILED', 'other')).toBeUndefined();
  expect(definedVariablesOf('WATCH_PRICE_DROP', 'default')).toBeUndefined();
});

it('[AC-B1-12z#7] readiness, state and fallback follow the rows of every variant', () => {
  const context = { fundTerms: true, codeTtlSec: 300 };
  const pending = row({
    sms_pending_sign_name: '凑狸',
    sms_pending_template_code: 'SMS_1',
    sms_pending_template_type: 'notice',
    sms_pending_preview_text: '你的${amount}。',
    sms_test_status: 'accepted',
    sms_tested_at: AT,
  });
  expect(itemOf('WD_FAILED', [pending], context)).toMatchObject({
    sms_ready: false,
    sms_state: 'enabled_not_ready',
    sms_billing_confirm: false,
  });
  const smsCode = itemOf('SMS_CODE', [row({ code: 'SMS_CODE', channels: ['sms'] })], context);
  expect(smsCode).toMatchObject({
    push_switchable: false,
    sms_fixed: true,
    sms_state: 'enabled',
    sms_deploy_fallback: true,
    sms_code_ttl_sec: 300,
  });
  const inboxOnly = itemOf('BALANCE_ADJUSTED', [row({ channels: ['inbox'] })], context);
  expect(inboxOnly).toMatchObject({ push_switchable: false, sms_registrations: [] });
});

it('[AC-B1-12z#59] the fake fixes the in-flight outcome before its hook runs', async () => {
  const sender = createFakeNotifySmsTestSender('test');
  const message = { appId: 'a', phone: '13800000000', signName: 's', templateCode: 't' };
  sender.enqueueResult('rejected');
  let inner: string | undefined;
  sender.beforeNextAnswer(async () => {
    inner = await sender.send({ ...message, templateCode: 'rival', params: {} });
  });
  await expect(sender.send({ ...message, params: {} })).resolves.toBe('rejected');
  expect(inner).toBe('accepted');
  expect(sender.outbox().map((m) => m.templateCode)).toEqual(['t', 'rival']);
  expect(() => createFakeNotifySmsTestSender('prod')).toThrow();
});
