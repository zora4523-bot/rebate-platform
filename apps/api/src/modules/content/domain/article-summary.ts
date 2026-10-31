/** Longest list summary, in Unicode code points (contract ArticleListSummaryText maxLength). */
export const ARTICLE_SUMMARY_MAX = 80;

/** Deeper documents are not searched (stored bodies are far shallower; keeps recursion bounded). */
const MAX_DEPTH = 64;

/** Whitespace runs inside a paragraph (incl. hardBreak, newlines, U+3000) become one space. */
const WHITESPACE = /\s+/gu;

function nodeOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Inline text of a paragraph: text nodes in order, hardBreak as a space; marks ignored. */
function inlineText(node: Record<string, unknown>, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return;
  if (node['type'] === 'text') {
    if (typeof node['text'] === 'string') out.push(node['text']);
    return;
  }
  if (node['type'] === 'hardBreak') {
    out.push(' ');
    return;
  }
  const content = node['content'];
  if (!Array.isArray(content)) return;
  for (const child of content) {
    const inner = nodeOf(child);
    if (inner !== undefined) inlineText(inner, depth + 1, out);
  }
}

/** Plain text of a paragraph, whitespace collapsed and trimmed, well-formed UTF-16. */
function paragraphText(node: Record<string, unknown>, depth: number): string {
  const parts: string[] = [];
  inlineText(node, depth, parts);
  return parts.join('').toWellFormed().replace(WHITESPACE, ' ').trim();
}

/**
 * First non-empty `paragraph` in document order (§9.5 ①): top level or nested in lists, quotes and
 * other blocks; headings are not paragraphs and are skipped whole.
 */
function firstParagraph(content: readonly unknown[], depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  for (const child of content) {
    const node = nodeOf(child);
    if (node === undefined || node['type'] === 'heading') continue;
    if (node['type'] === 'paragraph') {
      const value = paragraphText(node, depth + 1);
      if (value !== '') return value;
      continue;
    }
    const inner = node['content'];
    if (Array.isArray(inner)) {
      const found = firstParagraph(inner, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** First `max` Unicode code points (§9.5 ③: never splits a surrogate pair). */
export function firstCodePoints(value: string, max: number): string {
  let out = '';
  let count = 0;
  for (const point of value) {
    if (count === max) break;
    out += point;
    count += 1;
  }
  return out;
}

/**
 * 01 §4.2 Help / 04 §6.2 summary (CT-26a, W-25): the list summary of an article version, derived
 * from its stored body — the plain text of the first non-empty text paragraph of the tiptap
 * document (images, dividers, empty and whitespace-only paragraphs skipped; marks and links give
 * their text only), cut to its first 80 Unicode code points. Undefined when the body has no text
 * paragraph or is not a tiptap JSON document; never throws.
 */
export function articleListSummary(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const root = nodeOf(parsed);
  if (root === undefined || root['type'] !== 'doc' || !Array.isArray(root['content'])) {
    return undefined;
  }
  const text = firstParagraph(root['content'], 0);
  // The text starts with a non-space, so the cut stays non-empty after trimming its end.
  return text === undefined ? undefined : firstCodePoints(text, ARTICLE_SUMMARY_MAX).trimEnd();
}
