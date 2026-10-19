import { expect, it } from 'vitest';
import { isAgreementVersionTaken } from './kysely-agreement-admin-store.ts';

it('[AC-F1-02p] only a unique violation of the (app_id, type, version) key is a lost race', () => {
  expect(
    isAgreementVersionTaken({ code: '23505', constraint: 'agreements_app_type_version_key' }),
  ).toBe(true);
  expect(isAgreementVersionTaken({ code: '23505', constraint: 'agreements_pkey' })).toBe(false);
  expect(
    isAgreementVersionTaken({ code: '23514', constraint: 'agreements_app_type_version_key' }),
  ).toBe(false);
  expect(isAgreementVersionTaken(null)).toBe(false);
  expect(isAgreementVersionTaken('23505')).toBe(false);
});
