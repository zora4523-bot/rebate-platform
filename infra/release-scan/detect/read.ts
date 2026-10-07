import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import type { ClientPlatform, ReadResult } from './index.ts';

const PLATFORMS: Readonly<Record<string, ClientPlatform>> = {
  '.ipa': 'ios',
  '.apk': 'android',
  '.aab': 'android',
  '.hap': 'harmony',
  '.app': 'harmony',
};
const NESTED = new Set(['.ipa', '.app', '.hap', '.hsp', '.apk', '.aab', '.jar', '.aar', '.zip']);
// 超限按读取失败返回，绝不把未扫描内容当成通过。解包只在内存里进行。
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 16;

interface Budget {
  bytes: number;
  entries: number;
}

export function artifactPlatform(path: string): ClientPlatform | undefined {
  return PLATFORMS[extname(path).toLowerCase()];
}

function reserve(budget: Budget, size: number): void {
  if (
    size > MAX_FILE ||
    size < 0 ||
    budget.bytes + size > MAX_TOTAL ||
    budget.entries >= MAX_ENTRIES
  )
    throw new Error('Artifact exceeds scan limits');
  budget.bytes += size;
  budget.entries++;
}

function safeName(name: string): boolean {
  const parts = name.replace(/\/$/, '').split('/');
  return (
    name.length > 0 &&
    !/[\\\x00-\x1f\x7f:]/.test(name) &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function unpack(
  bytes: Buffer,
  prefix: string,
  result: ReadResult,
  budget: Budget,
  depth: number,
): void {
  const fail = (): never => {
    throw new Error('Invalid or unsupported ZIP');
  };
  try {
    if (depth > MAX_DEPTH) throw new Error('Nested archive depth exceeded');
    let end = bytes.length - 22;
    for (; end >= Math.max(0, bytes.length - 65_557); end--) {
      if (
        bytes.readUInt32LE(end) === 0x06054b50 &&
        end + 22 + bytes.readUInt16LE(end + 20) === bytes.length
      )
        break;
    }
    if (end < Math.max(0, bytes.length - 65_557)) fail();
    const count = bytes.readUInt16LE(end + 10);
    const cdSize = bytes.readUInt32LE(end + 12);
    const cdStart = bytes.readUInt32LE(end + 16);
    if (
      bytes.readUInt16LE(end + 4) !== 0 ||
      bytes.readUInt16LE(end + 6) !== 0 ||
      bytes.readUInt16LE(end + 8) !== count ||
      count === 0xffff ||
      cdStart + cdSize !== end
    )
      fail();
    let cursor = cdStart;
    const names = new Set<string>();
    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail();
      const flags = bytes.readUInt16LE(cursor + 8);
      const method = bytes.readUInt16LE(cursor + 10);
      const crc = bytes.readUInt32LE(cursor + 16);
      const compressed = bytes.readUInt32LE(cursor + 20);
      const size = bytes.readUInt32LE(cursor + 24);
      const nameSize = bytes.readUInt16LE(cursor + 28);
      const extraSize = bytes.readUInt16LE(cursor + 30);
      const commentSize = bytes.readUInt16LE(cursor + 32);
      const disk = bytes.readUInt16LE(cursor + 34);
      const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
      const local = bytes.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameSize + extraSize + commentSize;
      if (next > end) fail();
      const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
      const name = rawName.toString('utf8');
      cursor = next;
      const path = prefix ? `${prefix}/${name}` : name;
      try {
        if (
          !safeName(name) ||
          name.includes('\ufffd') ||
          names.has(name) ||
          disk !== 0 ||
          (mode & 0xf000) === 0xa000 ||
          (flags & 0x2041) !== 0 ||
          ![0, 8].includes(method) ||
          size === 0xffffffff ||
          compressed === 0xffffffff ||
          local + 30 > cdStart ||
          bytes.readUInt32LE(local) !== 0x04034b50
        )
          fail();
        names.add(name);
        const localNameSize = bytes.readUInt16LE(local + 26);
        const dataStart = local + 30 + localNameSize + bytes.readUInt16LE(local + 28);
        const dataEnd = dataStart + compressed;
        if (
          dataEnd > cdStart ||
          bytes.readUInt16LE(local + 6) !== flags ||
          bytes.readUInt16LE(local + 8) !== method ||
          !bytes.subarray(local + 30, local + 30 + localNameSize).equals(rawName) ||
          ranges.some(([start, stop]) => local < stop && dataEnd > start)
        )
          fail();
        let recordEnd = dataEnd;
        if (flags & 8) {
          const descriptor = dataEnd + (bytes.readUInt32LE(dataEnd) === 0x08074b50 ? 4 : 0);
          recordEnd = descriptor + 12;
          if (
            recordEnd > cdStart ||
            bytes.readUInt32LE(descriptor) !== crc ||
            bytes.readUInt32LE(descriptor + 4) !== compressed ||
            bytes.readUInt32LE(descriptor + 8) !== size
          )
            fail();
        }
        if (ranges.some(([start, stop]) => local < stop && recordEnd > start)) fail();
        ranges.push([local, recordEnd]);
        if (
          !(flags & 8) &&
          (bytes.readUInt32LE(local + 14) !== crc ||
            bytes.readUInt32LE(local + 18) !== compressed ||
            bytes.readUInt32LE(local + 22) !== size)
        )
          fail();
        reserve(budget, size);
        const data = bytes.subarray(dataStart, dataEnd);
        const content =
          method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.max(1, size) });
        if (content.length !== size || crc32(content) !== crc) fail();
        if (name.endsWith('/')) {
          if (size !== 0) fail();
        } else if (NESTED.has(extname(name).toLowerCase())) {
          unpack(content, path, result, budget, depth + 1);
        } else result.entries.push({ path, content });
      } catch {
        result.errors.push(`ZIP entry unreadable: ${path}`);
      }
    }
    if (cursor !== end) fail();
  } catch {
    result.errors.push(`ZIP unreadable: ${prefix || '<artifact>'}`);
  }
}

