// identity's share of the personal information copy (规划/08 BR-ID-40 细则「导出范围（默认）」, BR-ID-33;
// task B1-27f; the port and its rules: ../ports/personal-data-copy-sources.ts).
// createPersonalDataCopySources(options) — the whole PersonalDataCopySources:
//   - account / realname / consents are identity's own reads (users, user_oauth, realname,
//     consent_records), decrypted in memory with options.crypto (users.phone, realname.name,
//     realname.id_no contexts) and masked here with ../domain/mask-*.ts and platform/masking's
//     rules before they leave; the phone is the only value given in full;
//   - orders / ledger / withdrawals / agent / invite are the owners' reads in options, handed
//     through unchanged: the same handle and subject in, their result out as it is.
// Reads only, on the caller's handle; no writes, no logging.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { FieldCrypto } from '../../platform/index.ts';
import type { PersonalDataCopySources } from '../ports/personal-data-copy-sources.ts';

/** The five sections the owning modules read (assembled by app.module). */
export type PersonalDataCopyOwnerReads = Pick<
  PersonalDataCopySources,
  'orders' | 'ledger' | 'withdrawals' | 'agent' | 'invite'
>;

export interface PersonalDataCopySourcesOptions extends PersonalDataCopyOwnerReads {
  readonly crypto: Pick<FieldCrypto, 'decrypt'>;
}

export function createPersonalDataCopySources(
  options: PersonalDataCopySourcesOptions,
): PersonalDataCopySources {
  void options;
  throw new Error('NotImplemented: createPersonalDataCopySources');
}
