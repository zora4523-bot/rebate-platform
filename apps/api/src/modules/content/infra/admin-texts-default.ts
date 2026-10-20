// F1-02zd (BR-TEXT-25; contract adminGetDict, W5 / G4): the console dictionary's bundled defaults,
// contracts/texts.admin.default.json `texts`. Read once per process on first use (as
// texts-default.ts reads contracts/texts.default.json), so a broken file answers 50001 on the
// dictionary routes rather than stopping the admin entry. Every key must be
// `admin_dict.<enum>.<code>`, every value a string, and no key may also be a user-side default:
// the dictionary editor works on the union of both files, so a collision would silently pick one.
import { readFileSync } from 'node:fs';
import { splitAdminDictKey } from '../domain/dict/index.ts';
import { defaultTexts } from './texts-default.ts';

/** Resolves to the repository root from both src/ and dist/ (same depth). */
export const ADMIN_TEXTS_DEFAULT_FILE = new URL(
  '../../../../../../contracts/texts.admin.default.json',
  import.meta.url,
);

const FILE = 'contracts/texts.admin.default.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** F1-02zd: validate the admin document and reject collisions with user defaults. */
export function parseAdminDefaultTexts(
  document: unknown,
  publicDefaults: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const texts = isRecord(document) ? document.texts : undefined;
  if (!isRecord(texts)) throw new Error(`${FILE}: \`texts\` must be an object`);
  const entries = Object.entries(texts);
  for (const [key, text] of entries) {
    if (splitAdminDictKey(key) === null) {
      throw new Error(`${FILE}: ${key} is not of the form admin_dict.<enum>.<code>`);
    }
    if (typeof text !== 'string') throw new Error(`${FILE}: texts.${key} must be a string`);
    if (Object.hasOwn(publicDefaults, key)) {
      throw new Error(`${FILE}: ${key} is also a key of contracts/texts.default.json`);
    }
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

let loaded: Readonly<Record<string, string>> | undefined;

/** Read contracts/texts.admin.default.json lazily, never at process bootstrap. */
export function adminDefaultTexts(): Readonly<Record<string, string>> {
  loaded ??= parseAdminDefaultTexts(
    JSON.parse(readFileSync(ADMIN_TEXTS_DEFAULT_FILE, 'utf8')) as unknown,
    defaultTexts(),
  );
  return loaded;
}

/**
 * The keys the dictionary editor may override and their defaults (F1-02zd W5): the user-side
 * file and the console file together. Both loaders run on every call (each reads its file once),
 * so a broken file fails every dictionary route (50001) instead of narrowing the key set. The
 * loaders are passed in (content-admin.module passes defaultTexts and adminDefaultTexts).
 */
export function dictDefaultTexts(
  publicDefaults: () => Readonly<Record<string, string>>,
  adminDefaults: () => Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const user = publicDefaults();
  const admin = adminDefaults();
  for (const key of Object.keys(admin)) {
    if (Object.hasOwn(user, key)) {
      throw new Error(`${FILE}: ${key} is also a key of contracts/texts.default.json`);
    }
  }
  return Object.freeze({ ...user, ...admin });
}
