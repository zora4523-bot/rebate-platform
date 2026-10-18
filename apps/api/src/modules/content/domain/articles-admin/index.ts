// F1-02v §9.2: admin article save checks (04 articles body whitelist and ExternalPage link rules,
// BR-ATTR-29 ①, 08 12_TEXT notice fields and banned words). Pure: word list, link patterns,
// media hosts and config keys come from the caller; callers map a failed result to 20001.
import type { LinkPatternsSpec } from '../../../platform/index.ts';
import { validateArticleBody } from '../article-body/index.ts';
import type { ArticleCategory } from '../articles.ts';
import {
  hasPersonalPlaceholder,
  isUnionHost,
  normalisedHttpsHost,
} from '../pages/validate/external-url.ts';
import { findBannedWords, type BannedWord } from '../text-guard/index.ts';

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

type Plain = Record<string, unknown>;

/** Text blocks whose adjacent text nodes are joined into one banned-word fragment. */
const TEXT_BLOCKS: ReadonlySet<string> = new Set(['paragraph', 'heading']);

interface TextBlock {
  readonly path: string;
  readonly fragments: readonly string[];
}

interface BodyScan {
  readonly linkPaths: string[];
  readonly blocks: TextBlock[];
}

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function join(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

function childrenOf(node: Plain): readonly unknown[] {
  const content = node['content'];
  return Array.isArray(content) ? content : [];
}

/** Only https links are accepted (no in-app routes); union hosts per the caller's switch. */
function hrefRejected(href: string, ctx: ArticleSaveContext): boolean {
  const host = normalisedHttpsHost(href);
  if (host === null) return true;
  if (hasPersonalPlaceholder(href)) return true;
  return ctx.unionHostBlock && isUnionHost(host, ctx.linkPatterns);
}

function checkLinks(node: Plain, path: string, ctx: ArticleSaveContext, out: string[]): void {
  const marks = node['marks'];
  if (!Array.isArray(marks)) return;
  for (const [index, mark] of marks.entries()) {
    if (!isPlainObject(mark) || mark['type'] !== 'link') continue;
    const attrs = mark['attrs'];
    const href = isPlainObject(attrs) ? attrs['href'] : undefined;
    if (typeof href === 'string' && !hrefRejected(href, ctx)) continue;
    out.push(join(path, `marks[${String(index)}].attrs.href`));
  }
}

/** Splits a text block into fragments of adjacent text nodes (a hard break ends a fragment). */
function blockFragments(node: Plain): string[] {
  const fragments: string[] = [];
  let current = '';
  for (const child of childrenOf(node)) {
    if (isPlainObject(child) && child['type'] === 'text' && typeof child['text'] === 'string') {
      current += child['text'];
      continue;
    }
    if (current !== '') fragments.push(current);
    current = '';
  }
  if (current !== '') fragments.push(current);
  return fragments;
}

function scanNode(node: unknown, path: string, ctx: ArticleSaveContext, scan: BodyScan): void {
  if (!isPlainObject(node)) return;
  if (node['type'] === 'text') checkLinks(node, path, ctx, scan.linkPaths);
  if (typeof node['type'] === 'string' && TEXT_BLOCKS.has(node['type'])) {
    scan.blocks.push({ path, fragments: blockFragments(node) });
  }
  for (const [index, child] of childrenOf(node).entries()) {
    scanNode(child, join(path, `content[${String(index)}]`), ctx, scan);
  }
}

/** Body that already passed the whitelist: collects rejected link paths and text blocks. */
function scanBody(body: string, ctx: ArticleSaveContext): BodyScan {
  const scan: BodyScan = { linkPaths: [], blocks: [] };
  scanNode(JSON.parse(body) as unknown, '', ctx, scan);
  return scan;
}

function bannedIn(
  fragments: readonly string[],
  field: 'title' | 'body',
  ctx: ArticleSaveContext,
): string[] {
  return findBannedWords(
    {
      fragments: fragments.map((text) => ({ text })),
      article_field: field,
      article_config_keys: ctx.articleConfigKeys,
    },
    ctx.bannedWords,
    'user_visible',
  );
}

/** F1-02v §9.2: save validation; callers map fields to error 20001. */
export function validateArticleSave(
  input: ArticleSaveInput,
  ctx: ArticleSaveContext,
): ArticleSaveResult {
  const fields: string[] = [];
  const paths: string[] = [];
  const hits = new Set<string>();

  const titleHits = bannedIn([input.title], 'title', ctx);
  if (input.title.trim() === '' || titleHits.length > 0) fields.push('title');
  for (const word of titleHits) hits.add(word);

  const bodyResult = validateArticleBody(input.body, { mediaHosts: ctx.mediaHosts });
  if (!bodyResult.ok) {
    fields.push('body');
    paths.push(bodyResult.path);
  } else {
    const scan = scanBody(input.body, ctx);
    paths.push(...scan.linkPaths);
    const bodyHits = bannedIn(
      scan.blocks.flatMap((block) => block.fragments),
      'body',
      ctx,
    );
    for (const word of bodyHits) hits.add(word);
    if (bodyHits.length > 0) {
      // §9.12: point at each text block that carries a hit.
      for (const block of scan.blocks) {
        if (bannedIn(block.fragments, 'body', ctx).length > 0) paths.push(block.path);
      }
    }
    if (scan.linkPaths.length > 0 || bodyHits.length > 0) fields.push('body');
  }

  if (input.category === 'notice' && !input.notice_closable && input.notice_end_at === null) {
    fields.push('notice_end_at');
  }

  if (fields.length === 0) return { ok: true };
  const words = ctx.bannedWords
    .map((entry) => entry.word)
    .filter((word, index, all) => hits.has(word) && all.indexOf(word) === index);
  return { ok: false, fields: [...fields, ...words], paths };
}

/** F1-02v §9.2: compare with the latest row of the same article id. */
export function nextNoticeContentVersion(
  prev: PreviousNoticeContent | null,
  next: NoticeContent,
): number {
  if (prev === null) return 1;
  const titleChanged = prev.title !== next.title;
  const becameUnclosable = prev.notice_closable && !next.notice_closable;
  return titleChanged || becameUnclosable
    ? prev.notice_content_version + 1
    : prev.notice_content_version;
}
