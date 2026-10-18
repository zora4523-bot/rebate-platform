import { expect, it } from 'vitest';
import { validateAgreementPublish } from '../../../../apps/api/src/modules/content/domain/agreements/index.ts';
import type { AgreementPublishInput } from '../../../../apps/api/src/modules/content/domain/agreements/index.ts';

// F1-02m §9.2 L3/L4; fixed dates deliberately do not depend on the wall clock.
const first: AgreementPublishInput = {
  type: 'labor_agreement',
  version: 1,
  min_version: 1,
  requires_resign: true,
  legal_confirmed_by: '法务确认人',
  legal_confirm_note: '已核对协议正文',
  legal_confirmed_on: '2026-10-18',
};

const next: AgreementPublishInput = { ...first, version: 3, requires_resign: false };
const current = { version: 2, min_version: 1 };

it('[AC-F1-02m#1] accepts the first labor version with a required signature', () => {
  expect(validateAgreementPublish(first, null)).toEqual({ ok: true });
});

it.each([0, 2, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  '[AC-F1-02m#2] first publication must have version 1, received %s',
  (version) => {
    expect(
      validateAgreementPublish(
        { ...first, type: 'privacy', requires_resign: false, version },
        null,
      ),
    ).toMatchObject({ ok: false, fields: expect.arrayContaining(['version']) });
  },
);

it('[AC-F1-02m#3] first version 2 reports only the version invariant', () => {
  expect(validateAgreementPublish({ ...first, version: 2, requires_resign: false }, null)).toEqual({
    ok: false,
    fields: ['version'],
  });
});

it.each([1, 2, 4, 3.5])('[AC-F1-02m#4] next version must be current + 1: %s', (version) => {
  expect(validateAgreementPublish({ ...next, type: 'agreement', version }, current)).toEqual({
    ok: false,
    fields: ['version'],
  });
});

it.each([0, -1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  '[AC-F1-02m#5] rejects non-positive, non-integer or excessive minimum %s',
  (min_version) => {
    expect(validateAgreementPublish({ ...next, type: 'privacy', min_version }, current)).toEqual({
      ok: false,
      fields: ['min_version'],
    });
  },
);

it('[AC-F1-02m#6] rejects a minimum below the previous minimum', () => {
  expect(validateAgreementPublish(next, { version: 2, min_version: 2 })).toEqual({
    ok: false,
    fields: ['min_version'],
  });
});

it.each([1, 2])(
  '[AC-F1-02m#7] allows unchanged or increased minimum %s below version',
  (min_version) => {
    expect(validateAgreementPublish({ ...next, min_version }, current)).toEqual({ ok: true });
    expect(validateAgreementPublish({ ...next, min_version }, { version: 2, min_version })).toEqual(
      { ok: true },
    );
  },
);

it.each(['privacy', 'agreement'] as const)(
  '[AC-F1-02m#8] %s always uses requires_resign=false even when minimum equals version',
  (type) => {
    expect(validateAgreementPublish({ ...first, type, requires_resign: false }, null)).toEqual({
      ok: true,
    });
    expect(validateAgreementPublish({ ...first, type }, null)).toEqual({
      ok: false,
      fields: ['requires_resign'],
    });
    expect(validateAgreementPublish({ ...next, type, requires_resign: true }, current)).toEqual({
      ok: false,
      fields: ['requires_resign'],
    });
  },
);

it('[AC-F1-02m#9] first labor agreement must require a signature', () => {
  expect(validateAgreementPublish({ ...first, requires_resign: false }, null)).toEqual({
    ok: false,
    fields: ['requires_resign'],
  });
});

it.each([
  { min_version: 3, requires_resign: true, ok: true },
  { min_version: 1, requires_resign: false, ok: true },
  { min_version: 3, requires_resign: false, ok: false },
  { min_version: 1, requires_resign: true, ok: false },
])(
  '[AC-F1-02m#10] labor v3 minimum $min_version / resign $requires_resign gives $ok',
  ({ min_version, requires_resign, ok }) => {
    expect(validateAgreementPublish({ ...next, min_version, requires_resign }, current)).toEqual(
      ok ? { ok: true } : { ok: false, fields: ['requires_resign'] },
    );
  },
);

it.each(['legal_confirmed_by', 'legal_confirm_note'] as const)(
  '[AC-F1-02m#11] every publication requires nonblank $0 even without a minimum increase',
  (field) => {
    for (const value of ['', '  ', '\t\n', '\u3000', null]) {
      expect(validateAgreementPublish({ ...next, [field]: value }, current)).toEqual({
        ok: false,
        fields: [field],
      });
    }
    const missing = { ...next };
    delete missing[field];
    expect(validateAgreementPublish(missing, current)).toEqual({ ok: false, fields: [field] });
  },
);

it.each([
  '2026-02-30',
  '2026/10/18',
  '2026-02-29',
  '1900-02-29',
  '2026-04-31',
  '2026-00-01',
  '2026-13-01',
  '2026-01-00',
  '2026-1-01',
  '26-10-18',
  '2026-10-18T00:00:00Z',
  ' 2026-10-18',
  '2026-10-18\n',
  '',
  null,
])(
  '[AC-F1-02m#12] rejects malformed or impossible legal confirmation date %j',
  (legal_confirmed_on) => {
    expect(validateAgreementPublish({ ...next, legal_confirmed_on }, current)).toEqual({
      ok: false,
      fields: ['legal_confirmed_on'],
    });
  },
);

it('[AC-F1-02m#13] missing legal confirmation date fails', () => {
  const missing = { ...next };
  delete missing.legal_confirmed_on;
  expect(validateAgreementPublish(missing, current)).toEqual({
    ok: false,
    fields: ['legal_confirmed_on'],
  });
});

it.each(['2000-02-29', '2024-02-29', '1999-12-31', '2999-12-31', '2026-04-30'])(
  '[AC-F1-02m#14] valid date %s is accepted without past/future restrictions',
  (legal_confirmed_on) => {
    expect(validateAgreementPublish({ ...next, legal_confirmed_on }, current)).toEqual({
      ok: true,
    });
  },
);

it('[AC-F1-02m#15] collects all invalid fields in rule order without duplicate minimum errors', () => {
  expect(
    validateAgreementPublish(
      {
        ...next,
        type: 'privacy',
        version: 4,
        min_version: 0.5,
        requires_resign: true,
        legal_confirmed_by: ' ',
        legal_confirm_note: '',
        legal_confirmed_on: '2026-02-30',
      },
      current,
    ),
  ).toEqual({
    ok: false,
    fields: [
      'version',
      'min_version',
      'requires_resign',
      'legal_confirmed_by',
      'legal_confirm_note',
      'legal_confirmed_on',
    ],
  });
});

it('[AC-F1-02m#16] validates padded legal text without mutating the inputs', () => {
  const input = Object.freeze({
    ...next,
    legal_confirmed_by: '  法务  ',
    legal_confirm_note: '\t确认\n',
  });
  const previous = Object.freeze({ ...current });
  expect(validateAgreementPublish(input, previous)).toEqual({ ok: true });
  expect(input.legal_confirmed_by).toBe('  法务  ');
  expect(input.legal_confirm_note).toBe('\t确认\n');
  expect(previous).toEqual(current);
});
