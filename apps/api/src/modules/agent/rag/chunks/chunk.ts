// B3-08i: cutting one published article into rule chunks (02 §9.2 规则 RAG; 08 BR-AI-07 T6
// rule_ref excerpt ≤ 200 字; no vectors, D10-194). Pure. The body is the stored tiptap JSON
// (F1-02m); every textblock (paragraph, heading, also inside lists and quotes) is one paragraph and
// a chunk never spans two paragraphs. A paragraph over 200 characters (Unicode code points, as
// char_length in agent_rule_chunks_text_check) is cut again at 。 or a line break (hardBreak), and
// a piece still over 200 is cut hard. Chunk title is the article title; seq counts from 0.

/** What a chunk is cut from: the article's title and stored body. */
export interface RuleChunkSource {
  readonly title: string;
  readonly body: string;
}

export interface RuleChunkDraft {
  readonly seq: number;
  readonly title: string;
  readonly text: string;
}

/** rule_chunks_text_check and the rule_ref excerpt limit, in characters (code points). */
const MAX_CHARS = 200;
/** Tiptap nodes whose inline content is one paragraph. */
const TEXTBLOCKS: ReadonlySet<string> = new Set(['paragraph', 'heading', 'codeBlock']);

export function chunkArticle(article: RuleChunkSource): readonly RuleChunkDraft[] {
  const drafts: RuleChunkDraft[] = [];
  for (const paragraph of paragraphsOf(article.body)) {
    for (const text of cutParagraph(paragraph)) {
      drafts.push({ seq: drafts.length, title: article.title, text });
    }
  }
  return drafts;
}

/** The raw text of every textblock in document order; a hardBreak is a line break. */
function paragraphsOf(body: string): string[] {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    root = undefined;
  }
  if (!isNode(root)) {
    // Not a tiptap document (F1-02m stores one): read it as plain text, one paragraph per line.
    return body.split('\n');
  }
  const paragraphs: string[] = [];
  collect(root, paragraphs);
  return paragraphs;
}

interface TiptapNode {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly content?: unknown;
}

function isNode(value: unknown): value is TiptapNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childrenOf(node: TiptapNode): TiptapNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function collect(node: TiptapNode, paragraphs: string[]): void {
  if (typeof node.type === 'string' && TEXTBLOCKS.has(node.type)) {
    paragraphs.push(inlineText(node));
    return;
  }
  for (const child of childrenOf(node)) collect(child, paragraphs);
}

function inlineText(node: TiptapNode): string {
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (node.type === 'hardBreak') return '\n';
  return childrenOf(node)
    .map((child) => inlineText(child))
    .join('');
}

function length(value: string): number {
  return Array.from(value).length;
}

/**
 * A paragraph within the limit is one chunk as is. A longer one is cut at 。, a sentence still over
 * the limit at line breaks, a line still over the limit hard every MAX_CHARS characters; the pieces
 * are then packed greedily in order into chunks within the limit. Whitespace at chunk ends is
 * dropped and a chunk of only whitespace is left out.
 */
function cutParagraph(paragraph: string): string[] {
  const whole = paragraph.trim();
  if (whole === '') return [];
  if (length(whole) <= MAX_CHARS) return [whole];
  const pieces: string[] = [];
  for (const sentence of splitAfter(whole, '。')) {
    if (length(sentence) <= MAX_CHARS) {
      pieces.push(sentence);
      continue;
    }
    for (const line of splitAfter(sentence, '\n')) {
      if (length(line) <= MAX_CHARS) pieces.push(line);
      else pieces.push(...hardCut(line));
    }
  }
  const chunks: string[] = [];
  let current = '';
  let currentLength = 0;
  for (const piece of pieces) {
    const pieceLength = length(piece);
    if (currentLength + pieceLength > MAX_CHARS) {
      chunks.push(current);
      current = '';
      currentLength = 0;
    }
    current += piece;
    currentLength += pieceLength;
  }
  chunks.push(current);
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk !== '');
}

/** Pieces that each end with the separator (the last one may not); joined they are the value. */
function splitAfter(value: string, separator: string): string[] {
  const pieces: string[] = [];
  let from = 0;
  for (;;) {
    const at = value.indexOf(separator, from);
    if (at < 0) break;
    pieces.push(value.slice(from, at + separator.length));
    from = at + separator.length;
  }
  if (from < value.length) pieces.push(value.slice(from));
  return pieces;
}

/** Cuts every MAX_CHARS code points, never inside a surrogate pair. */
function hardCut(value: string): string[] {
  const chars = Array.from(value);
  const pieces: string[] = [];
  for (let at = 0; at < chars.length; at += MAX_CHARS) {
    pieces.push(chars.slice(at, at + MAX_CHARS).join(''));
  }
  return pieces;
}
