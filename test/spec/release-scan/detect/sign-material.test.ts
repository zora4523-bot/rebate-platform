import { createPropStats, propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { ScanHit, ScanResult } from '../../../../infra/release-scan/detect/index.ts';
import { detectSecrets, scanArtifact } from '../../../../infra/release-scan/detect/index.ts';
import { FAKE, realManifest, sorted, tempDirs, want, writeZip } from './fixtures.ts';

// BR-ID-09「安装包不内置任何签名密钥或共享盐」；02 §12.6 发布制品密钥扫描（不可豁免）。
// 口径：明确的签名材料字段（install_secret、sign + key/secret、hmac、salt）不套用通用高熵候选的过滤——
// 任何非空取值都报（不看长度、不要求含数字、不看熵、可含常见标点）；取值到配对的引号、`<` 或空白为止，命中原文只取值。
// 数值参数靠字段语义区分而不靠长度：salt 后跟 rounds / length / len / size / bits / count / iterations / cost 的字段
// （如 saltRounds）是算法参数，不是签名材料。
// 编码：带 BOM 的 UTF-16LE / UTF-16BE 文本按 UTF-16 解码后检测，行号按解码后的 `\n` 计（与 UTF-8 / latin1 同规则）。
// 二进制 plist（bplist00）必须解析：键值按同一规则检测，签名材料检出即阻断；不含密钥的二进制 plist 读通、不报错
// （真实 ipa 的 Info.plist 默认是二进制 plist，不能用整条判为不可扫描作为通用出路；编排者例外一轮口径，decision 21）。
// 读不通的损坏 bplist 仍按读取错误处理（fail-closed）。

const newDir = tempDirs();
const FILE = 'res/raw/sign.conf';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
/** 12 位、只有字母和连字符的短共享盐。 */
const SHORT_SALT = ['release', 'salt'].join('-');
/** 43 位纯字母（install_secret 的长度，但不含数字）。 */
const ALPHA_43 = `${LETTERS}${LETTERS.toUpperCase()}`.slice(0, 43);
/** 含常见标点。 */
const PUNCT = ['Ex.ample', '!sign#', 'val$%^&*~', '(x)+/=?@'].join('');
/** 正好 8 位。 */
const EIGHT = LETTERS.slice(0, 8);
/** 1～7 位的短盐（7 位的形如「环境-版本」）。 */
const TINY = ['x', 'ab', `${'prod'}-v1`, LETTERS.slice(0, 5)];

function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

function utf16be(text: string): Buffer {
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1] ?? 0;
    be[i + 1] = le[i] ?? 0;
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
}

it('[BR-ID-09 签名材料#1] 短共享盐、纯字母签名密钥、含标点与正好 8 位的签名材料都按 request-sign-material 报', () => {
  const cases: Array<[string, string]> = [
    [`shared_salt="${SHORT_SALT}"`, SHORT_SALT],
    [`const c = { installSecret: "${ALPHA_43}" };`, ALPHA_43],
    [`{"signKey":"${PUNCT}"}`, PUNCT],
    [`salt=${EIGHT}`, EIGHT],
    [`<string name="hmac_secret">${PUNCT}</string>`, PUNCT],
    ...TINY.flatMap((v): Array<[string, string]> => [
      [`shared_salt="${v}"`, v],
      [`{"signKey":"${v}"}`, v],
      [`salt=${v}`, v],
    ]),
  ];
  for (const [content, value] of cases) {
    expect(detectSecrets(FILE, `# c\n${content}\n`), content).toEqual([
      want('request-sign-material', FILE, 2, value),
    ]);
  }
});

it('[BR-ID-09 签名材料#4] 盐的算法参数字段（轮数、长度、迭代次数）按字段语义不算签名材料', () => {
  for (const content of [
    'const saltRounds = 10;',
    'salt_length: 16',
    '{"saltSize":32}',
    'SALT_ITERATIONS=10000',
  ]) {
    expect(detectSecrets(FILE, content), content).toEqual([]);
  }
});

it('[BR-ID-09 编码#1] 带 BOM 的 UTF-16LE / UTF-16BE 配置里的签名材料照样命中，行号按解码后计', () => {
  const xml = (name: string, value: string) =>
    `<?xml version="1.0" encoding="UTF-16"?>\n<config>\n<string name="${name}">${value}</string>\n</config>\n`;
  for (const [label, encode] of [
    ['le', utf16le],
    ['be', utf16be],
  ] as const) {
    expect(detectSecrets(FILE, encode(xml('install_secret', FAKE.hex32Low))), label).toEqual([
      want('request-sign-material', FILE, 3, FAKE.hex32Low),
    ]);
    expect(detectSecrets(FILE, encode(xml('shared_salt', SHORT_SALT))), label).toEqual([
      want('request-sign-material', FILE, 3, SHORT_SALT),
    ]);
  }
});

