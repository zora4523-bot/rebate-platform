import { expect, it } from 'vitest';
import { createRootLogger } from '../../platform/index.ts';
import {
  HjyIgnoreEvidenceStore,
  HjyIgnoreEvidenceStoreUnavailableError,
} from './hjy-ignore-evidence-store.ts';

const KEY =
  'union-pids/0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6d01/0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6d09.png';
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x75, 0x6e, 0x69, 0x74]);

function logger() {
  const lines: string[] = [];
  const root = createRootLogger(
    { level: 'trace', entry: 'admin', appEnv: 'staging' },
    { write: (line: string) => void lines.push(line) },
  );
  return { root, lines };
}

it('[AC-B1-22h] local / test keep a copy of the bytes under the key', async () => {
  const store = new HjyIgnoreEvidenceStore({ appEnv: 'test', logger: logger().root });
  const bytes = BYTES.slice();
  await store.put({ key: KEY, bytes, contentType: 'image/png' });
  bytes[0] = 0;
  expect(store.get(KEY)).toEqual({ bytes: BYTES, contentType: 'image/png' });
  expect(store.get(KEY.replace('.png', '.jpg'))).toBeUndefined();
});

it.each(['staging', 'prod'] as const)(
  '[AC-B1-22h] %s fails closed with a warn event carrying the key only',
  async (appEnv) => {
    const { root, lines } = logger();
    const store = new HjyIgnoreEvidenceStore({ appEnv, logger: root });
    await expect(
      store.put({ key: KEY, bytes: BYTES, contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(HjyIgnoreEvidenceStoreUnavailableError);
    expect(store.get(KEY)).toBeUndefined();
    const logs = lines.join('');
    expect(logs).toContain('hjy_evidence_store_unavailable');
    expect(logs).toContain(KEY);
  },
);

it('[AC-B1-22h] a malformed key or content type is refused before anything is stored', async () => {
  const store = new HjyIgnoreEvidenceStore({ appEnv: 'local', logger: logger().root });
  await expect(
    store.put({ key: 'https://oss.example.invalid/x.png', bytes: BYTES, contentType: 'image/png' }),
  ).rejects.toBeInstanceOf(TypeError);
  await expect(
    store.put({ key: KEY, bytes: BYTES, contentType: 'image/gif' as unknown as 'image/png' }),
  ).rejects.toBeInstanceOf(TypeError);
  expect(store.get(KEY)).toBeUndefined();
});
