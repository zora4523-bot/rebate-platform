import { expect, it } from 'vitest';
import {
  classifyTextKey,
  type FundTermKeys,
} from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import { CONSENT_KEYS, ORDINARY_SPEC } from './fixtures.ts';

it('[AC-F1-02zzi#1] D10-204：仅 ordinary 的实名同意书归 agreement，精确前缀且资金判定优先', () => {
  const prefixSpec: FundTermKeys = {
    ...ORDINARY_SPEC,
    ordinary: { prefixes: ['real_name.'], keys: [], notify_templates: [] },
  };
  const fundOnly: FundTermKeys = {
    ...ORDINARY_SPEC,
    fund_terms: { prefixes: ['real_name.consent.'], keys: [], notify_templates: [] },
    ordinary: { prefixes: [], keys: [], notify_templates: [] },
  };
  const bothByPrefix: FundTermKeys = { ...prefixSpec, fund_terms: fundOnly.fund_terms };
  const bothByKey: FundTermKeys = {
    ...ORDINARY_SPEC,
    fund_terms: { prefixes: [], keys: CONSENT_KEYS, notify_templates: [] },
  };

  // One classification matrix includes the new behavior and its security boundaries. Expected
  // classes are literal, independent of the classifier / permission mapping being tested.
  const cases = [
    ...CONSENT_KEYS.map((key) => ({ key, spec: ORDINARY_SPEC, expected: 'agreement' })),
    ...CONSENT_KEYS.map((key) => ({ key, spec: prefixSpec, expected: 'agreement' })),
    ...[
      'real_name.consentx',
      'real_name.consentx.title',
      'real_name.consent',
      'real_name.other',
    ].map((key) => ({ key, spec: ORDINARY_SPEC, expected: 'general' })),
    ...['privacy.btn.agree', 'perm.btn.continue'].map((key) => ({
      key,
      spec: ORDINARY_SPEC,
      expected: 'agreement',
    })),
    { key: 'real_name.consent.unregistered', spec: ORDINARY_SPEC, expected: 'fund_terms' },
    ...[fundOnly, bothByPrefix, bothByKey].flatMap((spec) =>
      CONSENT_KEYS.map((key) => ({ key, spec, expected: 'fund_terms' })),
    ),
  ];
  expect(cases.map(({ key, spec }) => [key, classifyTextKey(key, spec)])).toEqual(
    cases.map(({ key, expected }) => [key, expected]),
  );
});
