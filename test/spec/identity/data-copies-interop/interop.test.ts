// B1-27k（裁定 D10-356 ②；08 BR-ID-40 细则「交付（默认）」；brief §9）：个人信息副本加密 ZIP（自写 WinZip
// AES-256 / AE-2）的互通，不连库、不联网。
// - kit 里的读取器与被测实现无关，先用 bsdtar 生成的标准包校准（fixtures/，编排者在宿主机生成，只读）：
//   用口令解开得 fixtures/src 原样字节，错口令在口令校验值处拒。
// - 已知答案：夹具条目的盐经 vi.mock('node:crypto') 的 randomBytes 注入本实现（只替换无回调的 16 字节
//   取数，其余照用真 CSPRNG），同一明文与口令重算的 stored 条目 AES 负载（salt‖verifier‖密文‖认证码）
//   与夹具逐字节相同；整包头部（时间、扩展字段、descriptor）与 AE-1 / AE-2 的 CRC、vendor version 不比。
// - 本实现的包（口令为一次性提取码）被同一读取器解开、逐字一致，条目为 AE-2 AES-256；错提取码在口令校验值
//   处拒，篡改一个密文字节在 HMAC 认证码处拒（读取器先验认证码、后解密解压，不靠解压报错），截断包报错。
// - 反向互通（bsdtar 解开本实现的包、试错口令）由编排者在宿主机做，作 PR 证据，不在这里。
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  encryptDataCopyZip,
  generateDataCopySecret,
  type DataCopyFileEntry,
} from '../../../../apps/api/src/modules/identity/application/data-copy-file.ts';
import {
  FIXTURE_NAMES,
  FIXTURE_PASSWORD,
  aesOf,
  aesParts,
  aesPayload,
  digest,
  entryNamed,
  fixtureEntries,
  fixtureSource,
  fixtureZip,
  flip,
  hex,
  localHeader,
  openAesPayload,
  openArchive,
  openEntry,
  payloadOffset,
  rejection,
  wrongPassword,
  xor,
  zipFiles,
  type ZipEntry,
} from './kit.ts';