/** 不跟随文件符号链接；打开后再核对类型与大小，防止 FIFO 或超大文件拖住扫描。 */
async function fileBytes(path: string, budget: Budget): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Not a regular file');
    reserve(budget, stat.size);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Artifact changed during read');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error('Artifact changed during read');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readArtifact(path: string): Promise<ReadResult> {
  const result: ReadResult = { entries: [], errors: [] };
  const budget: Budget = { bytes: 0, entries: 0 };
  const visit = async (absolute: string, relative: string, depth: number): Promise<void> => {
    try {
      if (depth > 128) throw new Error('Directory depth exceeded');
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Symbolic link rejected');
      if (stat.isDirectory()) {
        // 目录也计数，空目录不能绕过遍历预算。
        reserve(budget, 0);
        for (const name of (await readdir(absolute)).sort()) {
          await visit(join(absolute, name), relative ? `${relative}/${name}` : name, depth + 1);
        }
      } else if (stat.isFile()) {
        const content = await fileBytes(absolute, budget);
        if (relative === '' || NESTED.has(extname(relative).toLowerCase())) {
          unpack(content, relative, result, budget, 0);
        } else result.entries.push({ path: relative, content });
      } else throw new Error('Unsupported file type');
    } catch {
      result.errors.push(`Artifact path unreadable: ${relative || '<artifact>'}`);
    }
  };
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() && !artifactPlatform(path))
      throw new Error('Unsupported artifact extension');
    await visit(path, '', 0);
  } catch {
    result.errors.push('Artifact missing or unsupported');
  }
  const paths = new Set<string>();
  for (const entry of result.entries) {
    if (paths.has(entry.path)) result.errors.push(`Duplicate artifact path: ${entry.path}`);
    paths.add(entry.path);
  }
  result.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}
