import { expect, it } from 'vitest';
import { INSTALL_SECRET_BYTES, newInstallSecret } from './issue.ts';

it('[AC-B1-02c#7] issues 256-bit install secrets as unpadded base64url within the contract length', () => {
  const issued = Array.from({ length: 50 }, () => newInstallSecret());
  for (const value of issued) {
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(value, 'base64url')).toHaveLength(INSTALL_SECRET_BYTES);
    expect(value.length).toBeGreaterThanOrEqual(16);
    expect(value.length).toBeLessThanOrEqual(128);
  }
  expect(new Set(issued).size).toBe(issued.length);
});
