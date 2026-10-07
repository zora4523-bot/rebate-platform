import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

export {
  FAKE,
  buildZip,
  manifestWith,
  realManifest,
  spread,
  writeTree,
  writeZip,
} from '../detect/fixtures.ts';

// 临时目录：仓库根 .tmp/QA-09c/（已被 git 与仓库 gitleaks 忽略；AGENTS.md §9 不用 /tmp），每个测试文件结束时删除。
const TMP_ROOT = fileURLToPath(new URL('../../../../.tmp/QA-09c/', import.meta.url));

/** 在测试文件里调用一次；返回的函数每次新建一个独立的临时目录。 */
export function tempDirs(): () => string {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, 'residue-'));
    made.push(dir);
    return dir;
  };
}

/** 在 dir 下写一个文本文件，返回路径。 */
export function writeText(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/**
 * 最小的二进制 AndroidManifest（AXML，运行时生成）：UTF-16 字符串池 + android 命名空间 +
 * <application android:debuggable=…>，debuggable 为 TYPE_INT_BOOLEAN（0x12），data 非 0 即 true。
 * 结构同 test/spec/release-scan/detect/sign-material.test.ts 的 axml()，按 Android ResChunk 手写，未经 aapt 校验。
 */
export function axmlApplication(debuggable: number): Buffer {
  const strings = [
    'android',
    'http://schemas.android.com/apk/res/android',
    'application',
    'debuggable',
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
  const typed = Buffer.alloc(8);
  typed.writeUInt16LE(8, 0);
  typed.writeUInt8(0x12, 3);
  typed.writeUInt32LE(debuggable >>> 0, 4);
  const attrHead = Buffer.alloc(12);
  attrHead.writeUInt16LE(20, 0);
  attrHead.writeUInt16LE(20, 2);
  attrHead.writeUInt16LE(1, 4);
  const startNs = chunk(0x0100, 16, u32(1, NONE, 0, 1));
  const start = chunk(
    0x0102,
    16,
    Buffer.concat([u32(1, NONE, NONE, 2), attrHead, u32(1, 3, NONE), typed]),
  );
  const end = chunk(0x0103, 16, u32(1, NONE, NONE, 2));
  const endNs = chunk(0x0101, 16, u32(1, NONE, 0, 1));
  return chunk(0x0003, 8, Buffer.concat([pool, startNs, start, end, endNs]));
}

/** 仿 embedded.mobileprovision：DER 外壳字节 + XML plist（get-task-allow 取 value）+ 尾部签名字节。 */
export function mobileprovision(getTaskAllow: boolean): Buffer {
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '\t<key>Entitlements</key>',
    '\t<dict>',
    '\t\t<key>get-task-allow</key>',
    `\t\t<${String(getTaskAllow)}/>`,
    '\t</dict>',
    '</dict></plist>',
  ].join('\n');
  return Buffer.concat([
    Buffer.from([0x30, 0x82, 0x1f, 0x00, 0x06, 0x09, 0x2a, 0x86, 0x48]),
    Buffer.from(plist, 'utf8'),
    Buffer.from([0x00, 0xa0, 0x82, 0x0d, 0x31, 0x00]),
  ]);
}

/** 仿 dex 里的 MUTF-8 串：两侧是 NUL 与长度字节，没有引号。 */
export function dexWith(text: string): Buffer {
  return Buffer.concat([
    Buffer.from('dex\n035\0', 'latin1'),
    Buffer.alloc(24),
    Buffer.from([text.length & 0x7f]),
    Buffer.from(text, 'latin1'),
    Buffer.alloc(8),
  ]);
}
