// Seed of the invite_code sensitive-word scene (BR-INV-01): specs/sensitive-words.invite-code.txt,
// the agent's minimal list until the BR-INV-01 word-bank task replaces it (ruling §9.3 #3). Not
// the marketing banned-word list (specs/banned-words.yaml). Read synchronously each time a filter
// is built (createDefaultInviteCodeFilter); a missing or empty list throws from that call instead
// of letting every candidate through. Nothing here runs at import or at start-up: the wiring task
// (B1-02j) builds the filter once in its provider factory, which then fails the start.
//
// Also compiled by the `test` project: erasable syntax only, `.ts` relative imports, no decorators.
import { readFileSync } from 'node:fs';
import { parseSensitiveWordList } from '../domain/registration.ts';

/** Resolves to the repository root from both src/ and dist/ (same depth). */
export const INVITE_CODE_SENSITIVE_WORDS_FILE = new URL(
  '../../../../../../specs/sensitive-words.invite-code.txt',
  import.meta.url,
);

const WHERE = 'specs/sensitive-words.invite-code.txt';

/** The words of the seed list text; throws when it names no word. */
export function parseInviteCodeSensitiveWords(text: string): readonly string[] {
  const words = parseSensitiveWordList(text);
  if (words.length === 0) throw new Error(`${WHERE}: the list must name at least one word`);
  return words;
}

/** The words of the seed list; throws when the file is missing or names no word. */
export function loadInviteCodeSensitiveWords(
  file: URL = INVITE_CODE_SENSITIVE_WORDS_FILE,
): readonly string[] {
  return parseInviteCodeSensitiveWords(readFileSync(file, 'utf8'));
}
