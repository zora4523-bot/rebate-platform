// NicknameReviewPort implementations (BR-ID-39; task B1-20d §9.3 #6, §9.4 D32).
//
// - local / test / staging: a deterministic review over the seed word list
//   infra/sensitive-words.nickname.txt (one word per line, `#` comments, same format and matcher
//   as the invite-code seed: case-insensitive substring); a missing or empty list throws when the
//   review is built (the start fails).
// - prod: no content-safety adapter yet, so every review answers 'unavailable' (fail-close).
//
// Also compiled by the `test` project: erasable syntax only, `.ts` relative imports, no decorators.
import type { AppEnv } from '../../platform/index.ts';
import type { NicknameReviewPort } from '../ports/nickname-review.ts';

/** The words of the nickname seed list (default: the module's own file); throws when missing or empty. */
export function loadNicknameSensitiveWords(file?: URL): readonly string[] {
  void file;
  throw new Error('NotImplemented: loadNicknameSensitiveWords');
}

/** A review that answers 'hit' when the text contains a word (case-insensitive), else 'pass'. */
export function createLocalNicknameReview(words: readonly string[]): NicknameReviewPort {
  void words;
  throw new Error('NotImplemented: createLocalNicknameReview');
}

/** The review of an environment: the seed-list review outside prod, fail-close in prod. */
export function createNicknameReview(appEnv: AppEnv): NicknameReviewPort {
  void appEnv;
  throw new Error('NotImplemented: createNicknameReview');
}
