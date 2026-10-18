import { describe, expect, it } from 'vitest';
import type { AgreementPublishInput } from './index.ts';
import { needsSign, resignFromVersion, validateAgreementPublish } from './index.ts';

const labor: AgreementPublishInput = {
  type: 'labor_agreement',
  version: 2,
  min_version: 1,
  requires_resign: false,
  legal_confirmed_by: '法务',
  legal_confirm_note: '已核对',
  legal_confirmed_on: '2024-02-29',
};

describe('validateAgreementPublish', () => {
  it('[AC-F1-02m] accepts the next labor version that keeps the previous minimum', () => {
    expect(validateAgreementPublish(labor, { version: 1, min_version: 1 })).toEqual({ ok: true });
  });

  it('[AC-F1-02m] raising the minimum to the new version requires requires_resign=true', () => {
    const raised = { ...labor, min_version: 2 };
    expect(validateAgreementPublish(raised, { version: 1, min_version: 1 })).toEqual({
      ok: false,
      fields: ['requires_resign'],
    });
    expect(
      validateAgreementPublish(
        { ...raised, requires_resign: true },
        { version: 1, min_version: 1 },
      ),
    ).toEqual({ ok: true });
  });

  it('[AC-F1-02m] a minimum between the old minimum and the version is allowed without resign', () => {
    expect(
      validateAgreementPublish(
        { ...labor, version: 5, min_version: 3 },
        { version: 4, min_version: 2 },
      ),
    ).toEqual({ ok: true });
  });

  it('[AC-F1-02m] reports version and minimum once each when both are wrong', () => {
    expect(
      validateAgreementPublish(
        { ...labor, type: 'privacy', version: 7, min_version: 9 },
        { version: 1, min_version: 1 },
      ),
    ).toEqual({ ok: false, fields: ['version', 'min_version'] });
  });

  it('[AC-F1-02m] rejects non-leap 29 February and accepts the 400-year leap day', () => {
    const current = { version: 1, min_version: 1 };
    expect(
      validateAgreementPublish({ ...labor, legal_confirmed_on: '2100-02-29' }, current),
    ).toEqual({ ok: false, fields: ['legal_confirmed_on'] });
    expect(
      validateAgreementPublish({ ...labor, legal_confirmed_on: '2000-02-29' }, current),
    ).toEqual({ ok: true });
  });
});

describe('needsSign / resignFromVersion', () => {
  it('[AC-F1-02m] an unsigned user always needs to sign', () => {
    expect(needsSign(null, { version: 4, min_version: 1 })).toBe(true);
  });

  it('[AC-F1-02m] a signature at or above the minimum stays valid', () => {
    const current = { version: 4, min_version: 2 };
    expect(needsSign(2, current)).toBe(false);
    expect(needsSign(4, current)).toBe(false);
    expect(needsSign(1, current)).toBe(true);
    expect(resignFromVersion(current)).toBe(2);
  });
});