/** Salts handed to the next 16-byte randomBytes draws (no callback), first in first out. */
const injected = vi.hoisted(() => ({ salts: [] as Buffer[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  function injectedRandomBytes(size: number, ...rest: unknown[]): unknown {
    const salt = size === 16 && rest.length === 0 ? injected.salts.shift() : undefined;
    if (salt !== undefined) return Buffer.from(salt);
    return Reflect.apply(actual.randomBytes, actual, [size, ...rest]);
  }
  return {
    ...actual,
    default: { ...actual, randomBytes: injectedRandomBytes },
    randomBytes: injectedRandomBytes,
  };
});

beforeEach(() => {
  injected.salts.length = 0;
});

/** AES-256: strength 3, 16-byte salt. */
const STRENGTH = 3;
const SALT = 16;
const VERIFIER = 2;
const MAC = 10;
/** Past the implementation's 1 MiB keystream chunk (65 536 counter blocks), not a whole block. */
const BINARY_LENGTH = 1024 * 1024 + 4099;

function compressible(): DataCopyFileEntry {
  return {
    name: 'repeat.txt',
    bytes: new TextEncoder().encode('line one\nline two\n'.repeat(400)),
  };
}

/** WinZip AES-256 as AE-2 in both the central directory and the local header (CRC-32 0). */
function expectAe2Aes256(zip: Uint8Array, entry: ZipEntry): void {
  const local = localHeader(zip, entry);
  expect(local.name).toBe(entry.name);
  for (const [where, header] of [
    ['central', entry],
    ['local', local],
  ] as const) {
    const label = `${entry.name} (${where} header)`;
    expect(header.flags & 1, label).toBe(1);
    expect(header.method, label).toBe(99);
    expect(header.crc, label).toBe(0);
    expect(
      { version: header.aes?.version, vendor: header.aes?.vendor, strength: header.aes?.strength },
      label,
    ).toEqual({ version: 2, vendor: 'AE', strength: STRENGTH });
  }
  expect([0, 8], entry.name).toContain(entry.aes?.method);
  expect(local.aes?.method, entry.name).toBe(entry.aes?.method);
}

it('[AC-B1-27k#1] 读取器校准：bsdtar 标准包（WinZip AES-256、stored）用口令解开得夹具原文、错口令在口令校验值处拒；本实现用同一口令加密同一明文，同一读取器解开逐字一致，条目为 AE-2 AES-256、错口令在校验值处拒', () => {
  const fixture = fixtureZip();
  const standard = zipFiles(fixture);
  expect(standard.map((entry) => entry.name).sort()).toEqual([...FIXTURE_NAMES].sort());
  for (const entry of standard) {
    const aes = aesOf(fixture, entry);
    const source = fixtureSource(entry.name);
    expect(entry.flags & 1, entry.name).toBe(1);
    expect(entry.method, entry.name).toBe(99);
    expect(
      { vendor: aes?.vendor, strength: aes?.strength, method: aes?.method },
      entry.name,
    ).toEqual({ vendor: 'AE', strength: STRENGTH, method: 0 });
    expect([1, 2], entry.name).toContain(aes?.version);
    const payload = aesPayload(fixture, entry);
    expect(payload.length, entry.name).toBe(SALT + VERIFIER + source.length + MAC);
    expect(hex(openEntry(fixture, entry, FIXTURE_PASSWORD)), entry.name).toBe(hex(source));
    const wrong = wrongPassword(payload, STRENGTH, FIXTURE_PASSWORD);
    expect(
      rejection(() => openEntry(fixture, entry, wrong)),
      entry.name,
    ).toBe('verifier');
  }
  expect(digest(openArchive(fixture, FIXTURE_PASSWORD))).toEqual(digest(fixtureEntries()));

  const zip = encryptDataCopyZip(fixtureEntries(), FIXTURE_PASSWORD);
  const ours = zipFiles(zip);
  expect(ours.map((entry) => entry.name).sort()).toEqual([...FIXTURE_NAMES].sort());
  expect(digest(openArchive(zip, FIXTURE_PASSWORD))).toEqual(digest(fixtureEntries()));
  for (const entry of ours) {
    expectAe2Aes256(zip, entry);
    const wrong = wrongPassword(aesPayload(zip, entry), STRENGTH, FIXTURE_PASSWORD);
    expect(
      rejection(() => openEntry(zip, entry, wrong)),
      entry.name,
    ).toBe('verifier');
  }
});

it('[AC-B1-27k#2] 已知答案：夹具条目的盐注入本实现，同一明文与口令重算的 stored 条目 AES 负载（salt‖verifier‖密文‖认证码）与 bsdtar 的逐字节相同；本实现改用 deflate 的条目，盐、口令校验值与 AES-CTR 密钥流仍与夹具相同', () => {
  const fixture = fixtureZip();
  const compared: string[] = [];
  for (const name of FIXTURE_NAMES) {
    const source = fixtureSource(name);
    const theirs = aesPayload(fixture, entryNamed(fixture, name));
    const their = aesParts(theirs, STRENGTH);
    expect(hex(openAesPayload(theirs, FIXTURE_PASSWORD, STRENGTH)), name).toBe(hex(source));

    injected.salts.push(Buffer.from(their.salt));
    const zip = encryptDataCopyZip([{ name, bytes: new Uint8Array(source) }], FIXTURE_PASSWORD);
    expect(injected.salts, `${name}: the entry salt comes from randomBytes(16)`).toHaveLength(0);
    const entry = entryNamed(zip, name);
    const ours = aesPayload(zip, entry);
    const our = aesParts(ours, STRENGTH);
    expect(hex(our.salt), name).toBe(hex(their.salt));
    expect(hex(our.verifier), name).toBe(hex(their.verifier));
    if (entry.aes?.method === 0) {
      expect(hex(ours), name).toBe(hex(theirs));
      compared.push(name);
    } else {
      // Deflated before encryption: the keystream under the same key is still the fixture's.
      const data = openAesPayload(ours, FIXTURE_PASSWORD, STRENGTH);
      expect(hex(inflateRawSync(data)), name).toBe(hex(source));
      const n = Math.min(data.length, source.length);
      expect(hex(xor(our.ciphertext.subarray(0, n), data.subarray(0, n))), name).toBe(
        hex(xor(their.ciphertext.subarray(0, n), source.subarray(0, n))),
      );
    }
  }
  expect(
    compared.length,
    'at least one fixture entry is stored and compared whole',
  ).toBeGreaterThan(0);
});

it('[AC-B1-27k#3] 本实现的包用一次性提取码（generateDataCopySecret）解开、逐字一致：多条目（空文件、可压缩文本、跨 1 MiB 计数块的二进制）均为 AE-2 AES-256、各条目盐不同且每次重新生成；错提取码逐条目在口令校验值处拒', () => {
  const binary = randomBytes(BINARY_LENGTH);
  const entries: DataCopyFileEntry[] = [
    ...fixtureEntries(),
    { name: 'empty.txt', bytes: new Uint8Array() },
    compressible(),
    { name: 'binary.bin', bytes: new Uint8Array(binary) },
  ];
  const code = generateDataCopySecret();
  const zip = encryptDataCopyZip(entries, code);
  const files = zipFiles(zip);
  expect(files.map((entry) => entry.name).sort()).toEqual(
    entries.map((entry) => entry.name).sort(),
  );
  expect(digest(openArchive(zip, code))).toEqual(digest(entries));
  const salts = new Set<string>();
  for (const entry of files) {
    expectAe2Aes256(zip, entry);
    const payload = aesPayload(zip, entry);
    salts.add(hex(aesParts(payload, STRENGTH).salt));
    const wrong = wrongPassword(payload, STRENGTH, code);
    expect(
      rejection(() => openEntry(zip, entry, wrong)),
      entry.name,
    ).toBe('verifier');
  }
  expect(salts.size).toBe(files.length);
  expect(Buffer.from(zip).includes(binary.subarray(0, 64))).toBe(false);

  const again = encryptDataCopyZip(entries, code);
  for (const entry of zipFiles(again)) {
    const salt = hex(aesParts(aesPayload(again, entry), STRENGTH).salt);
    expect(salts.has(salt), `${entry.name}: a fresh salt per package`).toBe(false);
  }
  expect(digest(openArchive(again, code))).toEqual(digest(entries));
});

it('[AC-B1-27k#4] 本实现的包被篡改一个密文字节或认证码字节，正确提取码也在 HMAC 认证码处拒（先于解密与解压）；截断的包报错、不吐出内容', () => {
  const entries: DataCopyFileEntry[] = [
    ...fixtureEntries(),
    compressible(),
    { name: 'binary.bin', bytes: new Uint8Array(randomBytes(3000)) },
  ];
  const code = generateDataCopySecret();
  const zip = encryptDataCopyZip(entries, code);
  expect(digest(openArchive(zip, code))).toEqual(digest(entries));
  for (const entry of zipFiles(zip)) {
    const start = payloadOffset(zip, entry);
    const ciphertext = entry.compressedSize - SALT - VERIFIER - MAC;
    expect(ciphertext, entry.name).toBeGreaterThan(0);
    const altered = flip(zip, start + SALT + VERIFIER + Math.floor(ciphertext / 2));
    expect(
      rejection(() => openEntry(altered, entry, code)),
      `${entry.name}: ciphertext`,
    ).toBe('mac');
    expect(
      rejection(() => openArchive(altered, code)),
      `${entry.name}: archive`,
    ).toBe('mac');
    const macByte = flip(zip, start + entry.compressedSize - 1);
    expect(
      rejection(() => openEntry(macByte, entry, code)),
      `${entry.name}: code`,
    ).toBe('mac');
  }
  for (const cut of [zip.length - 1, zip.length - 22, Math.floor(zip.length / 2), 30, 0]) {
    const layer = rejection(() => openArchive(zip.subarray(0, cut), code));
    expect(['truncated', 'format'], `cut at ${cut}`).toContain(layer);
  }
});
