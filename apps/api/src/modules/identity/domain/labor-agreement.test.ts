import { expect, it } from 'vitest';
import {
  AGREEMENT_CONFIG_KEYS,
  SIGNING_CONFIG_KEYS,
  parseLaborAgreementConfig,
  parseOperatorEntity,
  signatureMismatches,
  signingState,
} from './labor-agreement.ts';

const SHA = 'a'.repeat(64);
const VALUES: Record<string, unknown> = {
  'legal.labor_agreement.version': 2,
  'legal.labor_agreement.text_url': 'https://example.test/legal/labor-v2.html',
  'legal.labor_agreement.text_sha256': SHA,
  'legal.labor_agreement.resign_from_version': 2,
  'legal.operator_entity.name': '测试运营主体',
  'legal.operator_entity.credit_code': '91350211M000100Y46',
};
const map = (overrides: Record<string, unknown> = {}, drop: readonly string[] = []) =>
  new Map(
    Object.entries({ ...VALUES, ...overrides }).filter(([key]) => !drop.includes(key)),
  ) as ReadonlyMap<string, unknown>;

it('[AC-B1-13h] config: the agreement keys parse into the current version, text and threshold', () => {
  expect(parseLaborAgreementConfig(map())).toEqual({
    ok: true,
    value: {
      version: 2,
      text_url: 'https://example.test/legal/labor-v2.html',
      text_sha256: SHA,
      resign_from_version: 2,
    },
  });
  expect(parseOperatorEntity(map())).toEqual({
    ok: true,
    value: { name: '测试运营主体', credit_code: '91350211M000100Y46' },
  });
  expect(SIGNING_CONFIG_KEYS).toEqual(expect.arrayContaining([...AGREEMENT_CONFIG_KEYS]));
  expect(SIGNING_CONFIG_KEYS).toHaveLength(6);
});

it('[AC-B1-13h] config: a missing key fails closed naming that key', () => {
  for (const key of AGREEMENT_CONFIG_KEYS) {
    expect(parseLaborAgreementConfig(map({}, [key]))).toEqual({ ok: false, key });
  }
  for (const key of ['legal.operator_entity.name', 'legal.operator_entity.credit_code']) {
    expect(parseOperatorEntity(map({}, [key]))).toEqual({ ok: false, key });
  }
});

it('[AC-B1-13h] config: malformed values fail closed naming the key', () => {
  const bad: [string, unknown][] = [
    ['legal.labor_agreement.version', 0],
    ['legal.labor_agreement.version', 1.5],
    ['legal.labor_agreement.version', '2'],
    ['legal.labor_agreement.version', 2_147_483_648],
    ['legal.labor_agreement.text_url', 'not a URL'],
    ['legal.labor_agreement.text_url', 'javascript:alert(1)'],
    ['legal.labor_agreement.text_url', ''],
    ['legal.labor_agreement.text_sha256', 'A'.repeat(64)],
    ['legal.labor_agreement.text_sha256', 'a'.repeat(63)],
    ['legal.labor_agreement.resign_from_version', 0],
    ['legal.labor_agreement.resign_from_version', '1'],
    // A threshold above the current version can never be met by signing.
    ['legal.labor_agreement.resign_from_version', 3],
  ];
  for (const [key, value] of bad) {
    expect(parseLaborAgreementConfig(map({ [key]: value }))).toEqual({ ok: false, key });
  }
  const badEntity: [string, unknown][] = [
    ['legal.operator_entity.name', ''],
    ['legal.operator_entity.name', '   '],
    ['legal.operator_entity.name', 1],
    ['legal.operator_entity.credit_code', ''],
    ['legal.operator_entity.credit_code', '91350211M000100Y4'],
    ['legal.operator_entity.credit_code', '91350211m000100y46'],
    ['legal.operator_entity.credit_code', '91350211I000100O46'],
  ];
  for (const [key, value] of badEntity) {
    expect(parseOperatorEntity(map({ [key]: value }))).toEqual({ ok: false, key });
  }
});

it('[AC-B1-13h] need_sign: never signed, below the re-sign threshold, or not accepted', () => {
  const at = new Date('2026-10-17T01:30:00.000Z');
  expect(signingState(undefined, { resign_from_version: 1 })).toEqual({
    need_sign: true,
    signed_version: null,
    signed_at: null,
  });
  expect(
    signingState({ version: 1, accepted: true, server_at: at }, { resign_from_version: 1 }),
  ).toEqual({ need_sign: false, signed_version: 1, signed_at: at });
  // A newer version not marked for re-signing keeps the earlier signature valid.
  expect(
    signingState({ version: 1, accepted: true, server_at: at }, { resign_from_version: 1 })
      .need_sign,
  ).toBe(false);
  expect(
    signingState({ version: 1, accepted: true, server_at: at }, { resign_from_version: 2 }),
  ).toEqual({ need_sign: true, signed_version: 1, signed_at: at });
  expect(
    signingState({ version: 3, accepted: true, server_at: at }, { resign_from_version: 2 })
      .need_sign,
  ).toBe(false);
  expect(
    signingState({ version: 3, accepted: false, server_at: at }, { resign_from_version: 1 }),
  ).toEqual({ need_sign: true, signed_version: null, signed_at: null });
});

it('[AC-B1-13h] signature: every mismatching field is listed, none when it matches', () => {
  const config = { version: 2, text_sha256: SHA };
  expect(signatureMismatches({ version: 2, text_sha256: SHA, agreed: true }, config)).toEqual([]);
  expect(signatureMismatches({ version: 1, text_sha256: SHA, agreed: true }, config)).toEqual([
    'version',
  ]);
  expect(
    signatureMismatches({ version: 2, text_sha256: 'b'.repeat(64), agreed: true }, config),
  ).toEqual(['text_sha256']);
  expect(signatureMismatches({ version: 2, text_sha256: SHA, agreed: false }, config)).toEqual([
    'agreed',
  ]);
  expect(
    signatureMismatches({ version: '2', text_sha256: SHA.toUpperCase(), agreed: 'true' }, config),
  ).toEqual(['version', 'text_sha256', 'agreed']);
});
