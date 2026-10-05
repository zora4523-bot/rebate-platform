import { expect, it } from 'vitest';
import { SENSITIVE_KEYS } from '../../platform/index.ts';
import { AUDIT_REDACTED, redactSnapshot } from './audit-redaction.ts';

it('[AC-F1-06b-REDACT#1] replaces values under sensitive key names at any depth, keeps masked fields', () => {
  const input = {
    phone: '13800000000',
    phone_masked: '138****0000',
    nested: [{ ID_Card: '110101199001011234', note: 'ok' }],
    permissions: ['a', 'b'],
  };
  const copy = structuredClone(input);
  expect(redactSnapshot(input, SENSITIVE_KEYS)).toEqual({
    phone: AUDIT_REDACTED,
    phone_masked: '138****0000',
    nested: [{ ID_Card: AUDIT_REDACTED, note: 'ok' }],
    permissions: ['a', 'b'],
  });
  expect(input).toEqual(copy);
  expect(redactSnapshot([1, 'x', null], SENSITIVE_KEYS)).toEqual([1, 'x', null]);
});

it('[AC-F1-06b-REDACT#2] matches key names by contained fragment, without any extra names', () => {
  const after = {
    totp_secret: 'GEZDGNBV',
    totpSecretCipher: 'x',
    password_hash: 'x',
    verify_phone: '13800138000',
    verify_phone_hmac: 'x',
    verify_phone_masked: '138****8000',
    stepUpToken: { level: 'sms' },
    is_super: true,
    login_name: 'ops-b',
  };
  expect(redactSnapshot(after)).toEqual({
    totp_secret: AUDIT_REDACTED,
    totpSecretCipher: AUDIT_REDACTED,
    password_hash: AUDIT_REDACTED,
    verify_phone: AUDIT_REDACTED,
    verify_phone_hmac: AUDIT_REDACTED,
    verify_phone_masked: '138****8000',
    stepUpToken: AUDIT_REDACTED,
    is_super: true,
    login_name: 'ops-b',
  });
});

it('[AC-F1-06b-REDACT#3] replaces phone-shaped values in free text and numbers, keeps ids', () => {
  const id = '019a0000-0000-7000-8000-000000000001';
  expect(
    redactSnapshot({
      note: '手机 13800138000，备用 +86 138-0013-8000',
      contact: 13800138000,
      count: 12,
      target: `admin:${id}`,
      order_no: 'T2031060713800138000',
      ids: [id],
    }),
  ).toEqual({
    note: `手机 ${AUDIT_REDACTED}，备用 ${AUDIT_REDACTED}`,
    contact: AUDIT_REDACTED,
    count: 12,
    target: `admin:${id}`,
    order_no: 'T2031060713800138000',
    ids: [id],
  });
});
