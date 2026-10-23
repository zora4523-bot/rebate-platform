// B1-34i: the verify phone normaliser follows the shared BR-ID-05 vectors exactly.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { normalizeVerifyPhone, verifyPhoneCodeContext } from './verify-phone-policy.ts';

interface Vector {
  readonly input: string;
  readonly note: string;
  readonly expected?: string;
}

const url = new URL('../../../../../../specs/phone-normalize.vectors.json', import.meta.url);
const cases = (JSON.parse(readFileSync(url, 'utf8')) as { cases: Vector[] }).cases;

it('[AC-B1-34i] 验证手机号规范化与共享向量一致（有效得 11 位号，无效得 null）', () => {
  expect(cases.length).toBeGreaterThan(0);
  for (const vector of cases) {
    expect([vector.note, normalizeVerifyPhone(vector.input)]).toEqual([
      vector.note,
      vector.expected ?? null,
    ]);
  }
});

it('[AC-B1-34i] 新号验证码的哈希上下文按账号区分，且与短信档验证码的上下文不同', () => {
  const a = verifyPhoneCodeContext({ appId: 'app_a', adminId: 'one' });
  expect(a).toBe('admin_users.verify_phone_code:app_a:one');
  expect(verifyPhoneCodeContext({ appId: 'app_a', adminId: 'two' })).not.toBe(a);
  expect(a.startsWith('admin_step_up.sms_code:')).toBe(false);
});
