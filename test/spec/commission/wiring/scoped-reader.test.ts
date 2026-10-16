import { expect, it, vi } from 'vitest';
import {
  openScopedReader,
  OpenReadNotPrepared,
  withOpenReads,
} from '../../../../apps/api/src/modules/linking/application/link-open-reads.ts';

it('[AC-B2-03d#10] 通用读取入口从 linking 公开，开放外每次直读，开放内同 reader/key 合并预读', async () => {
  const publicApi = (await import(
    new URL('../../../../apps/api/src/modules/linking/index.ts', import.meta.url).href
  )) as { openScopedReader: typeof openScopedReader };
  expect(publicApi.openScopedReader).toBe(openScopedReader);
  const reader = {};
  const load = vi.fn(async () => ({ value: load.mock.calls.length }));
  const read = () => publicApi.openScopedReader(reader, '["app"]', 'rule versions', load);
  expect(await read()).toEqual({ value: 1 });
  expect(await read()).toEqual({ value: 2 });
  await withOpenReads(
    async () => {
      expect(await Promise.all([read(), read()])).toEqual([{ value: 3 }, { value: 3 }]);
    },
    async () => {
      expect(await read()).toEqual({ value: 3 });
      expect(load).toHaveBeenCalledTimes(3);
    },
  );
  expect(await read()).toEqual({ value: 4 });
});

it('[AC-B2-03d#11] 相同键不同端口不会串值，未准备的新键或新端口在锁定后拒绝读取', async () => {
  const a = {};
  const b = {};
  const loadA = vi.fn(async () => 'rules');
  const loadB = vi.fn(async () => 'levels');
  await withOpenReads(
    async () => {
      expect(await openScopedReader(a, 'same-key', 'rules', loadA)).toBe('rules');
      expect(await openScopedReader(b, 'same-key', 'levels', loadB)).toBe('levels');
    },
    async () => {
      expect(await openScopedReader(a, 'same-key', 'rules', loadA)).toBe('rules');
      expect(await openScopedReader(b, 'same-key', 'levels', loadB)).toBe('levels');
      await expect(openScopedReader(a, 'different-key', 'rules', loadA)).rejects.toBeInstanceOf(
        OpenReadNotPrepared,
      );
      await expect(openScopedReader({}, 'same-key', 'rules', loadA)).rejects.toBeInstanceOf(
        OpenReadNotPrepared,
      );
      expect(loadA).toHaveBeenCalledTimes(1);
      expect(loadB).toHaveBeenCalledTimes(1);
    },
  );
});

it('[AC-B2-03d#12] 失败预读也记忆原错误，下一开放重新读取，失败不污染其他作用域', async () => {
  const reader = {};
  const failed = new Error('synthetic read failed');
  const load = vi.fn(async (): Promise<string> => {
    throw failed;
  });
  const read = () => openScopedReader(reader, 'key', 'config', load);
  await withOpenReads(
    async () => {
      const pending = read(); // skeleton throws before a negative assertion can accept it
      expect(await Promise.allSettled([pending])).toEqual([{ status: 'rejected', reason: failed }]);
    },
    async () => {
      await expect(read()).rejects.toBe(failed);
      expect(load).toHaveBeenCalledTimes(1);
    },
  );
  load.mockResolvedValue('recovered');
  await withOpenReads(
    async () => {
      expect(await read()).toBe('recovered');
    },
    async () => {
      expect(await read()).toBe('recovered');
      expect(load).toHaveBeenCalledTimes(2);
    },
  );
});
