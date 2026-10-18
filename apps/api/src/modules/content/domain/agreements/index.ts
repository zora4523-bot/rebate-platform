/** F1-02m §9.2: publish invariants; callers map fields to 20001 data.fields. */
export type AgreementType = 'privacy' | 'agreement' | 'labor_agreement';

export interface AgreementVersion {
  readonly version: number;
  readonly min_version: number;
}

export interface AgreementPublishInput extends AgreementVersion {
  readonly type: AgreementType;
  readonly requires_resign: boolean;
  readonly legal_confirmed_by?: string | null;
  readonly legal_confirm_note?: string | null;
  readonly legal_confirmed_on?: string | null;
}

export type AgreementPublishResult = { ok: true } | { ok: false; fields: string[] };

export function validateAgreementPublish(
  input: AgreementPublishInput,
  current: AgreementVersion | null,
): AgreementPublishResult {
  void input;
  void current;
  throw new Error('NotImplemented: validateAgreementPublish');
}

/** Labor agreements only; a missing current agreement is handled by the caller. */
export function needsSign(signedVersion: number | null, current: AgreementVersion): boolean {
  void signedVersion;
  void current;
  throw new Error('NotImplemented: needsSign');
}

export function resignFromVersion(current: AgreementVersion): number {
  void current;
  throw new Error('NotImplemented: resignFromVersion');
}
