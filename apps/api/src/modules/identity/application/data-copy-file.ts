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
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
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

/** Field-encryption context of a sealed (wecom_session) copy. */
export const DATA_COPY_SEAL_CONTEXT = 'personal_data_copies.file';

/**
 * Characters of the extraction code / password: A–Z without the look-alikes I and O, then the
 * digits 2–9 (32 characters). Built from code-point ranges.
 */
export const DATA_COPY_CODE_ALPHABET: string = [
  ...charRange('A', 'Z').filter((c) => c !== 'I' && c !== 'O'),
  ...charRange('2', '9'),
].join('');
/** Extraction code length: 12 characters of DATA_COPY_CODE_ALPHABET (60 bits). */
const CODE_LENGTH = 12;

function charRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let code = from.charCodeAt(0); code <= to.charCodeAt(0); code += 1) {
    out.push(String.fromCharCode(code));
  }
  return out;
}

// WinZip AES (AE-2), strength 3 = AES-256: 16-byte salt, PBKDF2-HMAC-SHA1 with 1000 iterations
// into 32 + 32 + 2 bytes (key, HMAC key, password verifier), AES-CTR with a little-endian counter
// from 1, HMAC-SHA1 over the ciphertext truncated to 10 bytes. AE-2 stores CRC-32 as 0.
const AES_KEY_LENGTH = 32;
const AES_SALT_LENGTH = 16;
const AES_ITERATIONS = 1000;
const AES_MAC_LENGTH = 10;
const AES_EXTRA_ID = 0x9901;
const AES_VERSION_AE2 = 2;
const AES_STRENGTH_256 = 3;
const METHOD_AES = 99;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
/** 5.1: the version needed to extract AES entries. */
const ZIP_VERSION = 51;
/** Bit 0: encrypted; bit 11: the name is UTF-8. */
const ZIP_FLAGS = 0x0001 | 0x0800;
/** 1980-01-01 00:00 in MS-DOS format: the copy carries no wall-clock time of its own. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const ZIP32_MAX = 0xffffffff;
const ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
/** Keystream blocks per cipher call (1 MiB of counters). */
const CTR_CHUNK_BLOCKS = 65_536;

function json(value: unknown): Uint8Array {
  const text = JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item),
    2,
  );
  return new TextEncoder().encode(`${text}\n`);
}

const README = [
  '个人信息副本',
  '',
  '本压缩包是你在本平台的个人信息副本（《个人信息保护法》第四十五条），各文件为 UTF-8 编码的 JSON：',
  '- account.json：账号资料（昵称、绑定手机号、第三方登录方式、注册时间）',
  '- realname.json：实名信息（已脱敏）',
  '- consents.json：同意记录',
  '- orders.json：订单',
  '- ledger.json：余额流水',
  '- withdrawals.json：提现记录（收款账号已脱敏）',
  '- agent_conversations.json：未过期的找货助手对话',
  '- invite.json：是否已绑定邀请人',
  '',
  '金额字段以 _fen 结尾，单位为分；时间为 ISO 8601（UTC）。',
  '',
].join('\n');

/** The copy as the files of the archive; entry names carry no personal data. */
export function dataCopyFileEntries(
  content: PersonalDataCopyContent,
): readonly DataCopyFileEntry[] {
  return [
    { name: 'README.txt', bytes: new TextEncoder().encode(README) },
    { name: 'account.json', bytes: json(content.account) },
    { name: 'realname.json', bytes: json(content.realname) },
    { name: 'consents.json', bytes: json(content.consents) },
    { name: 'orders.json', bytes: json(content.orders) },
    { name: 'ledger.json', bytes: json(content.ledger) },
    { name: 'withdrawals.json', bytes: json(content.withdrawals) },
    { name: 'agent_conversations.json', bytes: json(content.agent) },
    { name: 'invite.json', bytes: json(content.invite) },
  ];
}

function checkEntries(entries: readonly DataCopyFileEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    if (
      typeof entry.name !== 'string' ||
      !ENTRY_NAME.test(entry.name) ||
      entry.name.includes('..')
    ) {
      throw new TypeError('data copy: entry names are plain relative file names');
    }
    if (names.has(entry.name)) throw new TypeError('data copy: entry names must be unique');
    names.add(entry.name);
    if (!(entry.bytes instanceof Uint8Array)) {
      throw new TypeError('data copy: entry bytes must be a Uint8Array');
    }
  }
}

/** AES-CTR as WinZip uses it: 16-byte little-endian counter starting at 1 (no IV). */
function aesCtr(key: Buffer, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  const cipher = createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  const blocks = Math.ceil(data.length / 16);
  for (let first = 0; first < blocks; first += CTR_CHUNK_BLOCKS) {
    const count = Math.min(CTR_CHUNK_BLOCKS, blocks - first);
    const counters = Buffer.alloc(count * 16);
    for (let i = 0; i < count; i += 1) counters.writeBigUInt64LE(BigInt(first + i + 1), i * 16);
    const stream = cipher.update(counters);
    const offset = first * 16;
    const end = Math.min(data.length, offset + count * 16);
    for (let i = offset; i < end; i += 1) out[i] = data[i]! ^ stream[i - offset]!;
  }
  return out;
}

