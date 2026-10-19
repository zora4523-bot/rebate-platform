// F1-02t (ruling 8 / L16 / L28): the keys the admin dictionary may override and their bundled
// defaults, from contracts/texts.default.json `texts`. Read once per process on first use (as
// home-schema.ts reads contracts/home-schema.json), so a broken contract file answers 50001 on
// the dictionary routes rather than stopping the admin entry.
import { readFileSync } from 'node:fs';

/** Resolves to the repository root from both src/ and dist/ (same depth). */
export const TEXTS_DEFAULT_FILE = new URL(
  '../../../../../../contracts/texts.default.json',
  import.meta.url,
);

/** Only the string entries of an object `texts`; anything else is a broken contract file. */
export function parseDefaultTexts(document: unknown): Readonly<Record<string, string>> {
  const texts =
    typeof document === 'object' && document !== null && !Array.isArray(document)
      ? (document as { texts?: unknown }).texts
      : undefined;
  if (typeof texts !== 'object' || texts === null || Array.isArray(texts)) {
    throw new Error('contracts/texts.default.json: `texts` must be an object');
  }
  const entries = Object.entries(texts as Record<string, unknown>);
  for (const [key, text] of entries) {
    if (typeof text !== 'string') {
      throw new Error(`contracts/texts.default.json: texts.${key} must be a string`);
    }
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

let loaded: Readonly<Record<string, string>> | undefined;

/** The bundled default texts, loaded on first use and shared by the process. */
export function defaultTexts(): Readonly<Record<string, string>> {
  loaded ??= parseDefaultTexts(JSON.parse(readFileSync(TEXTS_DEFAULT_FILE, 'utf8')) as unknown);
  return loaded;
}
