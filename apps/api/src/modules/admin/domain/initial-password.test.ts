import { expect, it } from 'vitest';
import { ADMIN_INITIAL_PASSWORD_LENGTH, generateAdminInitialPassword } from './initial-password.ts';
import { ADMIN_PASSWORD_MAX_LENGTH, ADMIN_PASSWORD_MIN_LENGTH } from './login-policy.ts';

it('[AC-B1-34h] initial password: fixed length within the admin limits, three classes, no look-alikes', () => {
  expect(ADMIN_INITIAL_PASSWORD_LENGTH).toBeGreaterThanOrEqual(ADMIN_PASSWORD_MIN_LENGTH);
  expect(ADMIN_INITIAL_PASSWORD_LENGTH).toBeLessThanOrEqual(ADMIN_PASSWORD_MAX_LENGTH);
  for (let i = 0; i < 200; i++) {
    const value = generateAdminInitialPassword();
    expect(value).toHaveLength(ADMIN_INITIAL_PASSWORD_LENGTH);
    expect(value).toMatch(/^[A-Za-z0-9]+$/);
    expect(value).toMatch(/[A-Z]/);
    expect(value).toMatch(/[a-z]/);
    expect(value).toMatch(/[0-9]/);
    expect(value).not.toMatch(/[0O1lIo]/);
  }
});
