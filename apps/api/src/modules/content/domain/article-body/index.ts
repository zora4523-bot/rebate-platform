// F1-02m §9.2: shared article / agreement body whitelist (04 articles / agreements: tiptap JSON,
// no raw HTML / script / iframe; images only on the media CDN) and the stored-text digest
// (BR-WDR-31). Pure: media hosts come from the caller's configuration.
import { createHash } from 'node:crypto';
import { normalisedHttpsHost } from '../pages/validate/external-url.ts';

export interface ArticleBodyOptions {
  readonly mediaHosts: readonly string[];
}

export type ArticleBodyResult = { ok: true } | { ok: false; fields: ['body']; path: string };

/** Limits from F1-02m L10: JS string length of the stored body and node nesting levels. */
const MAX_BODY_LENGTH = 200_000;
const MAX_NODE_DEPTH = 20;

type Plain = Record<string, unknown>;
type AttrCheck = (value: unknown, hosts: ReadonlySet<string>) => boolean;

interface NodeSpec {
  /** Whether the node may carry child nodes in `content`. */
  readonly container: boolean;
  /** Allowed attributes; `required` ones must be present. */
  readonly attrs: Readonly<Record<string, AttrCheck>>;
  readonly required: readonly string[];
}

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Plain, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

const nullableString: AttrCheck = (value) => value === null || typeof value === 'string';
const headingLevel: AttrCheck = (value) => value === 1 || value === 2 || value === 3;
const listStart: AttrCheck = (value) => isPositiveInteger(value);
const mediaSrc: AttrCheck = (value, hosts) => {
  if (typeof value !== 'string') return false;
  const host = normalisedHttpsHost(value);
  return host !== null && hosts.has(host);
};
const nonEmptyString: AttrCheck = (value) => typeof value === 'string' && value !== '';

const CONTAINER: NodeSpec = { container: true, attrs: {}, required: [] };
const LEAF: NodeSpec = { container: false, attrs: {}, required: [] };

/** Node types matched exactly; `doc` is accepted only at the root. */
const NODE_SPECS: ReadonlyMap<string, NodeSpec> = new Map<string, NodeSpec>([
  ['doc', CONTAINER],
  ['paragraph', CONTAINER],
  ['heading', { container: true, attrs: { level: headingLevel }, required: ['level'] }],
  ['bulletList', CONTAINER],
  ['orderedList', { container: true, attrs: { start: listStart }, required: [] }],
  ['listItem', CONTAINER],
  ['blockquote', CONTAINER],
  ['horizontalRule', LEAF],
  [
    'image',
    {
      container: false,
      attrs: { src: mediaSrc, alt: nullableString, title: nullableString },
      required: ['src'],
    },
  ],
  ['text', LEAF],
  ['hardBreak', LEAF],
]);

interface MarkSpec {
  readonly attrs: Readonly<Record<string, AttrCheck>>;
  readonly required: readonly string[];
}

const MARK_SPECS: ReadonlyMap<string, MarkSpec> = new Map<string, MarkSpec>([
  ['bold', { attrs: {}, required: [] }],
  ['italic', { attrs: {}, required: [] }],
  [
    'link',
    {
      attrs: {
        href: nonEmptyString,
        target: nullableString,
        rel: nullableString,
        class: nullableString,
      },
      required: ['href'],
    },
  ],
]);

function join(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

/** Returns the path of the first offending attribute, or null when the attrs are acceptable. */
function checkAttrs(
  owner: Plain,
  spec: {
    readonly attrs: Readonly<Record<string, AttrCheck>>;
    readonly required: readonly string[];
  },
  path: string,
  hosts: ReadonlySet<string>,
): string | null {
  const attrsPath = join(path, 'attrs');
  let attrs: Plain = {};
  if (hasOwn(owner, 'attrs')) {
    const raw = owner['attrs'];
    if (!isPlainObject(raw)) return attrsPath;
    attrs = raw;
  }
  for (const key of Object.keys(attrs)) {
    if (!hasOwn(spec.attrs, key)) return join(attrsPath, key);
  }
  for (const key of spec.required) {
    if (!hasOwn(attrs, key)) return join(attrsPath, key);
  }
  for (const key of Object.keys(attrs)) {
    const check = spec.attrs[key];
    if (check !== undefined && !check(attrs[key], hosts)) return join(attrsPath, key);
  }
  return null;
}

const MARK_KEYS: ReadonlySet<string> = new Set(['type', 'attrs']);

function checkMark(mark: unknown, path: string, hosts: ReadonlySet<string>): string | null {
  if (!isPlainObject(mark)) return path;
  const type = mark['type'];
  const spec = typeof type === 'string' ? MARK_SPECS.get(type) : undefined;
  if (!hasOwn(mark, 'type') || spec === undefined) return join(path, 'type');
  for (const key of Object.keys(mark)) {
    if (!MARK_KEYS.has(key)) return join(path, key);
  }
  return checkAttrs(mark, spec, path, hosts);
}

function allowedNodeKey(key: string, type: string, spec: NodeSpec): boolean {
  if (key === 'type' || key === 'attrs') return true;
  if (key === 'content') return spec.container;
  return (key === 'text' || key === 'marks') && type === 'text';
}

function checkNode(
  node: unknown,
  path: string,
  depth: number,
  hosts: ReadonlySet<string>,
): string | null {
  if (!isPlainObject(node)) return path;
  if (depth > MAX_NODE_DEPTH) return path;

  const typePath = join(path, 'type');
  const type = node['type'];
  if (!hasOwn(node, 'type') || typeof type !== 'string') return typePath;
  const spec = NODE_SPECS.get(type);
  if (spec === undefined || (type === 'doc') !== (depth === 1)) return typePath;

  for (const key of Object.keys(node)) {
    if (!allowedNodeKey(key, type, spec)) return join(path, key);
  }

  const attrsError = checkAttrs(node, spec, path, hosts);
  if (attrsError !== null) return attrsError;

  if (type === 'text') {
    const text = node['text'];
    if (typeof text !== 'string' || text === '') return join(path, 'text');
    if (hasOwn(node, 'marks')) {
      const marks = node['marks'];
      const marksPath = join(path, 'marks');
      if (!Array.isArray(marks)) return marksPath;
      for (const [index, mark] of marks.entries()) {
        const markError = checkMark(mark, `${marksPath}[${String(index)}]`, hosts);
        if (markError !== null) return markError;
      }
    }
  }

  if (hasOwn(node, 'content')) {
    const content = node['content'];
    const contentPath = join(path, 'content');
    if (!Array.isArray(content)) return contentPath;
    for (const [index, child] of content.entries()) {
      const childError = checkNode(child, `${contentPath}[${String(index)}]`, depth + 1, hosts);
      if (childError !== null) return childError;
    }
  }
  return null;
}

function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/** Shared article / agreement JSON whitelist (F1-02m §9.2). */
export function validateArticleBody(body: string, opts: ArticleBodyOptions): ArticleBodyResult {
  if (body.length > MAX_BODY_LENGTH) return { ok: false, fields: ['body'], path: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, fields: ['body'], path: '' };
  }
  const hosts: ReadonlySet<string> = new Set(opts.mediaHosts.map(normaliseHost));
  const error = checkNode(parsed, '', 1, hosts);
  return error === null ? { ok: true } : { ok: false, fields: ['body'], path: error };
}

/** SHA-256 of the stored string's UTF-8 bytes, without parsing or canonicalisation. */
export function textSha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
