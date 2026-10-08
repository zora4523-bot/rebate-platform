import type { FieldCrypto } from '../../platform/index.ts';

/** Shared, lazy item_ref cipher for one local / test process without FIELD_CRYPTO. */
export function processItemRefCipher(): Pick<FieldCrypto, 'encrypt' | 'decrypt'> {
  throw new Error('NotImplemented: processItemRefCipher');
}