function expectBlocked(result: ScanResult, label: string): void {
  expect(result.errors, label).toEqual([]);
  expect(result.exit_code, label).toBe(1);
  expect(result.passed, label).toBe(false);
  expect(result.report.decisions.length, label).toBe(result.hits.length);
  for (const d of result.report.decisions) {
    expect([d.hit.rule, d.verdict, d.reason], label).toEqual([
      'request-sign-material',
      'block',
      'never_accepted',
    ]);
  }
}

it('[BR-ID-09 签名材料#2] 扫描制品：短盐、纯字母、含标点的签名材料都使制品被阻断', async () => {
  const path = writeZip(newDir(), 'demo.apk', [
    {
      name: 'assets/sign.json',
      data: `{"shared_salt":"${SHORT_SALT}",\n"installSecret":"${ALPHA_43}",\n"signKey":"${PUNCT}"}`,
    },
  ]);
  const result = await scanArtifact({
    path,
    platform: 'android',
    manifestYaml: realManifest(),
    approvals: [],
  });
  expect(sorted(result.hits)).toEqual([
    want('request-sign-material', 'assets/sign.json', 1, SHORT_SALT),
    want('request-sign-material', 'assets/sign.json', 2, ALPHA_43),
    want('request-sign-material', 'assets/sign.json', 3, PUNCT),
  ]);
  expectBlocked(result, 'apk');
});

it('[BR-ID-09 签名材料#5] 扫描制品：1～7 位的短盐也使制品被阻断（退出码 1）', async () => {
  const dir = newDir();
  for (const v of TINY) {
    const path = writeZip(dir, `tiny-${v.length}.hap`, [
      { name: 'resources/rawfile/sign.properties', data: `# c\nshared_salt=${v}\n` },
    ]);
    const result = await scanArtifact({
      path,
      platform: 'harmony',
      manifestYaml: realManifest(),
      approvals: [],
    });
    expect(result.hits, v).toEqual([
      want('request-sign-material', 'resources/rawfile/sign.properties', 2, v),
    ]);
    expectBlocked(result, v);
  }
});

/** 最小的二进制 plist：顶层一个字典，值为 ASCII 或 UTF-16 字符串（运行时生成）。 */
function bplist(entries: ReadonlyArray<readonly [string, string, 'ascii' | 'utf16']>): Buffer {
  const str = (s: string, kind: 'ascii' | 'utf16'): Buffer => {
    const body = kind === 'ascii' ? Buffer.from(s, 'ascii') : utf16be(s).subarray(2);
    const marker = kind === 'ascii' ? 0x50 : 0x60;
    const head =
      s.length < 15
        ? Buffer.from([marker | s.length])
        : Buffer.from([marker | 0x0f, 0x10, s.length]);
    return Buffer.concat([head, body]);
  };
  const n = entries.length;
  const refs = [
    ...Array.from({ length: n }, (_, i) => 1 + i),
    ...Array.from({ length: n }, (_, i) => 1 + n + i),
  ];
  const objects = [
    Buffer.from([0xd0 | n, ...refs]),
    ...entries.map(([k]) => str(k, 'ascii')),
    ...entries.map(([, v, kind]) => str(v, kind)),
  ];
  const header = Buffer.from('bplist00', 'ascii');
  const offsets: number[] = [];
  let pos = header.length;
  for (const o of objects) {
    offsets.push(pos);
    pos += o.length;
  }
  const table = Buffer.alloc(offsets.length * 2);
  offsets.forEach((o, i) => table.writeUInt16BE(o, i * 2));
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(2, 6);
  trailer.writeUInt8(1, 7);
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(pos), 24);
  return Buffer.concat([header, ...objects, table, trailer]);
}

it('[BR-ID-09 编码#3] ipa 里二进制 plist 中的共享盐必须解析检出并阻断（不接受整条判为不可扫描）', async () => {
  const dir = newDir();
  for (const kind of ['ascii', 'utf16'] as const) {
    const plist = bplist([
      ['CFBundleIdentifier', 'com.example.demo', 'ascii'],
      ['shared_salt', SHORT_SALT, kind],
    ]);
    expect(plist.subarray(0, 8).toString('ascii')).toBe('bplist00');
    const result = await scanArtifact({
      path: writeZip(dir, `bplist-${kind}.ipa`, [
        { name: 'Payload/Demo.app/Sign.plist', data: plist },
      ]),
      platform: 'ios',
      manifestYaml: realManifest(),
      approvals: [],
    });
    // 二进制 plist 没有文本行，行号只要求是正整数；其余字段逐项核对。
    expect(result.errors, kind).toEqual([]);
    expect(result.hits, kind).toHaveLength(1);
    expect(result.hits[0], kind).toMatchObject({
      rule: 'request-sign-material',
      file: 'Payload/Demo.app/Sign.plist',
      match: SHORT_SALT,
      never_accepted: true,
    });
    expect(Number.isInteger(result.hits[0]?.line) && (result.hits[0]?.line ?? 0) >= 1, kind).toBe(
      true,
    );
    expectBlocked(result, kind);
  }
});

