// D10-289 (B1-02zm): identity does not hand out platform's SMS_CREDENTIAL_ENV_NAMES, neither under
// its own name, nor as an exported value, nor as the return value of an exported function (the
// CT-06zt scan counts a function's return value as a re-export). Callers read the list from
// platform/config directly.
import { expect, it } from 'vitest';
import { SMS_CREDENTIAL_ENV_NAMES } from '../../../../apps/api/src/modules/platform/config/index.ts';
import * as fakeSms from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';

/** The identity entry at runtime; the URL import keeps Nest decorators out of the test compiler. */
async function identityEntry(): Promise<Record<string, unknown>> {
  return (await import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  )) as Record<string, unknown>;
}

const FORBIDDEN_NAMES = ['smsCredentialEnvNames', 'SMS_CREDENTIAL_ENV_NAMES'];

/** The platform list itself, or a copy with the same names in the same order. */
function isPlatformList(value: unknown): boolean {
  if (value === SMS_CREDENTIAL_ENV_NAMES) return true;
  if (!Array.isArray(value) || value.length !== SMS_CREDENTIAL_ENV_NAMES.length) return false;
  const names: readonly unknown[] = value;
  return names.every((name, i) => name === SMS_CREDENTIAL_ENV_NAMES[i]);
}

/** Exports that carry the list: by a forbidden name, as a value, or as a no-argument return value. */
function carriers(moduleExports: Record<string, unknown>, callNoArgFunctions: boolean): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(moduleExports)) {
    if (FORBIDDEN_NAMES.includes(name)) {
      found.push(`${name} (name)`);
      continue;
    }
    if (isPlatformList(value)) {
      found.push(`${name} (value)`);
      continue;
    }
    if (callNoArgFunctions && typeof value === 'function' && value.length === 0) {
      let result: unknown;
      try {
        result = (value as () => unknown)();
      } catch {
        continue;
      }
      if (isPlatformList(result)) found.push(`${name}() (return value)`);
    }
  }
  return found;
}

it('[AC-B1-02zm#1] identity/infra/fake-sms.ts does not export smsCredentialEnvNames', () => {
  expect(SMS_CREDENTIAL_ENV_NAMES.length).toBeGreaterThan(0);
  expect(Object.keys(fakeSms)).not.toContain('smsCredentialEnvNames');
});

it('[AC-B1-02zm#2] neither identity/infra/fake-sms.ts nor the identity entry hands out SMS_CREDENTIAL_ENV_NAMES (by name, as a value, or returned by an exported function)', async () => {
  // fake-sms.ts: every no-argument exported function is called and its result checked.
  expect(carriers(fakeSms as Record<string, unknown>, true)).toEqual([]);
  // The identity entry is only inspected (its exports start schedules and modules when called).
  const identity = await identityEntry();
  expect(Object.keys(identity).length).toBeGreaterThan(0);
  expect(carriers(identity, false)).toEqual([]);
});
