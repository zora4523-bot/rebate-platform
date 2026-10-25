// B1-27k rule-test kit (裁定 D10-356 ②; 08 BR-ID-40 细则「交付（默认）」; brief §9 ①–③).
//
// The known-answer fixture: fixtures/standard-ae2.zip, made by the orchestrator on the host with
// libarchive's bsdtar 3.7.4 from fixtures/src under the password below (fixtures/README.md). It is
// only read here, never rewritten or recomputed.
//
// The ZIP reader below is independent of the code under test and says at which layer it refuses
// (ZipReadError.layer), so a rejection cannot pass by accident:
//   truncated  a structure or an AES payload runs past the end of the bytes
//   format     a structure that is not a ZIP / WinZip AES entry, a deflate stream that fails
//   verifier   the 2-byte password verifier from PBKDF2 differs (wrong password)
//   mac        the HMAC-SHA1 authentication code (10 bytes) over the ciphertext differs; checked
//              before anything is decrypted or inflated
//   crc        an AE-1 entry whose plaintext does not match its CRC-32 (AE-2 records 0)
// WinZip AES (AE-1 / AE-2): salt (8 / 12 / 16 bytes for strength 1 / 2 / 3) ‖ verifier ‖
// ciphertext ‖ authentication code; PBKDF2-HMAC-SHA1 with 1000 iterations into key ‖ HMAC key ‖
// verifier; AES in CTR mode with a 16-byte little-endian counter from 1. Sizes come from the
// central directory, so entries with a data descriptor (local sizes 0) read the same.
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import type { DataCopyFileEntry } from '../../../../apps/api/src/modules/identity/application/data-copy-file.ts';

// ---- the fixture ---------------------------------------------------------------------------------

const FIXTURES = new URL('./fixtures/', import.meta.url);
/** fixtures/README.md. */
export const FIXTURE_PASSWORD = 'interop-fixture-pass';
export const FIXTURE_NAMES: readonly string[] = ['profile.json', 'readme.txt'];

/** The archive bsdtar wrote. */
export function fixtureZip(): Buffer {
  return readFileSync(new URL('standard-ae2.zip', FIXTURES));
}

/** The plaintext of one fixture entry, byte for byte. */
export function fixtureSource(name: string): Buffer {
  return readFileSync(new URL(`src/${name}`, FIXTURES));
}

/** The fixture's plaintext files as entries of the code under test. */
export function fixtureEntries(): DataCopyFileEntry[] {
  return FIXTURE_NAMES.map((name) => ({ name, bytes: new Uint8Array(fixtureSource(name)) }));
}

