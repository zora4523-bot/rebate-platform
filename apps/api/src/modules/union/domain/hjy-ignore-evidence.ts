export type HjyEvidenceCheck =
  | { readonly valid: true; readonly contentType: 'image/png' | 'image/jpeg' }
  | { readonly valid: false };

/** BR-ATTR-02: screenshot format and 5 MiB ceiling, independent of the HTTP body limit. */
export function inspectHjyIgnoreEvidence(bytes: Uint8Array): HjyEvidenceCheck {
  void bytes;
  throw new Error('NotImplemented: inspectHjyIgnoreEvidence');
}
