import { shellTexts } from '../texts/shell.ts';

interface TextDictionary {
  texts: Record<string, string>;
  fallbacks: Record<string, string>;
}

// The bundled default dictionary (contracts/texts.default.json, BR-TEXT-12). A Vite glob keeps the
// JSON outside this package's TypeScript project while Vite and Vitest still inline it.
const loaded = import.meta.glob<TextDictionary>('../../../../contracts/texts.default.json', {
  eager: true,
  import: 'default',
});
const dictionary: TextDictionary = Object.values(loaded)[0] ?? { texts: {}, fallbacks: {} };

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

function own(record: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Resolve contract texts, contract fallbacks, then the shell's registered local dictionary.
 * A contract text whose placeholder has no value uses the contract fallback for that key
 * (「变量缺失时」); an unknown key renders as an empty string, never as the key itself.
 */
export function t(key: string, params: Readonly<Record<string, string>> = {}): string {
  const text = own(dictionary.texts, key);
  if (text !== undefined) {
    let missing = false;
    const filled = text.replace(PLACEHOLDER, (whole, name: string) => {
      const value = own(params, name);
      if (value === undefined) {
        missing = true;
        return whole;
      }
      return value;
    });
    if (!missing) return filled;
    return own(dictionary.fallbacks, key) ?? filled;
  }
  return own(dictionary.fallbacks, key) ?? own(shellTexts, key) ?? '';
}
