// B1-13f: internal ports; plaintext is transient vendor input, never log or return it.
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
