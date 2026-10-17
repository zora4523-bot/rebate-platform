import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export function orderLockKeyText(platform: string, subOrderId: string): string {
  void platform;
  void subOrderId;
  throw new Error('NotImplemented: orderLockKeyText');
}

export function lockOrderKey(
  trx: Transaction<DB>,
  platform: string,
  subOrderId: string,
): Promise<void> {
  void trx;
  void platform;
  void subOrderId;
  throw new Error('NotImplemented: lockOrderKey');
}
