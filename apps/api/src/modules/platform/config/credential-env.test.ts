import { describe, expect, it } from 'vitest';
import { findCredentialLikeEnvNames, looksLikeRealCredentialEnvName } from './credential-env.ts';

describe('looksLikeRealCredentialEnvName', () => {
  it.each([
    'UNION_SECRET',
    'UNION_TAOBAO_APP_SECRET',
    'ALIPAY_PRIVATE_KEY',
    'ALIPAY_APP_PRIVATE_KEY',
    'BANK_CHANNEL_ACCESS_KEY',
    'SMS_ACCESS_KEY',
    'SMS_ALIYUN_ACCESS_KEY',
    'sms_aliyun_secret',
  ])('matches %s', (name) => {
    expect(looksLikeRealCredentialEnvName(name)).toBe(true);
  });

  it.each([
    'UNION_APP_KEY',
    'UNION_SECRET_ID',
    'ALIPAY_APP_ID',
    'ALIPAY_PRIVATE_KEY_PATH',
    'MY_UNION_SECRET',
    'UNIONS_SECRET',
    'SMS_SIGN_NAME',
    'BANK_',
    'SECRET',
    'DATABASE_URL',
    'UNION__SECRET',
    'UNION_SEC-RET',
  ])('does not match %s', (name) => {
    expect(looksLikeRealCredentialEnvName(name)).toBe(false);
  });
});

describe('findCredentialLikeEnvNames', () => {
  it('returns sorted names that are set to a non-empty value', () => {
    expect(
      findCredentialLikeEnvNames({
        SMS_ACCESS_KEY: 'x',
        ALIPAY_PRIVATE_KEY: 'y',
        UNION_SECRET: '',
        BANK_CARD_SECRET: undefined,
        PATH: '/usr/bin',
      }),
    ).toEqual(['ALIPAY_PRIVATE_KEY', 'SMS_ACCESS_KEY']);
  });

  it('returns an empty list for a clean environment', () => {
    expect(findCredentialLikeEnvNames({ APP_ENV: 'local', HOME: '/home/x' })).toEqual([]);
  });
});
