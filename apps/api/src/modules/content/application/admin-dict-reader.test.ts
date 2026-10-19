import { expect, it, vi } from 'vitest';
import { AdminDictReader } from './admin-dict-reader.ts';
import type { DictStore } from './dict-reader.ts';

const DEFAULTS = {
  'admin_dict.status.OK': '默认正常',
  'admin_dict.a.b.UP': '默认大写',
};

it('[AC-F1-02zd#u7] 每次读一次快照、不缓存；覆盖只取后台行，版本原样回传', async () => {
  let value: unknown = '3';
  const limits: (number | null)[] = [];
  const snapshot = vi.fn<DictStore['snapshot']>(async (_appId, limitOf) => {
    limits.push(limitOf(value));
    return {
      value,
      rows: [
        { dict: 'admin_dict', code: 'a.b.UP', text: '覆盖大写' },
        { dict: 'status', code: 'OK', text: '用户字典' },
      ],
    };
  });
  const warn = vi.fn();
  const reader = new AdminDictReader({ snapshot }, () => DEFAULTS, { warn });
  const expected = { status: { OK: '默认正常' }, 'a.b': { UP: '覆盖大写' } };
  expect(await reader.read('app_a')).toEqual({ version: '3', items: expected });
  value = '4';
  expect(await reader.read('app_a')).toEqual({ version: '4', items: expected });
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(limits).toEqual([3, 4]);
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-F1-02zd#u8] 未发布或非规范版本只给默认；"0" 与缺行不告警，其余告警', async () => {
  for (const [value, warned] of [
    [undefined, false],
    ['0', false],
    ['01', true],
    [5, true],
  ] as const) {
    const warn = vi.fn();
    const reader = new AdminDictReader(
      {
        snapshot: async () => ({
          value,
          rows: [{ dict: 'admin_dict', code: 'status.OK', text: '不得生效' }],
        }),
      },
      () => DEFAULTS,
      { warn },
    );
    expect(await reader.read('app_b')).toEqual({
      version: typeof value === 'string' ? value : '0',
      items: { status: { OK: '默认正常' }, 'a.b': { UP: '默认大写' } },
    });
    expect(warn).toHaveBeenCalledTimes(warned ? 1 : 0);
  }
});

it('[AC-F1-02zd#u9] 无库句柄拒绝；默认文件错误原样抛出且不查库；构造期不读默认', async () => {
  const defaults = vi.fn(() => DEFAULTS);
  const noDb = new AdminDictReader(null, defaults, { warn: vi.fn() });
  expect(defaults).not.toHaveBeenCalled();
  await expect(noDb.read('app_c')).rejects.toThrow(/database/);
  const failure = new Error('fixture: broken defaults');
  const snapshot = vi.fn<DictStore['snapshot']>(async () => ({ value: '1', rows: [] }));
  const broken = new AdminDictReader(
    { snapshot },
    () => {
      throw failure;
    },
    { warn: vi.fn() },
  );
  await expect(broken.read('app_c')).rejects.toBe(failure);
  expect(snapshot).not.toHaveBeenCalled();
  const storeFailure = new Error('fixture: snapshot failed');
  const failing = new AdminDictReader(
    { snapshot: () => Promise.reject(storeFailure) },
    () => DEFAULTS,
    { warn: vi.fn() },
  );
  await expect(failing.read('app_c')).rejects.toBe(storeFailure);
});
