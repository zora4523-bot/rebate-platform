import type { LinkPatternsSpec } from '../../../platform/index.ts';
import type { ArticleCategory } from '../articles.ts';
import type { BannedWord } from '../text-guard/index.ts';

export interface ArticleSaveInput {
  readonly category: ArticleCategory;
  readonly title: string;
  readonly body: string;
  readonly notice_closable: boolean;
  readonly notice_end_at: Date | null;
}

export interface ArticleSaveContext {
  readonly mediaHosts: readonly string[];
  readonly unionHostBlock: boolean;
  readonly linkPatterns: LinkPatternsSpec;
  readonly bannedWords: readonly BannedWord[];
  readonly articleConfigKeys: readonly string[];
}

export type ArticleSaveResult = { ok: true } | { ok: false; fields: string[]; paths: string[] };

export interface NoticeContent {
  readonly title: string;
  readonly notice_closable: boolean;
}

export interface PreviousNoticeContent extends NoticeContent {
  readonly notice_content_version: number;
}

/** F1-02v §9.2: save validation; callers map fields to error 20001. */
export function validateArticleSave(
  input: ArticleSaveInput,
  ctx: ArticleSaveContext,
): ArticleSaveResult {
  void input;
  void ctx;
  throw new Error('NotImplemented: validateArticleSave');
}

/** F1-02v §9.2: compare with the latest row of the same article id. */
export function nextNoticeContentVersion(
  prev: PreviousNoticeContent | null,
  next: NoticeContent,
): number {
  void prev;
  void next;
  throw new Error('NotImplemented: nextNoticeContentVersion');
}