it('[02 §12.6 制品#8] 不含密钥的二进制 plist（真实 ipa 的 Info.plist 默认格式）能读通，制品通过', async () => {
  const info = bplist([
    ['CFBundleIdentifier', 'com.example.demo', 'ascii'],
    ['CFBundleName', 'Demo', 'ascii'],
    ['CFBundleExecutable', 'Demo', 'ascii'],
    ['CFBundleShortVersionString', '1.0.0', 'ascii'],
    ['CFBundleDisplayName', `D${String.fromCharCode(0xe9)}mo`, 'utf16'],
  ]);
  const macho = Buffer.concat([
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 0x01]),
    Buffer.alloc(56),
  ]);
  const result = await scanArtifact({
    path: writeZip(newDir(), 'clean.ipa', [
      { name: 'Payload/Demo.app/Info.plist', data: info },
      { name: 'Payload/Demo.app/Demo', data: macho },
    ]),
    platform: 'ios',
    manifestYaml: realManifest(),
    approvals: [],
  });
  expect(result.errors).toEqual([]);
  expect(result.hits).toEqual([]);
  expect(result.exit_code).toBe(0);
  expect(result.passed).toBe(true);
});

/**
 * 最小的二进制 AndroidManifest（AXML，运行时生成）：UTF-16 字符串池 + 命名空间 + <manifest package=… android:versionName=…>。
 * 结构按 Android ResChunk 格式手写，未经 aapt 校验；不含任何密钥。
 */
function axml(): Buffer {
  const strings = [
    'android',
    'http://schemas.android.com/apk/res/android',
    'manifest',
    'package',
    'com.example.demo',
    'versionName',
    '1.0.0',
  ];
  const chunk = (type: number, headerSize: number, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(headerSize, 2);
    head.writeUInt32LE(8 + body.length, 4);
    return Buffer.concat([head, body]);
  };
  const u32 = (...values: number[]): Buffer => {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
    return b;
  };
  const data = strings.map((s) => {
    const len = Buffer.alloc(2);
    len.writeUInt16LE(s.length, 0);
    return Buffer.concat([len, Buffer.from(s, 'utf16le'), Buffer.alloc(2)]);
  });
  const offsets: number[] = [];
  let at = 0;
  for (const d of data) {
    offsets.push(at);
    at += d.length;
  }
  const raw = Buffer.concat(data);
  const pad = Buffer.alloc((4 - (raw.length % 4)) % 4);
  const pool = chunk(
    0x0001,
    28,
    Buffer.concat([
      u32(strings.length, 0, 0, 28 + strings.length * 4, 0),
      u32(...offsets),
      raw,
      pad,
    ]),
  );
  const NONE = 0xffffffff;
  const attr = (ns: number, name: number, value: number): Buffer => {
    const typed = Buffer.alloc(8);
    typed.writeUInt16LE(8, 0);
    typed.writeUInt8(0x03, 3);
    typed.writeUInt32LE(value, 4);
    return Buffer.concat([u32(ns, name, value), typed]);
  };
  const attrHead = Buffer.alloc(12);
  attrHead.writeUInt16LE(20, 0);
  attrHead.writeUInt16LE(20, 2);
  attrHead.writeUInt16LE(2, 4);
  const startNs = chunk(0x0100, 16, u32(1, NONE, 0, 1));
  const start = chunk(
    0x0102,
    16,
    Buffer.concat([u32(1, NONE, NONE, 2), attrHead, attr(NONE, 3, 4), attr(1, 5, 6)]),
  );
  const end = chunk(0x0103, 16, u32(1, NONE, NONE, 2));
  const endNs = chunk(0x0101, 16, u32(1, NONE, 0, 1));
  return chunk(0x0003, 8, Buffer.concat([pool, startNs, start, end, endNs]));
}

