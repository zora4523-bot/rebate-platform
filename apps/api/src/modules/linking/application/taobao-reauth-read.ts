import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface TaobaoReauthScope {
  readonly appId: string;
  readonly userId: string;
}

export type TaobaoReauthReader = (
  trx: Transaction<DB>,
  scope: TaobaoReauthScope,
) => Promise<boolean>;

/** B1-12g: SELECT only; true iff this app/user currently has a Taobao invalid binding. */
export async function needsTaobaoReauth(
  trx: Transaction<DB>,
  scope: TaobaoReauthScope,
): Promise<boolean> {
  void trx;
  void scope;
  throw new Error('NotImplemented: needsTaobaoReauth');
}
