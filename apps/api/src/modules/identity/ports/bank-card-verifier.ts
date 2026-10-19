// B1-13f: internal ports; plaintext is transient vendor input, never log or return it.
//
// CardBinPort (规划/08 BR-WDR-02 细则「只支持本人名下借记卡」): the card type and opening bank of the
// normalised card number; null when the BIN is not recognised. The opening bank is stored and
// answered as bank_name; the user never types it.
// BankCardVerifierPort (BR-WDR-02 ⑥ ⑦, task B1-13f §9.2 #7): the paid three-element verification
// (real name + ID number + card number). verify is called once per reservation with the
// reservation's vendor_request_id; query asks about an earlier call by that id and never charges
// again (not_found: the vendor has no such request). The caller bounds every call with its own
// deadline and treats a rejection or a hang as "no answer"; a rejection's message is never logged
// or echoed (it may carry the submitted values).
// Only fakes exist (local / test, infra/fake-bank-card-verifier.ts); staging / prod inject none
// until the owner picks the vendors (50301).
//
// Also compiled by the `test` project: erasable syntax only.
export interface CardBinPort {
  lookup(digits: string): Promise<{
    readonly card_type: 'debit' | 'credit';
    readonly bank_name: string;
    readonly bin: string;
  } | null>;
}

export interface BankCardVerificationInput {
  readonly vendor_request_id: string;
  readonly name: string;
  readonly id_no: string;
  readonly card_no: string;
}

export interface BankCardVerifierPort {
  verify(input: BankCardVerificationInput): Promise<'match' | 'mismatch'>;
  query(vendorRequestId: string): Promise<'match' | 'mismatch' | 'not_found' | 'unknown'>;
}
