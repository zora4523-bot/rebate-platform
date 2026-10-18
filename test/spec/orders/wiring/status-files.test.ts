import * as fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { scheduledPlatforms } from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { capture } from '../attribution/kit.ts';
import { contextOf, runtime, token } from './context-kit.ts';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
afterEach(() => vi.mocked(fs.readFileSync).mockReset());

const mapReads = () =>
  vi
    .mocked(fs.readFileSync)
    .mock.calls.filter(([path]) => String(path).includes('/specs/order-status-map/'));

it('[AC-B1-08n#11] 装配时每个调度平台只读一次 CSV，随后 statusMaps 只取缓存', async () => {
  const f = await contextOf('worker', true);
  try {
    const r = await runtime(f.context);
    const reads = mapReads();
    expect(reads.map(([path]) => String(path).split('/').at(-1)).sort()).toEqual(
      scheduledPlatforms()
        .map((p) => `${p}.csv`)
        .sort(),
    );
    for (let i = 0; i < 5; i++) for (const p of scheduledPlatforms()) r.statusMaps(p);
    expect(mapReads()).toEqual(reads);
  } finally {
    await f.context.close();
  }
});

it.each(['ENOENT', 'EACCES'] as const)(
  '[AC-B1-08n#12] CSV 读取 %s 必须中止启动；只翻译 ENOENT',
  async (code) => {
    await token();
    const original = vi.mocked(fs.readFileSync).getMockImplementation()!;
    const error = Object.assign(new Error(`synthetic-${code}`), { code });
    vi.mocked(fs.readFileSync).mockImplementation((...args) => {
      if (String(args[0]).endsWith('/specs/order-status-map/pdd.csv')) throw error;
      return original(...args);
    });
    const result = await capture(() => contextOf('worker', true));
    if (result.ok) await result.value.context.close();
    expect(mapReads()).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      if (code === 'ENOENT') expect(result.error).toMatchObject({ code: 'MISSING_STATUS_MAP' });
      else expect(result.error).toBe(error);
    }
  },
);