it('[02 §12.6 制品#9] apk 里不含密钥的二进制 AndroidManifest 与 dex 不导致误阻断', async () => {
  const dex = Buffer.concat([Buffer.from('dex\n035\0', 'latin1'), Buffer.alloc(104)]);
  const manifest = axml();
  expect(manifest.readUInt16LE(0)).toBe(0x0003);
  expect(manifest.readUInt32LE(4)).toBe(manifest.length);
  const result = await scanArtifact({
    path: writeZip(newDir(), 'clean.apk', [
      { name: 'AndroidManifest.xml', data: manifest },
      { name: 'classes.dex', data: dex },
    ]),
    platform: 'android',
    manifestYaml: realManifest(),
    approvals: [],
  });
  expect(result.errors).toEqual([]);
  expect(result.hits).toEqual([]);
  expect(result.exit_code).toBe(0);
  expect(result.passed).toBe(true);
});

it('[BR-ID-09 编码#2] 扫描制品：ipa 里 UTF-16LE 的 plist、apk 里 UTF-16BE 的 XML 带签名材料都被阻断', async () => {
  const dir = newDir();
  const plist = `<plist>\n<dict>\n<key>install_secret</key>\n<string>${FAKE.hex32Low}</string>\n</dict>\n</plist>\n`;
  const ipa = await scanArtifact({
    path: writeZip(dir, 'demo.ipa', [
      { name: 'Payload/Demo.app/Sign.plist', data: utf16le(plist) },
    ]),
    platform: 'ios',
    manifestYaml: realManifest(),
    approvals: [],
  });
  expect(ipa.hits).toEqual([
    want('request-sign-material', 'Payload/Demo.app/Sign.plist', 4, FAKE.hex32Low),
  ]);
  expectBlocked(ipa, 'ipa');
  const xml = `<resources>\n<string name="sign_salt">${SHORT_SALT}</string>\n</resources>\n`;
  const apk = await scanArtifact({
    path: writeZip(dir, 'demo.apk', [{ name: 'res/raw/sign.xml', data: utf16be(xml), method: 0 }]),
    platform: 'android',
    manifestYaml: realManifest(),
    approvals: [],
  });
  expect(apk.hits).toEqual([want('request-sign-material', 'res/raw/sign.xml', 2, SHORT_SALT)]);
  expectBlocked(apk, 'apk');
});

const NAMES = [
  'install_secret',
  'installSecret',
  'signKey',
  'sign_secret',
  'hmacKey',
  'shared_salt',
  'salt',
];
const ALNUM = `${LETTERS}${LETTERS.toUpperCase()}0123456789`;
const VALUE_CHARS = `${ALNUM}!#$%&()*+,-./:;=?@[]^_{|}~`;
const LAYOUTS = [
  (n: string, v: string) => `${n}: "${v}",`,
  (n: string, v: string) => `"${n}":"${v}"`,
  (n: string, v: string) => `${n} = '${v}';`,
  (n: string, v: string) => `${n}=${v}`,
  (n: string, v: string) => `<string name="${n}">${v}</string>`,
];

function one(hits: readonly ScanHit[], line: number, value: string): boolean {
  const h = hits[0];
  return (
    hits.length === 1 &&
    h !== undefined &&
    h.rule === 'request-sign-material' &&
    h.file === FILE &&
    h.line === line &&
    h.match === value &&
    h.never_accepted
  );
}

it('[BR-ID-09 签名材料#3] 属性：签名材料字段配任意 1–48 位取值（可无数字、可含标点、可低熵），UTF-8 与 UTF-16 都恰好报一条', () => {
  const stats = createPropStats('release-scan:detect:sign-material');
  const arb = fc.record({
    name: fc.constantFrom(...NAMES),
    layout: fc.constantFrom(...LAYOUTS),
    encoding: fc.constantFrom('utf8', 'utf16le', 'utf16be'),
    before: fc.integer({ min: 0, max: 4 }),
    value: fc
      .tuple(
        fc.constantFrom(...ALNUM.split('')),
        fc.array(fc.constantFrom(...VALUE_CHARS.split('')), { minLength: 0, maxLength: 47 }),
      )
      .map(([head, rest]) => `${head}${rest.join('')}`)
      .filter((v) => !v.includes(['LT', 'AI'].join('')) && !v.includes('://')),
  });
  fc.assert(
    fc.property(arb, ({ name, layout, encoding, before, value }) => {
      const text = `${'# filler\n'.repeat(before)}${layout(name, value)}\n`;
      const content =
        encoding === 'utf16le' ? utf16le(text) : encoding === 'utf16be' ? utf16be(text) : text;
      const ok = one(detectSecrets(FILE, content), before + 1, value);
      stats.hit(ok ? 'ok' : 'bad');
      return ok;
    }),
    propParams(),
  );
  expect(stats.flush().hits).toEqual({ ok: propRuns() });
}, 900_000);
