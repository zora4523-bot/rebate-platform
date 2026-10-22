import { expect, it } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import { createRootLogger } from '../logging/logger.ts';
import { MemoryExportStore } from './index.ts';

const KEY = 'couli/export_1.csv';

function store(): MemoryExportStore {
  return new MemoryExportStore({
    baseUrl: 'https://exports.invalid',
    signingKey: 'unit-test-only-signing-key',
    clock: new FixedClock('2026-10-23T00:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'admin', appEnv: 'test' }),
  });
}

it('[AC-B1-34j] put keeps its own copy of a Buffer view; get hands out a fresh copy each time', async () => {
  const memory = store();
  const input = Buffer.from([1, 65, 66, 2]);
  await memory.put({ key: KEY, bytes: input.subarray(1, 3), contentType: 'text/csv' });
  input.fill(0);
  const first = memory.get(KEY)!;
  expect(Array.from(first.bytes)).toEqual([65, 66]);
  first.bytes.fill(9);
  expect(Array.from(memory.get(KEY)!.bytes)).toEqual([65, 66]);
});
