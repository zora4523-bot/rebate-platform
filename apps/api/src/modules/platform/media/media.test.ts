import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createRootLogger } from '../logging/index.ts';
import {
  createMediaStore,
  MEDIA_STORE,
  mediaUrlOf,
  MediaStoreUnavailableError,
  MemoryMediaStore,
} from './index.ts';

const BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">unit-marker</svg>');
const SHA = createHash('sha256').update(BYTES).digest('hex');

function logger() {
  const lines: string[] = [];
  const root = createRootLogger(
    { level: 'trace', entry: 'admin', appEnv: 'staging' },
    { write: (line: string) => void lines.push(line) },
  );
  return { root, lines };
}

it('[AC-F1-06z] MEDIA_STORE is a symbol token', () => {
  expect(typeof MEDIA_STORE).toBe('symbol');
});

it('[AC-F1-06z] mediaUrlOf strips trailing slashes and validates its inputs', () => {
  expect(mediaUrlOf('https://m.example.invalid/p//', SHA, 'png')).toBe(
    `https://m.example.invalid/p/${SHA}.png`,
  );
  expect(() => mediaUrlOf(undefined, SHA, 'svg')).toThrow(MediaStoreUnavailableError);
  expect(() => mediaUrlOf('', SHA, 'svg')).toThrow(MediaStoreUnavailableError);
  expect(() => mediaUrlOf('https://m.example.invalid', SHA.toUpperCase(), 'svg')).toThrow(
    TypeError,
  );
  expect(() => mediaUrlOf('https://m.example.invalid', SHA, 'gif' as unknown as 'svg')).toThrow(
    TypeError,
  );
});

it('[AC-F1-06z] memory store rejects asynchronously on an unknown content type', async () => {
  const store = new MemoryMediaStore('https://m.example.invalid');
  await expect(
    store.put({ sha256: SHA, bytes: BYTES, contentType: 'image/gif' as unknown as 'image/png' }),
  ).rejects.toBeInstanceOf(TypeError);
  expect(store.get(SHA)).toBeUndefined();
});

it('[AC-F1-06z] stored bytes are copies the caller cannot mutate', async () => {
  const store = new MemoryMediaStore('https://m.example.invalid');
  const bytes = BYTES.slice();
  await store.put({ sha256: SHA, bytes, contentType: 'image/svg+xml' });
  bytes[0] = 0;
  const first = store.get(SHA);
  expect(first).toEqual(BYTES);
  if (first !== undefined) first[0] = 0;
  expect(store.get(SHA)).toEqual(BYTES);
});

it('[AC-F1-06z] local without a base URL falls back to the reserved default', async () => {
  const store = createMediaStore('local', undefined, logger().root);
  expect(await store.put({ sha256: SHA, bytes: BYTES, contentType: 'image/svg+xml' })).toEqual({
    url: `https://media.local.invalid/${SHA}.svg`,
  });
});

it('[AC-F1-06z] staging store logs the digest only and checks input before refusing', async () => {
  const { root, lines } = logger();
  const store = createMediaStore('staging', 'https://m.example.invalid', root);
  await expect(
    store.put({ sha256: SHA, bytes: BYTES, contentType: 'image/svg+xml' }),
  ).rejects.toBeInstanceOf(MediaStoreUnavailableError);
  const wrong = SHA.replace(/^./, SHA.startsWith('0') ? '1' : '0');
  await expect(
    store.put({ sha256: wrong, bytes: BYTES, contentType: 'image/svg+xml' }),
  ).rejects.not.toBeInstanceOf(MediaStoreUnavailableError);
  const logs = lines.join('');
  expect(logs).toContain(SHA);
  expect(logs).not.toContain('unit-marker');
  expect(lines).toHaveLength(1);
});
