import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { ClaimEvidenceReader } from '../../linking/index.ts';

export interface ClaimEvidencePorts {
  readonly reads: ClaimEvidenceReader;
  deriveProductKey(input: {
    readonly platform: string;
    readonly raw_item_id: string;
  }): Promise<string | null>;
}
export type ClaimEvidenceFactory = (trx: Transaction<DB>) => ClaimEvidencePorts;

/** Read before acquiring the acceptance connection; invalid or unreadable config defaults to 360. */
export function readClaimEvidenceWindow(config: ContentReader, appId: string): Promise<number> {
  void config;
  void appId;
  throw new Error('NotImplemented: readClaimEvidenceWindow');
}
