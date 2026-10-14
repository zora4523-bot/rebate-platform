import { expect, it } from 'vitest';
import { createIpAllowlist, newPasswordShapeOk, nextLoginStep } from './login-policy.ts';

it('[AC-F1-06k] the whitelist matches addresses and ranges of both families, mapped IPv4 included', () => {
  const allows = createIpAllowlist(['192.0.2.0/24', '2001:db8::/32', '198.51.100.7']);
  for (const ip of ['192.0.2.1', '192.0.2.254', '::ffff:192.0.2.9', '2001:db8::42', '198.51.100.7'])
    expect(allows(ip)).toBe(true);
  for (const ip of ['192.0.3.1', '198.51.100.8', '2001:db9::1', '127.0.0.1', 'garbage', undefined])
    expect(allows(ip)).toBe(false);
});

it('[AC-F1-06k] without a whitelist only loopback sources pass', () => {
  const allows = createIpAllowlist(null);
  for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])
    expect(allows(ip)).toBe(true);
  for (const ip of ['192.0.2.1', '::2', '10.0.0.1']) expect(allows(ip)).toBe(false);
});

it('[AC-F1-06k] next step: initial password first, then the binding, then the code', () => {
  expect(nextLoginStep({ passwordMustChange: true, totpBound: false })).toBe('change_password');
  expect(nextLoginStep({ passwordMustChange: true, totpBound: true })).toBe('change_password');
  expect(nextLoginStep({ passwordMustChange: false, totpBound: false })).toBe('bind_totp');
  expect(nextLoginStep({ passwordMustChange: false, totpBound: true })).toBe('totp');
});

it('[AC-F1-06k] new password: 10 to 128 characters and not the account name', () => {
  expect(newPasswordShapeOk('a'.repeat(9), 'ops')).toBe(false);
  expect(newPasswordShapeOk('a'.repeat(10), 'ops')).toBe(true);
  expect(newPasswordShapeOk('a'.repeat(128), 'ops')).toBe(true);
  expect(newPasswordShapeOk('a'.repeat(129), 'ops')).toBe(false);
  expect(newPasswordShapeOk('ops-account-1', 'ops-account-1')).toBe(false);
});
