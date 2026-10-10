import { expect, it } from 'vitest';
import {
  createMediaStore,
  mediaUrlOf,
  MemoryMediaStore,
  MediaStoreUnavailableError,
} from '../../../../apps/api/src/modules/platform/media/index.ts';
import { BASE_URL, SVG, PNG, digest, memoryLogger } from './kit.ts';
import { expectRequestFailure } from './error-response.ts';

it.each([
  { bytes: SVG, contentType: 'image/svg+xml', format: 'svg' },
  { bytes: PNG, contentType: 'image/png', format: 'png' },
] as const)(
  '[AC-F1-06z#6] $format 写入后能读回原字节，地址与读接口计算一致',
  async ({ bytes, contentType, format }) => {
    const store = new MemoryMediaStore(`${BASE_URL}///`);
    const sha256 = digest(bytes);
    expect(store.get(sha256)).toBeUndefined();
    const result = await store.put({ sha256, bytes, contentType });
    expect(result).toEqual({ url: `${BASE_URL}/${sha256}.${format}` });
    expect(result.url).toBe(mediaUrlOf(`${BASE_URL}///`, sha256, format));
    expect(store.get(sha256)).toEqual(bytes);
  },
);

it('[AC-F1-06z#7] 同一摘要顺序和并发重复写入均幂等，其他内容独立保存', async () => {
  const store = new MemoryMediaStore(BASE_URL);
  const input = { sha256: digest(SVG), bytes: SVG, contentType: 'image/svg+xml' as const };
  const first = await store.put(input);
  expect(await store.put({ ...input, bytes: SVG.slice() })).toEqual(first);
  const repeated = await Promise.all(Array.from({ length: 8 }, () => store.put(input)));
  expect(repeated).toEqual(Array.from({ length: 8 }, () => first));
  const other = await store.put({ sha256: digest(PNG), bytes: PNG, contentType: 'image/png' });
  expect(other.url).not.toBe(first.url);
  expect(store.get(input.sha256)).toEqual(SVG);
  expect(store.get(digest(PNG))).toEqual(PNG);
});

it('[AC-F1-06z#8] 拒绝摘要与实际字节不符，失败不能插入或覆盖已存内容', async () => {
  const store = new MemoryMediaStore(BASE_URL);
  const sha256 = digest(SVG);
  const invalid = { sha256, bytes: PNG, contentType: 'image/png' as const };
  await expect(store.put(invalid)).rejects.toBeInstanceOf(Error);
  expect(store.get(sha256)).toBeUndefined();
  const valid = { sha256, bytes: SVG, contentType: 'image/svg+xml' as const };
  const first = await store.put(valid);
  await expect(store.put(invalid)).rejects.toBeInstanceOf(Error);
  expect(store.get(sha256)).toEqual(SVG);
  expect(await store.put(valid)).toEqual(first);
});

it('[AC-F1-06z#9] 摘要只接受小写六十四位十六进制', async () => {
  const store = new MemoryMediaStore(BASE_URL);
  const sha256 = digest(SVG);
  for (const invalid of [
    '',
    sha256.toUpperCase(),
    sha256.slice(1),
    `${sha256}0`,
    `g${sha256.slice(1)}`,
    ` ${sha256}`,
    `${sha256}\n`,
    `../${sha256}`,
  ]) {
    await expect(
      store.put({ sha256: invalid, bytes: SVG, contentType: 'image/svg+xml' }),
    ).rejects.toBeInstanceOf(Error);
    expect(store.get(invalid)).toBeUndefined();
  }
  expect(await store.put({ sha256, bytes: SVG, contentType: 'image/svg+xml' })).toEqual({
    url: `${BASE_URL}/${sha256}.svg`,
  });
});

it('[AC-F1-06z#10] SHA-256 使用 Uint8Array 视图内的字节，不包含底层缓冲区前后缀', async () => {
  const store = new MemoryMediaStore(BASE_URL);
  const padded = new Uint8Array(SVG.length + 2);
  padded.set(SVG, 1);
  const view = padded.subarray(1, padded.length - 1);
  const sha256 = digest(SVG);
  expect(await store.put({ sha256, bytes: view, contentType: 'image/svg+xml' })).toEqual({
    url: `${BASE_URL}/${sha256}.svg`,
  });
  expect(store.get(sha256)).toEqual(SVG);
});

it.each(['local', 'test'] as const)(
  '[AC-F1-06z#11] %s 选择可写可取回的内存替身',
  async (appEnv) => {
    const store = createMediaStore(appEnv, BASE_URL, memoryLogger(appEnv).logger);
    expect(store).toBeInstanceOf(MemoryMediaStore);
    const sha256 = digest(SVG);
    expect(await store.put({ sha256, bytes: SVG, contentType: 'image/svg+xml' })).toEqual({
      url: `${BASE_URL}/${sha256}.svg`,
    });
    expect((store as MemoryMediaStore).get(sha256)).toEqual(SVG);
  },
);

it.each(['staging', 'prod'] as const)(
  '[AC-F1-06z#12] %s 未接适配器可构造，但每次 put 抛出映射为 50001 的约定错误',
  async (appEnv) => {
    const { logger, lines } = memoryLogger(appEnv);
    const store = createMediaStore(appEnv, BASE_URL, logger);
    expect(store).not.toBeInstanceOf(MemoryMediaStore);
    for (const bytes of [SVG, SVG, PNG]) {
      const input = { sha256: digest(bytes), bytes, contentType: 'image/png' as const };
      await expect(store.put(input)).rejects.toBeInstanceOf(MediaStoreUnavailableError);
      await expectRequestFailure(() => store.put(input), logger);
    }
    const logs = lines.join('');
    expect(logs).not.toContain('media-private-marker');
    expect(logs).not.toContain(Buffer.from(SVG).toString('base64'));
    expect(logs).not.toContain(Buffer.from(SVG).toString('hex'));
    expect(logs).not.toContain(Array.from(SVG).join(','));
  },
);
