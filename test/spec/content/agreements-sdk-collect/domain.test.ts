// F1-02zzs §9.2#2–3 (D10-465): sdk_list and collect_list take no part in consent, so a publish is
// valid only with min_version equal to the new version and requires_resign false; they move no
// legal.* config key. The other publish rules are those of every type. Regression controls share
// a test with a new-behaviour assertion so every case is initially red. Property runs and seed
// come only from @couli/testing.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { legalKeysOf } from '../../../../apps/api/src/modules/content/application/agreement-admin.ts';
import {
  validateAgreementPublish,
  type AgreementPublishInput,
  type AgreementPublishResult,
  type AgreementVersion,
} from '../../../../apps/api/src/modules/content/domain/agreements/index.ts';

type Kind = Schema<'AgreementType'>;
type Input = Omit<AgreementPublishInput, 'type'> & { readonly type: Kind };

const NOTICES = ['sdk_list', 'collect_list'] as const;

// The contract's AgreementType is the input; the domain must take all five of its values.
function check(input: Input, current: AgreementVersion | null): AgreementPublishResult {
  return validateAgreementPublish(input as AgreementPublishInput, current);
}
function keysOf(type: Kind) {
  return legalKeysOf(type as Parameters<typeof legalKeysOf>[0]);
}

function base(type: Kind, version: number, min_version: number): Input {
  return {
    type,
    version,
    min_version,
    requires_resign: false,
    legal_confirmed_by: '法务乙',
    legal_confirm_note: '占位正文已确认不对外',
    legal_confirmed_on: '2026-10-29',
  };
}

it.each(NOTICES)(
  '[AC-F1-02zzs#1] %s 首发与后续版 min_version=version 通过、低于新版本拒绝；不映射任何 legal.* 键',
  (type) => {
    expect(check(base(type, 1, 1), null)).toEqual({ ok: true });
    expect(check(base(type, 2, 2), { version: 1, min_version: 1 })).toEqual({ ok: true });
    expect(check(base(type, 7, 7), { version: 6, min_version: 6 })).toEqual({ ok: true });
    expect(check(base(type, 2, 1), { version: 1, min_version: 1 })).toEqual({
      ok: false,
      fields: ['min_version'],
    });
    expect(keysOf(type)).toEqual([]);
    // The consent types keep their mapping and their own minimum rule.
    expect(keysOf('privacy')).toEqual([
      { key: 'legal.privacy.version', field: 'version' },
      { key: 'legal.privacy.min_version', field: 'min_version' },
    ]);
    expect(keysOf('agreement')).toEqual([
      { key: 'legal.agreement.version', field: 'version' },
      { key: 'legal.agreement.min_version', field: 'min_version' },
    ]);
    expect(keysOf('labor_agreement')).toEqual([]);
  },
);

interface BelowCase {
  type: Kind;
  floor: number;
  current: AgreementVersion;
  version: number;
  min: number;
}
const BELOW: BelowCase[] = NOTICES.flatMap((type) =>
  [
    { current: { version: 1, min_version: 1 }, version: 2, min: 1 },
    { current: { version: 2, min_version: 2 }, version: 3, min: 2 },
    { current: { version: 2, min_version: 1 }, version: 3, min: 2 },
    { current: { version: 2, min_version: 1 }, version: 3, min: 1 },
    { current: { version: 9, min_version: 9 }, version: 10, min: 9 },
  ].map((row) => ({ type, floor: row.current.min_version, ...row })),
);

it.each(BELOW)(
  '[AC-F1-02zzs#2] $type 当前最低 $floor 发布第 $version 版、min_version=$min 低于新版本 → [min_version]',
  ({ type, current, version, min }) => {
    expect(check(base(type, version, min), current)).toEqual({
      ok: false,
      fields: ['min_version'],
    });
  },
);

it.each(NOTICES)(
  '[AC-F1-02zzs#3] %s requires_resign 恒为 false，与 min_version 违规同报且按规则顺序',
  (type) => {
    expect(check({ ...base(type, 1, 1), requires_resign: true }, null)).toEqual({
      ok: false,
      fields: ['requires_resign'],
    });
    expect(
      check({ ...base(type, 2, 1), requires_resign: true }, { version: 1, min_version: 1 }),
    ).toEqual({ ok: false, fields: ['min_version', 'requires_resign'] });
  },
);

it.each(NOTICES)('[AC-F1-02zzs#4] %s 法务确认三项照旧必填，与 min_version 违规同报', (type) => {
  const current = { version: 1, min_version: 1 };
  expect(
    check(
      {
        ...base(type, 2, 1),
        legal_confirmed_by: ' ',
        legal_confirm_note: '',
        legal_confirmed_on: '2026-02-30',
      },
      current,
    ),
  ).toEqual({
    ok: false,
    fields: ['min_version', 'legal_confirmed_by', 'legal_confirm_note', 'legal_confirmed_on'],
  });
  expect(check({ ...base(type, 2, 2), legal_confirmed_by: '　' }, current)).toEqual({
    ok: false,
    fields: ['legal_confirmed_by'],
  });
  // Version sequencing is unchanged: a skipped version is still reported.
  expect(check(base(type, 3, 3), current)).toEqual({ ok: false, fields: ['version'] });
});

it('[AC-F1-02zzs#5] 任意当前版本与最低版本：两类合法当且仅当 min_version 等于新版本；同意类不受影响', () => {
  expect(() =>
    fc.assert(
      fc.property(
        fc.constantFrom(...NOTICES),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 100_002 }),
        (type, currentVersion, min) => {
          const version = currentVersion + 1;
          const current =
            currentVersion === 0 ? null : { version: currentVersion, min_version: currentVersion };
          const result = check(base(type, version, min), current);
          // privacy accepts every minimum between the current one and the new version.
          const privacy = check(
            base('privacy', version, Math.min(min, version)),
            current === null ? null : { version: currentVersion, min_version: 1 },
          );
          const expected = min === version ? { ok: true } : { ok: false, fields: ['min_version'] };
          return (
            JSON.stringify(result) === JSON.stringify(expected) &&
            JSON.stringify(privacy) === JSON.stringify({ ok: true })
          );
        },
      ),
      propParams(),
    ),
  ).not.toThrow();
});
