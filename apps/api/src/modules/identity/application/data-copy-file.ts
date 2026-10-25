// The file of a personal information copy (规划/08 BR-ID-40 细则「交付（默认）」「企业微信会话交付的下载」;
// 04 §3.2 personal_data_copies; task B1-27h brief §9 ③). Pure functions, no I/O, no logging:
//   - dataCopyFileEntries(content): the copy as the files of the archive — UTF-8 text, bigint fen
//     and Date instants serialised here (B1-27f leaves serialisation to this task); entry names are
//     plain relative names that carry no personal data.
//   - encryptDataCopyZip(entries, password): one standard ZIP whose every entry is WinZip AES-256
//     encrypted under `password` (fresh salt per call), readable by common unzip tools.
//   - generateDataCopySecret(): the one-time extraction code (in_app_sms) or password
//     (wecom_session, B1-27i) from the CSPRNG; never stored, logged or audited.
//   - sealDataCopyEntries / openSealedDataCopyEntries: the entries under the server's field key,
//     how a wecom_session copy waits for its first download (B1-27i re-encrypts them with a fresh
//     password); another key cannot open them.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { FieldCrypto } from '../../platform/index.ts';
import type {
  PersonalDataCopyAccount,
  PersonalDataCopyAgentConversation,
  PersonalDataCopyConsent,
  PersonalDataCopyInvite,
  PersonalDataCopyLedgerEntry,
  PersonalDataCopyOrder,
  PersonalDataCopyRealname,
  PersonalDataCopyWithdrawal,
} from '../ports/personal-data-copy-sources.ts';

/** Every section of the copy, as read through PersonalDataCopySources. */
export interface PersonalDataCopyContent {
  readonly account: PersonalDataCopyAccount | null;
  readonly realname: PersonalDataCopyRealname;
  readonly consents: readonly PersonalDataCopyConsent[];
  readonly orders: readonly PersonalDataCopyOrder[];
  readonly ledger: readonly PersonalDataCopyLedgerEntry[];
  readonly withdrawals: readonly PersonalDataCopyWithdrawal[];
  readonly agent: readonly PersonalDataCopyAgentConversation[];
  readonly invite: PersonalDataCopyInvite;
}

/** One file of the archive. */
export interface DataCopyFileEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export function dataCopyFileEntries(
  content: PersonalDataCopyContent,
): readonly DataCopyFileEntry[] {
  void content;
  throw new Error('NotImplemented: dataCopyFileEntries');
}

export function encryptDataCopyZip(
  entries: readonly DataCopyFileEntry[],
  password: string,
): Uint8Array {
  void entries;
  void password;
  throw new Error('NotImplemented: encryptDataCopyZip');
}

export function generateDataCopySecret(): string {
  throw new Error('NotImplemented: generateDataCopySecret');
}

export function sealDataCopyEntries(
  entries: readonly DataCopyFileEntry[],
  crypto: Pick<FieldCrypto, 'encrypt'>,
): Uint8Array {
  void entries;
  void crypto;
  throw new Error('NotImplemented: sealDataCopyEntries');
}

export function openSealedDataCopyEntries(
  sealed: Uint8Array,
  crypto: Pick<FieldCrypto, 'decrypt'>,
): readonly DataCopyFileEntry[] {
  void sealed;
  void crypto;
  throw new Error('NotImplemented: openSealedDataCopyEntries');
}
