// Initial value of config key device.invalid_hashes (BR-ID-09 细则「设备标识的无效值」): the
// `invalid_hash_seeds` of specs/device-hash.vectors.json, read once when the entry starts.
// Appending entries at run time (operations) waits for the configuration module.
import { readFile } from 'node:fs/promises';
import { isWellFormedDeviceHash } from '../domain/device.ts';

/** Resolves to the repository root from both src/ and dist/ (same depth). */
export const DEVICE_HASH_VECTORS_FILE = new URL(
  '../../../../../../specs/device-hash.vectors.json',
  import.meta.url,
);

const WHERE = 'specs/device-hash.vectors.json';

/**
 * The set of seed hashes. Throws when the document is not an object with a non-empty
 * `invalid_hash_seeds` array whose every entry has a well-formed `device_hash`: a broken list
 * must stop the entry instead of letting invalid hashes through.
 */
export function parseInvalidHashSeeds(document: unknown): ReadonlySet<string> {
  const seeds =
    typeof document === 'object' && document !== null
      ? (document as { invalid_hash_seeds?: unknown }).invalid_hash_seeds
      : undefined;
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new Error(`${WHERE}: invalid_hash_seeds must be a non-empty array`);
  }
  const hashes = new Set<string>();
  for (const [index, seed] of seeds.entries()) {
    const hash =
      typeof seed === 'object' && seed !== null
        ? (seed as { device_hash?: unknown }).device_hash
        : undefined;
    if (!isWellFormedDeviceHash(hash)) {
      throw new Error(
        `${WHERE}: invalid_hash_seeds[${String(index)}].device_hash must be 64 lowercase hex characters`,
      );
    }
    hashes.add(hash);
  }
  return hashes;
}

export async function loadInvalidDeviceHashSeeds(
  file: URL = DEVICE_HASH_VECTORS_FILE,
): Promise<ReadonlySet<string>> {
  return parseInvalidHashSeeds(JSON.parse(await readFile(file, 'utf8')) as unknown);
}
