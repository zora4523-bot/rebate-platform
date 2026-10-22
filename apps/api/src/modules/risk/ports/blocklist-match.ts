import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** Risk resolves identity-owned HMACs via its existing identity ports. */
export interface BlocklistMatchReader {
  read(
    handle: Kysely<DB>,
    subject: {
      appId: string;
      userId: string;
      deviceId: string;
      payeeHmac: string | null;
      payoutMethod: 'alipay' | 'bank_card' | 'wechat' | null;
      now: Date;
    },
  ): Promise<{ risk_msg_code: string } | null>;
}

export function createBlocklistMatchReader(): BlocklistMatchReader {
  throw new Error('NotImplemented: createBlocklistMatchReader');
}
