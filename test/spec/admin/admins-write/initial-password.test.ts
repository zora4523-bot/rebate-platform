import { expect, it } from 'vitest';
import { generateAdminInitialPassword } from '../../../../apps/api/src/modules/admin/domain/initial-password.ts';
import {
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
} from '../../../../apps/api/src/modules/admin/domain/login-policy.ts';

// BR-ID-43「初始密码」, task §9: CSPRNG, told face to face or in a private chat. The length limits
// are the admin password's own (login-policy), the contract caps initial_password at 128.
it('[AC-B1-34h#2] 初始密码每次新生成：长度在后台密码范围内、不含空白、互不相同', () => {
  const samples = Array.from({ length: 256 }, () => generateAdminInitialPassword());
  for (const sample of samples) {
    expect(typeof sample).toBe('string');
    expect([...sample].length).toBeGreaterThanOrEqual(ADMIN_PASSWORD_MIN_LENGTH);
    expect([...sample].length).toBeLessThanOrEqual(ADMIN_PASSWORD_MAX_LENGTH);
    expect(sample).toMatch(/^\S+$/u);
  }
  expect(new Set(samples).size).toBe(samples.length);
  // Neither a counter nor a tiny alphabet: together the samples use many different characters.
  expect(new Set(samples.join('')).size).toBeGreaterThanOrEqual(16);
});
