import type { Schema } from '@couli/contracts-ts';

export type ArticleCategory = Schema<'ArticleCategory'>;
export type ArticleHelpSection = Schema<'ArticleHelpSection'>;

export interface ArticleCursor {
  readonly at: string;
  readonly id: string;
}

/** Published timestamps stay as UTC text so neither responses nor cursors lose microseconds. */
export interface PublishedArticleSummary {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly version: number;
  readonly published_at: string;
  readonly notice_closable: boolean;
  readonly notice_content_version: number;
  readonly notice_end_at: string | null;
  /** Of this (current) version row; null when unset (articles_help_section_category_check). */
  readonly help_section: string | null;
}

export class ArticleCursorError extends Error {
  constructor() {
    super('content: invalid article cursor');
    this.name = 'ArticleCursorError';
  }
}

/** 04 §6.2 / L30: the help_section filter of GET /v1/articles goes with category=help only. */
export class ArticleHelpSectionFilterError extends Error {
  constructor() {
    super('content: help_section filter needs category help');
    this.name = 'ArticleHelpSectionFilterError';
  }
}

/** True when a help_section list filter may be combined with the category. */
export function helpSectionFilterAllowed(
  category: ArticleCategory,
  helpSection: ArticleHelpSection | undefined,
): boolean {
  return helpSection === undefined || category === 'help';
}

/** L30: `help_section` only when set (never null); notices and agreements never carry one. */
export function withHelpSection<T extends object>(
  category: ArticleCategory,
  value: string | null,
  target: T,
): T & { help_section?: ArticleHelpSection } {
  if (value === null || category !== 'help') return target;
  return { ...target, help_section: value as ArticleHelpSection }; // articles_help_section_check
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/;

export function isArticleId(value: string): boolean {
  return value.length === 36 && UUID.test(value);
}

/** Reject impossible calendar dates before passing the cursor to PG's timestamptz cast. */
function isCursorInstant(value: string): boolean {
  if (value.length !== 27) return false;
  const match = INSTANT.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

export function encodeArticleCursor(category: ArticleCategory, cursor: ArticleCursor): string {
  return Buffer.from(JSON.stringify([category, cursor.at, cursor.id]), 'utf8').toString(
    'base64url',
  );
}

export function decodeArticleCursor(cursor: string, category: ArticleCategory): ArticleCursor {
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ArticleCursorError();
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) throw new ArticleCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ArticleCursorError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed[0] !== category ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string' ||
    !isCursorInstant(parsed[1]) ||
    !isArticleId(parsed[2])
  ) {
    throw new ArticleCursorError();
  }
  return { at: parsed[1], id: parsed[2] };
}

/** Notice eligibility is filtered in SQL, before the page limit. */
export function articleSummary(row: PublishedArticleSummary): Schema<'ArticleSummary'> {
  const category = row.category as ArticleCategory; // articles_category_check
  const summary = {
    article_id: row.id,
    title: row.title,
    version: row.version,
    published_at: row.published_at,
  };
  if (category !== 'notice')
    return withHelpSection(category, row.help_section, { ...summary, category });
  return {
    ...summary,
    category,
    notice: {
      item_id: row.id,
      content_version: row.notice_content_version,
      text: row.title,
      target: { route: 'Help', params: { article_id: row.id } },
      closable: row.notice_closable,
      start_at: row.published_at,
      end_at: row.notice_end_at,
    },
  };
}
