import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { MemoryExportStore } from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';

const KEY = 'read_hardening/export_1.csv';

function store() {
  return new MemoryExportStore({
    baseUrl: 'https://exports.invalid',
    signingKey: 'B1-34j-test-only-signing-key',
    clock: new FixedClock('2026-10-23T00:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'admin', appEnv: 'test' }),
  });
}

it('[AC-B1-34j#5] put 保存 Buffer 视图的独立字节快照，之后改原 Buffer 或复用输入不污染文件', async () => {
  const memory = store();
  for (const input of [
    Uint8Array.from([99, 65, 44, 66, 10, 88]),
    Buffer.from([99, 65, 44, 66, 10, 88]),
  ]) {
    const bytes = input.subarray(1, 5);
    await memory.put({ key: KEY, bytes, contentType: 'text/csv' });
    expect(memory.get(KEY)?.contentType).toBe('text/csv');
    expect(Array.from(memory.get(KEY)!.bytes)).toEqual([65, 44, 66, 10]);
    input.fill(90);
    expect.soft(Array.from(memory.get(KEY)!.bytes)).toEqual([65, 44, 66, 10]);

    // Only an explicit put replaces the old snapshot, and the replacement is copied too.
    await memory.put({ key: KEY, bytes, contentType: 'text/csv' });
    bytes.fill(0);
    expect.soft(Array.from(memory.get(KEY)!.bytes)).toEqual([90, 90, 90, 90]);
  }
});

it('[AC-B1-34j#6] get 每次返回独立字节，修改一次读出的内容不污染存储或另一次读取', async () => {
  const memory = store();
  for (const bytes of [Uint8Array.from([65, 44, 66, 10]), Buffer.from([65, 44, 66, 10])]) {
    await memory.put({ key: KEY, bytes, contentType: 'text/csv' });
    const first = memory.get(KEY);
    const second = memory.get(KEY);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.bytes).not.toBe(second!.bytes);
    first!.bytes.fill(0);
    expect.soft(Array.from(second!.bytes)).toEqual([65, 44, 66, 10]);
    expect.soft(Array.from(memory.get(KEY)!.bytes)).toEqual([65, 44, 66, 10]);
    expect.soft(Array.from(bytes)).toEqual([65, 44, 66, 10]);
    second!.bytes[0] = 90;
    expect.soft(Array.from(memory.get(KEY)!.bytes)).toEqual([65, 44, 66, 10]);
  }
});
