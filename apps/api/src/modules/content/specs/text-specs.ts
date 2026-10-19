// Runtime view of the generated text specification snapshots (F1-02t; L28 / L50): the banned
// word list (BR-TEXT-13) and the fund term key list (BR-TEXT-12), shared with F1-02w. YAML is
// never read at run time; regenerate with scripts/generate-text-specs.ts.
import type { BannedWord, FundTermKeys } from '../domain/text-guard/index.ts';
import { BANNED_WORDS } from './banned-words.gen.ts';
import { FUND_TERM_KEYS } from './fund-term-keys.gen.ts';

/** specs/banned-words.yaml `words`, in file order. */
export function getBannedWords(): readonly BannedWord[] {
  return BANNED_WORDS.words;
}

/** specs/fund-term-keys.yaml as a whole. */
export function getFundTermKeys(): FundTermKeys {
  return FUND_TERM_KEYS;
}