// ---- helpers ---------------------------------------------------------------------------------------

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Name → hex of the bytes, sorted by name (to compare archives byte for byte). */
export function digest(entries: readonly DataCopyFileEntry[]): [string, string][] {
  return entries
    .map((entry): [string, string] => [entry.name, hex(entry.bytes)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function xor(a: Uint8Array, b: Uint8Array): Buffer {
  if (a.length !== b.length) throw new Error('xor: lengths differ');
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

/** A copy of `bytes` with the byte at `offset` inverted. */
export function flip(bytes: Uint8Array, offset: number): Uint8Array {
  if (offset < 0 || offset >= bytes.length) throw new Error('flip: offset out of range');
  const out = new Uint8Array(bytes);
  out[offset] = (out[offset] ?? 0) ^ 0xff;
  return out;
}

// ---- the reader --------------------------------------------------------------------------------------

export type ZipLayer = 'truncated' | 'format' | 'verifier' | 'mac' | 'crc';

export class ZipReadError extends Error {
  readonly layer: ZipLayer;

  constructor(layer: ZipLayer, message: string) {
    super(`zip reader (${layer}): ${message}`);
    this.name = 'ZipReadError';
    this.layer = layer;
  }
}

/**
 * The layer at which `run` was refused, 'accepted' when it was not; anything other than a
 * ZipReadError is named as such (so a crash never passes for a rejection).
 */
export function rejection(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ZipReadError) return error.layer;
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return `not a reader rejection: ${detail}`;
  }
  return 'accepted';
}

export interface AesField {
  /** Vendor version: 1 = AE-1, 2 = AE-2. */
  readonly version: number;
  readonly vendor: string;
  /** 1 / 2 / 3 = AES-128 / -192 / -256. */
  readonly strength: number;
  /** The actual compression method of the encrypted data (0 stored, 8 deflated). */
  readonly method: number;
}

export interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
  /** The AES extra field of the central directory header. */
  readonly aes: AesField | null;
}

export interface LocalHeader {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  /** The AES extra field of the local file header. */
  readonly aes: AesField | null;
  readonly dataOffset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const AES_EXTRA = 0x9901;
const ZIP64_EXTRA = 0x0001;
const METHOD_AES = 99;
const ITERATIONS = 1000;
const VERIFIER_LENGTH = 2;
const MAC_LENGTH = 10;

function view(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function need(b: Buffer, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > b.length) {
    throw new ZipReadError('truncated', `${what} runs past the end of the archive`);
  }
}

function extraFields(extra: Buffer): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  for (let q = 0; q + 4 <= extra.length;) {
    const id = extra.readUInt16LE(q);
    const length = extra.readUInt16LE(q + 2);
    if (q + 4 + length > extra.length) throw new ZipReadError('format', 'extra field overruns');
    fields.set(id, extra.subarray(q + 4, q + 4 + length));
    q += 4 + length;
  }
  return fields;
}

function aesField(fields: Map<number, Buffer>): AesField | null {
  const data = fields.get(AES_EXTRA);
  if (data === undefined) return null;
  if (data.length < 7) throw new ZipReadError('format', 'short AES extra field');
  return {
    version: data.readUInt16LE(0),
    vendor: data.subarray(2, 4).toString('latin1'),
    strength: data.readUInt8(4),
    method: data.readUInt16LE(5),
  };
}

/** The entries of the central directory (ZIP64 sizes and offsets included). */
export function zipDirectory(bytes: Uint8Array): ZipEntry[] {
  const b = view(bytes);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i -= 1) {
    if (b.readUInt32LE(i) === EOCD && i + 22 + b.readUInt16LE(i + 20) === b.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipReadError('truncated', 'no end of central directory record');
  let count = b.readUInt16LE(eocd + 10);
  let size = b.readUInt32LE(eocd + 12);
  let offset = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    need(b, locator, 20, 'the zip64 locator');
    if (b.readUInt32LE(locator) !== ZIP64_LOCATOR) {
      throw new ZipReadError('format', 'no zip64 locator');
    }
    const record = Number(b.readBigUInt64LE(locator + 8));
    need(b, record, 56, 'the zip64 end record');
    if (b.readUInt32LE(record) !== ZIP64_EOCD) {
      throw new ZipReadError('format', 'no zip64 end record');
    }
    count = Number(b.readBigUInt64LE(record + 32));
    size = Number(b.readBigUInt64LE(record + 40));
    offset = Number(b.readBigUInt64LE(record + 48));
  }
  need(b, offset, size, 'the central directory');
  const entries: ZipEntry[] = [];
  let p = offset;
  for (let n = 0; n < count; n += 1) {
    need(b, p, 46, 'a central directory header');
    if (b.readUInt32LE(p) !== CENTRAL) throw new ZipReadError('format', 'bad central header');
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    let compressedSize = b.readUInt32LE(p + 20);
    let uncompressedSize = b.readUInt32LE(p + 24);
    const nameLength = b.readUInt16LE(p + 28);
    const extraLength = b.readUInt16LE(p + 30);
    const commentLength = b.readUInt16LE(p + 32);
    let localOffset = b.readUInt32LE(p + 42);
    need(b, p + 46, nameLength + extraLength + commentLength, 'a central directory header');
    const name = b.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const fields = extraFields(b.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength));
    const zip64 = fields.get(ZIP64_EXTRA);
    if (zip64 !== undefined) {
      let r = 0;
      const next = (): number => {
        if (r + 8 > zip64.length) throw new ZipReadError('format', 'short zip64 extra field');
        const value = Number(zip64.readBigUInt64LE(r));
        r += 8;
        return value;
      };
      if (uncompressedSize === 0xffffffff) uncompressedSize = next();
      if (compressedSize === 0xffffffff) compressedSize = next();
      if (localOffset === 0xffffffff) localOffset = next();
    }
    entries.push({
      name,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      aes: aesField(fields),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The file entries of the archive (directories left out). */
export function zipFiles(bytes: Uint8Array): ZipEntry[] {
  return zipDirectory(bytes).filter((entry) => !entry.name.endsWith('/'));
}

/** The entry named `name` (one and only one). */
export function entryNamed(bytes: Uint8Array, name: string): ZipEntry {
  const found = zipDirectory(bytes).filter((entry) => entry.name === name);
  if (found.length !== 1) throw new ZipReadError('format', `${found.length} entries named ${name}`);
  return found[0] as ZipEntry;
}

export function localHeader(bytes: Uint8Array, entry: ZipEntry): LocalHeader {
  const b = view(bytes);
  const p = entry.localOffset;
  need(b, p, 30, 'a local file header');
  if (b.readUInt32LE(p) !== LOCAL) throw new ZipReadError('format', 'bad local file header');
  const nameLength = b.readUInt16LE(p + 26);
  const extraLength = b.readUInt16LE(p + 28);
  need(b, p + 30, nameLength + extraLength, 'a local file header');
  return {
    name: b.subarray(p + 30, p + 30 + nameLength).toString('utf8'),
    flags: b.readUInt16LE(p + 6),
    method: b.readUInt16LE(p + 8),
    crc: b.readUInt32LE(p + 14),
    aes: aesField(extraFields(b.subarray(p + 30 + nameLength, p + 30 + nameLength + extraLength))),
    dataOffset: p + 30 + nameLength + extraLength,
  };
}

/** The AES field of an entry: the central directory's, else the local header's. */
export function aesOf(bytes: Uint8Array, entry: ZipEntry): AesField | null {
  return entry.aes ?? localHeader(bytes, entry).aes;
}

/** Where the entry's AES payload (salt ‖ verifier ‖ ciphertext ‖ authentication code) lies. */
export function payloadOffset(bytes: Uint8Array, entry: ZipEntry): number {
  const offset = localHeader(bytes, entry).dataOffset;
  need(view(bytes), offset, entry.compressedSize, `the data of ${entry.name}`);
  return offset;
}

/** A copy of the entry's AES payload: salt ‖ verifier ‖ ciphertext ‖ authentication code. */
export function aesPayload(bytes: Uint8Array, entry: ZipEntry): Buffer {
  const offset = payloadOffset(bytes, entry);
  return Buffer.from(view(bytes).subarray(offset, offset + entry.compressedSize));
}

export function keyLength(strength: number): number {
  if (strength === 1) return 16;
  if (strength === 2) return 24;
  if (strength === 3) return 32;
  throw new ZipReadError('format', `unknown AES strength ${strength}`);
}

export function saltLength(strength: number): number {
  return keyLength(strength) / 2;
}

export interface AesParts {
  readonly salt: Buffer;
  readonly verifier: Buffer;
  readonly ciphertext: Buffer;
  readonly mac: Buffer;
}

export function aesParts(payload: Uint8Array, strength: number): AesParts {
  const b = view(payload);
  const salt = saltLength(strength);
  if (b.length < salt + VERIFIER_LENGTH + MAC_LENGTH) {
    throw new ZipReadError('truncated', 'AES payload shorter than salt, verifier and code');
  }
  return {
    salt: b.subarray(0, salt),
    verifier: b.subarray(salt, salt + VERIFIER_LENGTH),
    ciphertext: b.subarray(salt + VERIFIER_LENGTH, b.length - MAC_LENGTH),
    mac: b.subarray(b.length - MAC_LENGTH),
  };
}

export interface AesKeys {
  readonly key: Buffer;
  readonly macKey: Buffer;
  readonly verifier: Buffer;
}

export function deriveKeys(password: string, salt: Uint8Array, length: number): AesKeys {
  const derived = pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    salt,
    ITERATIONS,
    2 * length + VERIFIER_LENGTH,
    'sha1',
  );
  return {
    key: derived.subarray(0, length),
    macKey: derived.subarray(length, 2 * length),
    verifier: derived.subarray(2 * length),
  };
}

/** The AES-CTR keystream: AES of the 16-byte little-endian counters 1, 2, 3 … */
export function aesKeystream(key: Buffer, length: number): Buffer {
  const blocks = Math.ceil(length / 16);
  const counters = Buffer.alloc(blocks * 16);
  for (let i = 0; i < blocks; i += 1) counters.writeBigUInt64LE(BigInt(i + 1), i * 16);
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(counters), cipher.final()]).subarray(0, length);
}

/**
 * The data of one AES payload under `password`: refused at the verifier first, then at the
 * authentication code (over the ciphertext as stored), only then decrypted.
 */
export function openAesPayload(payload: Uint8Array, password: string, strength: number): Buffer {
  const parts = aesParts(payload, strength);
  const keys = deriveKeys(password, parts.salt, keyLength(strength));
  if (!keys.verifier.equals(parts.verifier)) {
    throw new ZipReadError('verifier', 'the password verifier differs (wrong password)');
  }
  const mac = createHmac('sha1', keys.macKey).update(parts.ciphertext).digest();
  if (!mac.subarray(0, MAC_LENGTH).equals(parts.mac)) {
    throw new ZipReadError('mac', 'the authentication code differs (altered ciphertext)');
  }
  return xor(parts.ciphertext, aesKeystream(keys.key, parts.ciphertext.length));
}

/**
 * A password other than `password` whose verifier differs from the payload's (a 2-byte verifier
 * lets 1 in 65 536 wrong passwords through to the authentication code).
 */
export function wrongPassword(payload: Uint8Array, strength: number, password: string): string {
  const parts = aesParts(payload, strength);
  for (let i = 0; ; i += 1) {
    const candidate = `${password}-wrong-${i}`;
    const keys = deriveKeys(candidate, parts.salt, keyLength(strength));
    if (!keys.verifier.equals(parts.verifier)) return candidate;
  }
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The plaintext of one WinZip AES entry (stored or deflated); throws ZipReadError. */
export function openEntry(bytes: Uint8Array, entry: ZipEntry, password: string): Buffer {
  const aes = aesOf(bytes, entry);
  if ((entry.flags & 1) !== 1 || entry.method !== METHOD_AES || aes === null) {
    throw new ZipReadError('format', `${entry.name} is not WinZip AES encrypted`);
  }
  if (aes.vendor !== 'AE' || (aes.version !== 1 && aes.version !== 2)) {
    throw new ZipReadError('format', `${entry.name}: unknown AES vendor or version`);
  }
  const data = openAesPayload(aesPayload(bytes, entry), password, aes.strength);
  let plain: Buffer;
  if (aes.method === 0) {
    plain = data;
  } else if (aes.method === 8) {
    try {
      plain = inflateRawSync(data);
    } catch {
      throw new ZipReadError('format', `${entry.name}: bad deflate stream`);
    }
  } else {
    throw new ZipReadError('format', `${entry.name}: unknown compression method ${aes.method}`);
  }
  if (plain.length !== entry.uncompressedSize) {
    throw new ZipReadError('format', `${entry.name}: size differs from the central directory`);
  }
  if (aes.version === 1 && crc32(plain) !== entry.crc) {
    throw new ZipReadError('crc', `${entry.name}: CRC-32 differs`);
  }
  return plain;
}

/** Every file entry of an archive whose file entries are all WinZip AES encrypted. */
export function openArchive(bytes: Uint8Array, password: string): DataCopyFileEntry[] {
  return zipFiles(bytes).map((entry) => ({
    name: entry.name,
    bytes: new Uint8Array(openEntry(bytes, entry, password)),
  }));
}
