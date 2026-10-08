import type { FieldCrypto } from '../../platform/index.ts';
import { createProcessItemRefCipher } from './search-wiring.ts';

type ItemRefCipher = Pick<FieldCrypto, 'encrypt' | 'decrypt'>;

let shared: ItemRefCipher | undefined;

/**
 * Shared, lazy item_ref cipher for one local / test process without FIELD_CRYPTO. Search, detail,
 * parsing and the open re-check card all take this one instance, so an item_ref issued by any
 * entry verifies at the others within the same process (BR-PROD-11). The key is generated on first
 * use and never replaced. Staging and prod always have a field keyring and never reach this.
 */
export function processItemRefCipher(): ItemRefCipher {
  shared ??= createProcessItemRefCipher();
  return shared;
}
