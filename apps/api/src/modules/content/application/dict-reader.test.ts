import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { DictReader, type DictSnapshot, type DictStore } from './dict-reader.ts';

const AT = '2031-03-04T05:06:07.000Z';

function fixture(snapshots: Record<string, DictSnapshot>) {
  const clock = new FixedClock(AT);
  const warn = vi.fn();
  const limits: (number | null)[] = [];
  const store: DictStore = {
    snapshot: vi.fn(async (appId: string, limitOf: (value: unknown) => number | null) => {
      const snapshot = snapshots[appId] ?? { value: undefined, rows: [] };
      limits.push(limitOf(snapshot.value));
      return snapshot;
    }),
  };
  return { clock, warn, limits, store, reader: new DictReader(store, clock, { warn }) };
}

it('[AC-F1-02s#8] 版本与内容来自同一次快照读，一次加载只调用一次 snapshot', async () => {
  const f = fixture({
    a: { value: '3', rows: [{ dict: 'order_status', code: 'CREDITED.summary', text: '已到账' }] },
  });
  expect(await f.reader.read('a')).toEqual({
    version: '3',
    items: { order_status: { 'CREDITED.summary': '已到账' } },
  });
  expect(f.store.snapshot).toHaveBeenCalledTimes(1);
  expect(f.limits).toEqual([3]);
  expect(f.warn).not.toHaveBeenCalled();
});

it('[AC-F1-02s#11] 缺行与 "0" 回空且不 warn；非字符串与非法串回空并 warn，即使快照带回行', async () => {
  const rows = [{ dict: 'ai_label', code: '', text: '不能下发' }];
  const f = fixture({
    zero: { value: '0', rows },
    num: { value: 12, rows },
    bad: { value: 'dict-42', rows },
  });
  expect(await f.reader.read('missing')).toEqual({ version: '0', items: {} });
  expect(await f.reader.read('zero')).toEqual({ version: '0', items: {} });
  expect(f.warn).not.toHaveBeenCalled();
  expect(await f.reader.read('num')).toEqual({ version: '0', items: {} });
  expect(await f.reader.read('bad')).toEqual({ version: 'dict-42', items: {} });
  expect(f.warn).toHaveBeenCalledTimes(2);
  expect(f.limits).toEqual([null, null, null, null]);
});

it('[AC-F1-02s#16] 按 app 缓存 60 秒，到期才重读', async () => {
  const f = fixture({ a: { value: '1', rows: [] }, b: { value: '2', rows: [] } });
  await f.reader.read('a');
  await f.reader.read('b');
  f.clock.advanceMs(59_999);
  expect(await f.reader.read('a')).toEqual({ version: '1', items: {} });
  expect(f.store.snapshot).toHaveBeenCalledTimes(2);
  f.clock.advanceMs(1);
  await f.reader.read('a');
  expect(f.store.snapshot).toHaveBeenCalledTimes(3);
});

it('[AC-F1-02s#18] 无库句柄时拒绝，不回成功的空字典', async () => {
  const reader = new DictReader(null, new FixedClock(AT), { warn: vi.fn() });
  await expect(reader.read('a')).rejects.toThrow('need the database');
});
