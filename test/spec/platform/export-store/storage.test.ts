import { expect, it } from 'vitest';
import type { ExportPutInput } from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import { CSV, EXPIRES, KEY, OTHER_KEY, memory } from './kit.ts';

it('[AC-B1-34d#1] 写入保持字节和 CSV 类型，不返回公开地址；空文件也可存储', async () => {
  const { store } = memory();
  expect(store.get(KEY)).toBeUndefined();
  expect(await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' })).toBeUndefined();
  expect(store.get(KEY)).toEqual({ bytes: CSV, contentType: 'text/csv' });
  await store.put({ key: OTHER_KEY, bytes: new Uint8Array(), contentType: 'text/csv' });
  expect(store.get(OTHER_KEY)).toEqual({ bytes: new Uint8Array(), contentType: 'text/csv' });
});

it('[AC-B1-34d#2] 重复与并发写入幂等，同 key 覆盖且不同 app_id 互不影响', async () => {
  const { store } = memory();
  const input = { key: KEY, bytes: CSV, contentType: 'text/csv' as const };
  await store.put(input);
  await store.put({ ...input, key: OTHER_KEY });
  await Promise.all(Array.from({ length: 4 }, () => store.put(input)));
  expect(store.get(KEY)).toEqual({ bytes: CSV, contentType: 'text/csv' });
  const replacement = new TextEncoder().encode('replacement\n');
  await store.put({ ...input, bytes: replacement });
  expect(store.get(KEY)?.bytes).toEqual(replacement);
  expect(store.get(OTHER_KEY)?.bytes).toEqual(CSV);
});

it('[AC-B1-34d#3] 只复制视图内字节，调用者和读回对象均不能修改存储内容', async () => {
  const { store } = memory();
  const padded = new Uint8Array(CSV.length + 2);
  padded.set(CSV, 1);
  const view = padded.subarray(1, padded.length - 1);
  await store.put({ key: KEY, bytes: view, contentType: 'text/csv' });
  padded.fill(0);
  expect(store.get(KEY)?.bytes).toEqual(CSV);
  store.get(KEY)?.bytes.fill(0);
  expect(store.get(KEY)?.bytes).toEqual(CSV);
});

it('[AC-B1-34d#4] 删除存在或不存在的 key 均成功，其他 app_id 的文件保留', async () => {
  const { store } = memory();
  await store.delete(KEY);
  await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' });
  await store.put({ key: OTHER_KEY, bytes: CSV, contentType: 'text/csv' });
  await store.delete(KEY);
  await store.delete(KEY);
  expect(store.get(KEY)).toBeUndefined();
  expect(store.get(OTHER_KEY)?.bytes).toEqual(CSV);
  await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' });
  expect(store.get(KEY)?.bytes).toEqual(CSV);
});

it.each([
  '',
  '/a.csv',
  'brand_a/',
  'brand_a/id',
  'brand_a/id.txt',
  'brand_a/id.csv/extra',
  '../id.csv',
  'brand_a/../id.csv',
  'brand_a/a/b.csv',
  'brand_a//id.csv',
  'brand_a/..csv',
  'brand_a/a%2fb.csv',
  'brand_a/%2e%2e.csv',
  'brand_a/a\\b.csv',
  'brand_a/id.csv?x=1',
  'brand_a/id.csv#x',
  'brand_a/a b.csv',
  'brand_a/文件.csv',
  'brand_a/id.csv\n',
  'brand_a/id\u0000.csv',
  'BRAND/id.csv',
  'brand-a/id.csv',
  `${'a'.repeat(33)}/id.csv`,
])('[AC-B1-34d#5] put / signedUrl / delete 均拒绝非法 key %j 且不影响已有文件', async (key) => {
  const { store } = memory();
  await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' });
  // Promise wrapper accepts either synchronous validation throws or asynchronous rejection.
  await expect(
    Promise.resolve().then(() => store.put({ key, bytes: CSV, contentType: 'text/csv' })),
  ).rejects.toBeInstanceOf(Error);
  await expect(
    Promise.resolve().then(() => store.signedUrl({ key, expiresAt: new Date(EXPIRES) })),
  ).rejects.toBeInstanceOf(Error);
  await expect(Promise.resolve().then(() => store.delete(key))).rejects.toBeInstanceOf(Error);
  expect(store.get(KEY)?.bytes).toEqual(CSV);
});

it.each(['application/json', 'text/csv; charset=utf-8', '', '__proto__'])(
  '[AC-B1-34d#6] 运行时拒绝非约定 CSV 类型 %j，不能覆盖已有文件',
  async (contentType) => {
    const { store } = memory();
    await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' });
    const bad = { key: KEY, bytes: new Uint8Array(), contentType } as ExportPutInput;
    await expect(Promise.resolve().then(() => store.put(bad))).rejects.toBeInstanceOf(Error);
    expect(store.get(KEY)?.bytes).toEqual(CSV);
  },
);
