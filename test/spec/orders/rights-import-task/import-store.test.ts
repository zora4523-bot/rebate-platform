// 私有导入存储端口（platform/import-store，照 export-store 先例）：local / test 用内存实现，staging / prod
// 在 OSS 适配器（B1-30）之前构造成功、按请求失败；日志只带键，不带文件内容。
// 用例全部是顶层 it（资金 / 归属测试路径，规划/11 §4.3）。
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createImportStore,
  type ImportPutInput,
} from '../../../../apps/api/src/modules/platform/import-store/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { PRIVATE_CELL, XLSX_MIME, hex, sheet } from './kit.ts';

function capture() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'debug', entry: 'admin', appEnv: 'test' },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );
  return { lines, logger };
}

const key = () => `ri_store/${randomUUID()}.xlsx`;
const input = (k: string, bytes: Uint8Array): ImportPutInput => ({
  key: k,
  bytes,
  contentType: XLSX_MIME,
});

it.each(['local', 'test'] as const)(
  '[AC-B1-09g#5] %s：put 后 get 取回同样的字节；缺的键是 null',
  async (appEnv) => {
    const { logger } = capture();
    const store = createImportStore({ appEnv, logger });
    const k = key();
    const bytes = new Uint8Array(sheet(['succeeded']));
    await store.put(input(k, bytes));
    expect(hex(await store.get(k))).toBe(hex(bytes));
    expect(await store.get(key())).toBeNull();
  },
);

it('[AC-B1-09g#5] 存的是副本：调用方之后改缓冲区、改 get 的结果，都碰不到存的文件', async () => {
  const { logger } = capture();
  const store = createImportStore({ appEnv: 'test', logger });
  const k = key();
  const bytes = new Uint8Array(sheet(['succeeded']));
  const original = new Uint8Array(bytes);
  await store.put(input(k, bytes));
  bytes.fill(0);
  const first = await store.get(k);
  expect(hex(first)).toBe(hex(original));
  first?.fill(0);
  expect(hex(await store.get(k))).toBe(hex(original));
});

it('[AC-B1-09g#5] put 同一个键是覆盖；delete 之后 get 为 null，删不存在的键也成功', async () => {
  const { logger } = capture();
  const store = createImportStore({ appEnv: 'test', logger });
  const k = key();
  await store.put(input(k, new Uint8Array([1, 2, 3])));
  await store.put(input(k, new Uint8Array([4, 5])));
  expect(hex(await store.get(k))).toBe(hex(new Uint8Array([4, 5])));
  await store.delete(k);
  expect(await store.get(k)).toBeNull();
  await expect(store.delete(k)).resolves.toBeUndefined();
});

it('[AC-B1-09g#5] 日志不带文件内容', async () => {
  const { lines, logger } = capture();
  const store = createImportStore({ appEnv: 'test', logger });
  const k = key();
  await store.put(input(k, new Uint8Array(Buffer.from(`${PRIVATE_CELL}-raw-bytes`))));
  await store.get(k);
  await store.delete(k);
  expect(lines.join('\n')).not.toContain(PRIVATE_CELL);
});

it.each(['staging', 'prod'] as const)(
  '[AC-B1-09g#6] %s（OSS 适配器之前）：构造成功，put / get 按请求失败',
  async (appEnv) => {
    const { lines, logger } = capture();
    const store = createImportStore({ appEnv, logger });
    const k = key();
    await expect(
      store.put(input(k, new Uint8Array(Buffer.from(PRIVATE_CELL)))),
    ).rejects.toBeInstanceOf(Error);
    await expect(store.get(k)).rejects.toBeInstanceOf(Error);
    expect(lines.join('\n')).not.toContain(PRIVATE_CELL);
  },
);