/** salt ‖ verifier ‖ ciphertext ‖ authentication code of one entry. */
function aesEntry(plain: Buffer, password: Buffer): Buffer {
  const salt = randomBytes(AES_SALT_LENGTH);
  const derived = pbkdf2Sync(password, salt, AES_ITERATIONS, 2 * AES_KEY_LENGTH + 2, 'sha1');
  const key = derived.subarray(0, AES_KEY_LENGTH);
  const macKey = derived.subarray(AES_KEY_LENGTH, 2 * AES_KEY_LENGTH);
  const verifier = derived.subarray(2 * AES_KEY_LENGTH);
  const body = aesCtr(key, plain);
  const mac = createHmac('sha1', macKey).update(body).digest().subarray(0, AES_MAC_LENGTH);
  return Buffer.concat([salt, verifier, body, mac]);
}

function aesExtra(method: number): Buffer {
  const extra = Buffer.alloc(11);
  extra.writeUInt16LE(AES_EXTRA_ID, 0);
  extra.writeUInt16LE(7, 2);
  extra.writeUInt16LE(AES_VERSION_AE2, 4);
  extra.write('AE', 6, 'latin1');
  extra.writeUInt8(AES_STRENGTH_256, 8);
  extra.writeUInt16LE(method, 9);
  return extra;
}

function size32(value: number): number {
  if (value > ZIP32_MAX) throw new RangeError('data copy: the archive is too large for ZIP32');
  return value;
}

/**
 * One standard ZIP (no ZIP64) whose every entry is WinZip AES-256 (AE-2) encrypted under
 * `password` with a fresh salt; each entry deflated when that is smaller, stored otherwise.
 */
export function encryptDataCopyZip(
  entries: readonly DataCopyFileEntry[],
  password: string,
): Uint8Array {
  checkEntries(entries);
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('data copy: the password must not be empty');
  }
  const secret = Buffer.from(password, 'utf8');
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const plain = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    const deflated = deflateRawSync(plain);
    const method = deflated.length < plain.length ? METHOD_DEFLATED : METHOD_STORED;
    const data = aesEntry(method === METHOD_DEFLATED ? deflated : plain, secret);
    const name = Buffer.from(entry.name, 'utf8');
    const extra = aesExtra(method);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(ZIP_FLAGS, 6);
    local.writeUInt16LE(METHOD_AES, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(size32(data.length), 18);
    local.writeUInt32LE(size32(plain.length), 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(ZIP_VERSION, 4);
    header.writeUInt16LE(ZIP_VERSION, 6);
    header.writeUInt16LE(ZIP_FLAGS, 8);
    header.writeUInt16LE(METHOD_AES, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(plain.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(size32(offset), 42);

    parts.push(local, name, extra, data);
    central.push(header, name, extra);
    offset += local.length + name.length + extra.length + data.length;
  }
  const directory = Buffer.concat(central);
  if (entries.length > 0xffff) throw new RangeError('data copy: too many entries for ZIP32');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size32(directory.length), 12);
  end.writeUInt32LE(size32(offset), 16);
  end.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

/** The one-time extraction code / password, from the CSPRNG (crypto.randomInt). */
export function generateDataCopySecret(): string {
  let secret = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    secret += DATA_COPY_CODE_ALPHABET[randomInt(DATA_COPY_CODE_ALPHABET.length)];
  }
  return secret;
}

interface SealedPayload {
  readonly v: 1;
  readonly entries: readonly { readonly name: string; readonly data: string }[];
}

/** The entries under the server's field key (fresh IV per call), as UTF-8 bytes of the ciphertext. */
export function sealDataCopyEntries(
  entries: readonly DataCopyFileEntry[],
  crypto: Pick<FieldCrypto, 'encrypt'>,
): Uint8Array {
  checkEntries(entries);
  const payload: SealedPayload = {
    v: 1,
    entries: entries.map((entry) => ({
      name: entry.name,
      data: Buffer.from(
        entry.bytes.buffer,
        entry.bytes.byteOffset,
        entry.bytes.byteLength,
      ).toString('base64'),
    })),
  };
  return new Uint8Array(
    Buffer.from(crypto.encrypt(JSON.stringify(payload), DATA_COPY_SEAL_CONTEXT), 'utf8'),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Opens what sealDataCopyEntries made; throws on another key, altered or malformed input. */
export function openSealedDataCopyEntries(
  sealed: Uint8Array,
  crypto: Pick<FieldCrypto, 'decrypt'>,
): readonly DataCopyFileEntry[] {
  const text = crypto.decrypt(
    Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength).toString('utf8'),
    DATA_COPY_SEAL_CONTEXT,
  );
  const payload: unknown = JSON.parse(text);
  if (!isRecord(payload) || payload['v'] !== 1 || !Array.isArray(payload['entries'])) {
    throw new TypeError('data copy: the sealed copy is malformed');
  }
  const entries = payload['entries'].map((item: unknown): DataCopyFileEntry => {
    if (!isRecord(item) || typeof item['name'] !== 'string' || typeof item['data'] !== 'string') {
      throw new TypeError('data copy: the sealed copy is malformed');
    }
    return { name: item['name'], bytes: new Uint8Array(Buffer.from(item['data'], 'base64')) };
  });
  checkEntries(entries);
  return entries;
}
