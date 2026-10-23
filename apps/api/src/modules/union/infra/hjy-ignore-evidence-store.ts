export interface HjyIgnoreEvidencePut {
  /** Private object key, also persisted as union_pids.hjy_ignore_evidence_path. */
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: 'image/png' | 'image/jpeg';
}

/** B1-22h: activation's private storage boundary; tests replace only this external write. */
export class HjyIgnoreEvidenceStore {
  put(input: HjyIgnoreEvidencePut): Promise<void> {
    void input;
    throw new Error('NotImplemented: HjyIgnoreEvidenceStore.put');
  }
}
