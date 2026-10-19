// Default invariant source of the daily check: db/invariants/ledger/*.sql (a protected,
// append-only directory written by the rule-test author), minus the files listed in
// superseded.json (decision 33 / 34: an array of { file, replaced_by, reason } objects).
import { readdir, readFile } from 'node:fs/promises';
import type {
  LedgerInvariantFile,
  LedgerInvariantSource,
} from '../application/daily-check-types.ts';

/** Resolves to the repository's db/invariants/ledger/ from both src/ and dist/ (same depth). */
export const LEDGER_INVARIANT_DIRECTORY = new URL(
  '../../../../../../db/invariants/ledger/',
  import.meta.url,
);

const MANIFEST = 'superseded.json';

/**
 * File names excluded by superseded.json. A manifest that is not an array of objects with a
 * string `file` throws: a broken list must stop the run, never silently select files.
 */
export function parseSupersededManifest(document: unknown): ReadonlySet<string> {
  if (!Array.isArray(document)) {
    throw new Error(`${MANIFEST}: must be an array of objects`);
  }
  const names = new Set<string>();
  for (const [index, entry] of (document as unknown[]).entries()) {
    const file =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as { file?: unknown }).file
        : undefined;
    if (typeof file !== 'string' || file === '') {
      throw new Error(`${MANIFEST}: entry ${String(index)} must be an object with a string file`);
    }
    names.add(file);
  }
  return names;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function readSuperseded(directory: URL): Promise<ReadonlySet<string>> {
  let text: string;
  try {
    text = await readFile(new URL(MANIFEST, directory), 'utf8');
  } catch (error) {
    if (isMissing(error)) return new Set();
    throw error;
  }
  return parseSupersededManifest(JSON.parse(text) as unknown);
}

/** Every *.sql file of `directory` not listed in its superseded.json (order is the runner's). */
export function directoryInvariantSource(
  directory: URL = LEDGER_INVARIANT_DIRECTORY,
): LedgerInvariantSource {
  return {
    async load(): Promise<readonly LedgerInvariantFile[]> {
      const superseded = await readSuperseded(directory);
      const names = (await readdir(directory)).filter(
        (name) => name.endsWith('.sql') && !superseded.has(name),
      );
      return Promise.all(
        names.map(async (name) => ({
          name,
          sql: await readFile(new URL(name, directory), 'utf8'),
        })),
      );
    },
  };
}
