import { describe, expect, it } from 'vitest';
import {
  SMS_CREDENTIAL_ENV_NAMES,
  findCredentialLikeEnvNames,
  looksLikeRealCredentialEnvName,
} from './credential-env.ts';

describe('looksLikeRealCredentialEnvName', () => {
  it.each([
    'UNION_SECRET',
    'UNION_TAOBAO_APP_SECRET',
    'ALIPAY_PRIVATE_KEY',
    'ALIPAY_APP_PRIVATE_KEY',
    'BANK_CHANNEL_ACCESS_KEY',
    'SMS_ALIYUN_ACCESS_KEY_ID',
    'SMS_ALIYUN_ACCESS_KEY_SECRET',
    'sms_aliyun_access_key_secret',
  ])('matches %s', (name) => {
    expect(looksLikeRealCredentialEnvName(name)).toBe(true);
  });

  it('[BR-ID-05] declares the SMS adapter credentials by name, each SMS_-prefixed and unique', () => {
    expect(SMS_CREDENTIAL_ENV_NAMES.length).toBeGreaterThan(0);
    expect(new Set(SMS_CREDENTIAL_ENV_NAMES).size).toBe(SMS_CREDENTIAL_ENV_NAMES.length);
    for (const name of SMS_CREDENTIAL_ENV_NAMES) {
      expect(name).toMatch(/^SMS_[A-Z0-9_]+$/);
      expect(looksLikeRealCredentialEnvName(name)).toBe(true);
    }
    expect(Object.isFrozen(SMS_CREDENTIAL_ENV_NAMES)).toBe(true);
  });

  // The SMS part of the provisional pattern is replaced by the declared names (ruling B1-02e
  // §9.5 #4): an SMS_ variable that no adapter reads is not a credential.
  it.each(['SMS_ACCESS_KEY', 'SMS_ALIYUN_SECRET', 'SMS_SIGN_NAME', 'SMS_ALIYUN_ACCESS_KEY_ID_X'])(
    'does not match the undeclared SMS name %s',
    (name) => {
      expect(looksLikeRealCredentialEnvName(name)).toBe(false);
    },
  );

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
        SMS_ALIYUN_ACCESS_KEY_SECRET: 'x',
        ALIPAY_PRIVATE_KEY: 'y',
        UNION_SECRET: '',
        BANK_CARD_SECRET: undefined,
        PATH: '/usr/bin',
      }),
    ).toEqual(['ALIPAY_PRIVATE_KEY', 'SMS_ALIYUN_ACCESS_KEY_SECRET']);
  });

  it('returns an empty list for a clean environment', () => {
    expect(findCredentialLikeEnvNames({ APP_ENV: 'local', HOME: '/home/x' })).toEqual([]);
  });
});
