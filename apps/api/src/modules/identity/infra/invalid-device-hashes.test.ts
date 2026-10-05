import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  DEVICE_HASH_VECTORS_FILE,
  loadInvalidDeviceHashSeeds,
  parseInvalidHashSeeds,
} from './invalid-device-hashes.ts';

// An independent reading of the specs file (repository root, from this test's location).
const vectors = JSON.parse(
  readFileSync(
    new URL('../../../../../../specs/device-hash.vectors.json', import.meta.url),
    'utf8',
  ),
) as {
  hash_cases: { device_hash: string }[];
  invalid_hash_seeds: { device_hash: string }[];
};

it('[AC-B1-02c#5] loads exactly the invalid_hash_seeds of specs/device-hash.vectors.json', async () => {
  expect(DEVICE_HASH_VECTORS_FILE.pathname.endsWith('/specs/device-hash.vectors.json')).toBe(true);
  const seeds = await loadInvalidDeviceHashSeeds();
  expect([...seeds].sort()).toEqual(
    vectors.invalid_hash_seeds.map((seed) => seed.device_hash).sort(),
  );
  for (const vector of vectors.hash_cases) expect(seeds.has(vector.device_hash)).toBe(false);
});

it('refuses a list that would let invalid hashes through, without echoing a value', () => {
  const secretLooking = 'Z'.repeat(64);
  for (const document of [
    null,
    'text',
    [],
    {},
    { invalid_hash_seeds: [] },
    { invalid_hash_seeds: 'x' },
    { invalid_hash_seeds: [null] },
    { invalid_hash_seeds: [{}] },
    { invalid_hash_seeds: [{ device_hash: secretLooking }] },
    { invalid_hash_seeds: [{ device_hash: 'a'.repeat(63) }] },
  ]) {
    expect(() => parseInvalidHashSeeds(document)).toThrow(/^specs\/device-hash\.vectors\.json: /);
  }
  let message = '';
  try {
    parseInvalidHashSeeds({ invalid_hash_seeds: [{ device_hash: secretLooking }] });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('invalid_hash_seeds[0].device_hash');
  expect(message).not.toContain(secretLooking);
});

it('fails to start when the file is missing', async () => {
  await expect(
    loadInvalidDeviceHashSeeds(new URL('./no-such-file.json', import.meta.url)),
  ).rejects.toThrow();
});
