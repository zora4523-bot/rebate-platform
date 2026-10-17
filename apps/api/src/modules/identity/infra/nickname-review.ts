// NicknameReviewPort implementations (BR-ID-39; task B1-20d §9.3 #6, §9.4 D32).
//
// - local / test / staging: a deterministic review over the seed word list
//   infra/sensitive-words.nickname.txt (one word per line, `#` comments, same format and matcher
//   as the invite-code seed: case-insensitive substring); a missing or empty list throws when the
//   review is built (the start fails).
// - prod: no content-safety adapter yet, so every review answers 'unavailable' (fail-close).
//
// Also compiled by the `test` project: erasable syntax only, `.ts` relative imports, no decorators.
import { readFileSync } from 'node:fs';
import type { AppEnv } from '../../platform/index.ts';
import { createSensitiveWordMatcher, parseSensitiveWordList } from '../domain/registration.ts';
import type { NicknameReviewPort } from '../ports/nickname-review.ts';

/** The words of the nickname seed list (default: the module's own file); throws when missing or empty. */
export function loadNicknameSensitiveWords(
  // tsc does not copy data files: resolve the source asset from both src/ and dist/.
  file = new URL(
    '../../../../src/modules/identity/infra/sensitive-words.nickname.txt',
    import.meta.url,
  ),
): readonly string[] {
  const words = parseSensitiveWordList(readFileSync(file, 'utf8'));
  if (words.length === 0) {
    throw new Error('identity: nickname sensitive-word list must name at least one word');
  }
  return words;
}

/** A review that answers 'hit' when the text contains a word (case-insensitive), else 'pass'. */
export function createLocalNicknameReview(words: readonly string[]): NicknameReviewPort {
  if (words.length === 0 || words.every((word) => word.trim().length === 0)) {
    throw new Error('identity: nickname sensitive-word list must name at least one word');
  }
  const matches = createSensitiveWordMatcher(words);
  return { review: ({ text }) => Promise.resolve(matches(text) ? 'hit' : 'pass') };
}

/** The review of an environment: the seed-list review outside prod, fail-close in prod. */
export function createNicknameReview(appEnv: AppEnv): NicknameReviewPort {
  if (appEnv === 'prod') {
    // TODO(规划/11 §6): 昵称审核接阿里云 — blocked on B3-06b 适配器提升到 platform 与负责人提供阿里云 Key
    return { review: () => Promise.resolve('unavailable') };
  }
  return createLocalNicknameReview(loadNicknameSensitiveWords());
}
