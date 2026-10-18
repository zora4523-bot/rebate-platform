/**
 * Whitelist pass over an article body (tiptap / ProseMirror document JSON, F1-03a). The result
 * holds only whitelisted node and mark types and only the attributes this renderer declares, so
 * nothing from the stored document reaches the DOM unchecked: unknown nodes are dropped with their
 * whole subtree, unknown marks are dropped, links keep only absolute https addresses and images
 * only sources on the allowed media origin.
 */

/** Container nodes and the node types their children may have after the pass. */
const BLOCK_CONTAINERS = new Set(['doc', 'blockquote', 'listItem']);
const LISTS = new Set(['bulletList', 'orderedList']);
const TEXT_BLOCKS = new Set(['paragraph', 'heading']);
const LEAF_BLOCKS = new Set(['horizontalRule', 'image']);
const HEADING_LEVELS = new Set([1, 2, 3]);
/** Deeper nesting than any rule article needs; anything below it is dropped. */
const MAX_DEPTH = 32;

type Json = Record<string, unknown>;

/** A mark of the whitelisted document (tiptap JSON shape). */
export type ArticleMark = { type: 'bold' | 'italic' } | { type: 'link'; attrs: { href: string } };

/** A node of the whitelisted document (tiptap JSON shape), as produced by the pass below. */
export type ArticleNode = {
  type: string;
  attrs?: Readonly<Record<string, string | number>>;
  content?: ArticleNode[];
  marks?: ArticleMark[];
  text?: string;
};

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function attrsOf(node: Json): Json {
  return isObject(node['attrs']) ? node['attrs'] : {};
}

/** Absolute https address without credentials, normalised by the URL parser; otherwise null. */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  return url.href;
}

/**
 * The configured media origin, only when it is exactly an https origin (scheme, host and optional
 * port, at most a trailing slash); anything else allows no image at all.
 */
export function normalizeOrigin(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  const href = safeHttpsUrl(value);
  if (href === null) return null;
  const { origin } = new URL(href);
  return value === origin || value === `${origin}/` ? origin : null;
}

/** The usable media origins of a configuration list; unusable entries are left out. */
export function normalizeOrigins(values: readonly string[]): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values) {
    const origin = normalizeOrigin(value);
    if (origin !== null) origins.add(origin);
  }
  return origins;
}

/** Image source on exactly one of the allowed origins (scheme, host and port); otherwise null. */
export function safeImageUrl(value: unknown, origins: ReadonlySet<string>): string | null {
  if (origins.size === 0) return null;
  const href = safeHttpsUrl(value);
  return href !== null && origins.has(new URL(href).origin) ? href : null;
}

function sanitizeMarks(value: unknown): ArticleNode['marks'] {
  if (!Array.isArray(value)) return undefined;
  const marks: ArticleMark[] = [];
  const seen = new Set<string>();
  for (const mark of value) {
    if (!isObject(mark) || typeof mark['type'] !== 'string' || seen.has(mark['type'])) continue;
    const type = mark['type'];
    if (type === 'bold' || type === 'italic') {
      marks.push({ type });
    } else if (type === 'link') {
      const href = safeHttpsUrl(attrsOf(mark)['href']);
      // A link to anything else stays as plain text.
      if (href === null) continue;
      marks.push({ type, attrs: { href } });
    } else {
      continue;
    }
    seen.add(type);
  }
  return marks.length > 0 ? marks : undefined;
}

function sanitizeImage(node: Json, origins: ReadonlySet<string>): ArticleNode | null {
  const attrs = attrsOf(node);
  const src = safeImageUrl(attrs['src'], origins);
  if (src === null) return null;
  const alt = typeof attrs['alt'] === 'string' ? attrs['alt'] : '';
  return { type: 'image', attrs: { src, alt } };
}

/** Text, hard breaks and (inline-configured) images inside a paragraph or heading. */
function sanitizeInline(value: unknown, origins: ReadonlySet<string>): ArticleNode[] {
  if (!Array.isArray(value)) return [];
  const result: ArticleNode[] = [];
  for (const node of value) {
    if (!isObject(node)) continue;
    if (node['type'] === 'text') {
      const text = node['text'];
      // ProseMirror rejects empty text nodes.
      if (typeof text !== 'string' || text === '') continue;
      const marks = sanitizeMarks(node['marks']);
      result.push(marks === undefined ? { type: 'text', text } : { type: 'text', text, marks });
    } else if (node['type'] === 'hardBreak') {
      result.push({ type: 'hardBreak' });
    } else if (node['type'] === 'image') {
      const image = sanitizeImage(node, origins);
      if (image !== null) result.push(image);
    }
  }
  return result;
}

function sanitizeBlocks(
  value: unknown,
  origins: ReadonlySet<string>,
  depth: number,
): ArticleNode[] {
  if (!Array.isArray(value) || depth > MAX_DEPTH) return [];
  const result: ArticleNode[] = [];
  for (const node of value) {
    const clean = isObject(node) ? sanitizeBlock(node, origins, depth) : null;
    if (clean !== null) result.push(clean);
  }
  return result;
}

function sanitizeBlock(
  node: Json,
  origins: ReadonlySet<string>,
  depth: number,
): ArticleNode | null {
  const type = node['type'];
  if (typeof type !== 'string') return null;
  if (TEXT_BLOCKS.has(type)) {
    const content = sanitizeInline(node['content'], origins);
    if (type === 'paragraph') return { type, content };
    const level = attrsOf(node)['level'];
    // Heading levels outside 1-3 are not on the whitelist; the node is dropped.
    if (typeof level !== 'number' || !HEADING_LEVELS.has(level)) return null;
    return { type, attrs: { level }, content };
  }
  if (LEAF_BLOCKS.has(type)) {
    return type === 'horizontalRule' ? { type } : sanitizeImage(node, origins);
  }
  if (LISTS.has(type)) {
    const items = sanitizeBlocks(node['content'], origins, depth + 1).filter(
      (child) => child.type === 'listItem',
    );
    return items.length > 0 ? { type, content: items } : null;
  }
  if (BLOCK_CONTAINERS.has(type) && type !== 'doc') {
    const content = sanitizeBlocks(node['content'], origins, depth + 1).filter(
      (child) => child.type !== 'listItem',
    );
    return content.length > 0 ? { type, content } : null;
  }
  // doc below the root, text or hardBreak at block level, and every unknown type.
  return null;
}

/**
 * Parses and whitelists an article body. Returns null when the string is not JSON or not a
 * document (`type: "doc"` with an optional content array); the caller shows its error state.
 */
export function sanitizeArticleBody(
  body: string,
  mediaOrigins: ReadonlySet<string>,
): ArticleNode | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed['type'] !== 'doc') return null;
  const content = parsed['content'];
  if (content !== undefined && !Array.isArray(content)) return null;
  return {
    type: 'doc',
    content: sanitizeBlocks(content ?? [], mediaOrigins, 1).filter(
      (child) => child.type !== 'listItem',
    ),
  };
}
