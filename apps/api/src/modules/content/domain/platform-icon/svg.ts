// SVG inspection: parse (xmldom, no DTD or entities), step ① faithful conversion (use expansion,
// style rewrite) and step ② whitelist, fused into one bounded streaming pass. Copies are never
// materialized as DOM nodes: an expanded use is serialized straight from the referenced source
// subtree, so the element, depth, output-size and deadline budgets are checked as each element
// is produced, and the first breach stops the work and rejects the whole document.
import {
  DOMParser,
  type Document,
  type Element,
  type Node,
  type ProcessingInstruction,
} from '@xmldom/xmldom';
import {
  StyleIndex,
  parseDeclarations,
  parseStylesheet,
  type Declaration,
  type StyleRule,
} from './css.ts';
import {
  ATTRIBUTES,
  ELEMENTS,
  HREF_ELEMENTS,
  MAX_ELEMENTS,
  MAX_USE_DEPTH,
  OUTPUT_FACTOR,
  SVG_NS,
  TEXT_ELEMENTS,
  XLINK_NS,
} from './policy.ts';
import { localId, normalizeUrls } from './references.ts';
import { invalid, unconvertible } from './rejection.ts';

export interface Deadline {
  remainingMs(): number;
}

const ELEMENT_NODE = 1;
const ATTRIBUTE_NODE = 2;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
const DOCUMENT_TYPE_NODE = 10;

/** Characters outside XML 1.0 `Char` (controls, non-characters) and unpaired surrogates. */
const NOT_XML_CHAR =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const XLINK_HREF = 'xlink:href';

/** Resolved attributes: no-namespace attributes by name, xlink href as `xlink:href`. */
type Attributes = Map<string, string>;

function checkDeadline(deadline: Deadline): void {
  // NaN or a non-positive remainder both count as expired.
  if (!(deadline.remainingMs() > 0)) unconvertible('conversion deadline expired');
}

function elementChildren(node: Node): Element[] {
  const children: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === ELEMENT_NODE) children.push(child as Element);
  }
  return children;
}

// ---------------------------------------------------------------- parsing

/**
 * DOCTYPE with an internal subset (even an empty `[]`) and ENTITY declarations are not parsed
 * by this line; xmldom reports `[]` and no subset alike, so look at the source text. The scan is
 * deliberately broad (comments and CDATA are not skipped): a false positive only rejects.
 */
function rejectDtdSubset(text: string): void {
  if (/<!ENTITY/i.test(text)) invalid('ENTITY declaration');
  const doctype = /<!DOCTYPE/gi;
  for (let match = doctype.exec(text); match; match = doctype.exec(text)) {
    let quote: string | null = null;
    for (let i = match.index + match[0].length; i < text.length; i++) {
      const char = text[i]!;
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '[') {
        invalid('DOCTYPE internal subset');
      } else if (char === '>') {
        break;
      }
    }
  }
}

function parseDocument(text: string): Document {
  rejectDtdSubset(text);
  let reported = false;
  let document: Document;
  try {
    document = new DOMParser({
      onError: () => {
        reported = true;
      },
    }).parseFromString(text, 'image/svg+xml');
  } catch {
    invalid('XML parse error');
  }
  // Warnings are xmldom's recoveries from non-well-formed input (unquoted attributes, ...).
  if (reported) invalid('XML parse error');
  return document;
}

interface Source {
  readonly document: Document;
  readonly root: Element;
  /** Pre-order list of every element under (and including) the root. */
  readonly elements: readonly Element[];
  /** Elements in each subtree, including its root. */
  readonly subtreeSize: ReadonlyMap<Element, number>;
  /** First element in document order carrying each id. */
  readonly ids: ReadonlyMap<string, Element>;
}

function checkCharacters(value: string): void {
  if (NOT_XML_CHAR.test(value)) invalid('character not allowed in XML');
}

function readSource(document: Document, deadline: Deadline): Source {
  let root: Element | null = null;
  let stylesheetInstruction = false;
  for (let node = document.firstChild; node; node = node.nextSibling) {
    switch (node.nodeType) {
      case ELEMENT_NODE:
        if (root !== null) invalid('multiple root elements');
        root = node as Element;
        break;
      case PROCESSING_INSTRUCTION_NODE: {
        const target = (node as ProcessingInstruction).target;
        if (target === 'xml-stylesheet') stylesheetInstruction = true;
        else if (target !== 'xml') invalid(`processing instruction ${target}`);
        break;
      }
      case COMMENT_NODE:
      case DOCUMENT_TYPE_NODE:
        break;
      case TEXT_NODE:
        if ((node.nodeValue ?? '').trim() !== '') invalid('text outside the root element');
        break;
      default:
        invalid('unexpected node outside the root element');
    }
  }
  if (root === null || root.localName !== 'svg' || root.namespaceURI !== SVG_NS) {
    invalid('root element is not svg');
  }

  const elements: Element[] = [];
  const ids = new Map<string, Element>();
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.nodeType) {
      case ELEMENT_NODE: {
        const element = node as Element;
        checkDeadline(deadline);
        elements.push(element);
        if (elements.length > MAX_ELEMENTS) unconvertible('too many elements');
        for (const attribute of Array.from(element.attributes)) checkCharacters(attribute.value);
        const id = element.getAttributeNode('id');
        if (id !== null && id.namespaceURI === null && !ids.has(id.value)) {
          ids.set(id.value, element);
        }
        const children: Node[] = [];
        for (let child = element.firstChild; child; child = child.nextSibling) children.push(child);
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
        break;
      }
      case TEXT_NODE:
      case CDATA_SECTION_NODE:
        checkCharacters(node.nodeValue ?? '');
        break;
      case COMMENT_NODE:
        break;
      case PROCESSING_INSTRUCTION_NODE:
        invalid('processing instruction inside the document');
        break;
      default:
        invalid('unsupported node type');
    }
  }
  // An xml-stylesheet instruction pulls in an external stylesheet: well-formed, not convertible.
  if (stylesheetInstruction) unconvertible('xml-stylesheet processing instruction');

  const subtreeSize = new Map<Element, number>();
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i]!;
    let size = 1;
    for (const child of elementChildren(element)) size += subtreeSize.get(child)!;
    subtreeSize.set(element, size);
  }
  return { document, root, elements, subtreeSize, ids };
}

// ---------------------------------------------------------------- step ①: styles

function collectStyles(source: Source): StyleIndex {
  const rules: StyleRule[] = [];
  for (const element of source.elements) {
    if (element.localName !== 'style') continue;
    // A style element in another namespace (e.g. XHTML) would still style an SVG in a browser.
    if (element.namespaceURI !== SVG_NS) unconvertible('foreign style element');
    const type = element.getAttribute('type');
    if (type !== null && type.trim() !== '' && type.trim().toLowerCase() !== 'text/css') {
      unconvertible('non-CSS style element');
    }
    const media = element.getAttribute('media');
    if (media !== null && media.trim() !== '' && media.trim().toLowerCase() !== 'all') {
      unconvertible('conditional style element');
    }
    let text = '';
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) {
        text += child.nodeValue ?? '';
      } else if (child.nodeType !== COMMENT_NODE) {
        unconvertible('markup inside style element');
      }
    }
    // Loops instead of spread: a 200 KB stylesheet can hold more rules than call arguments allow.
    for (const rule of parseStylesheet(text, rules.length)) rules.push(rule);
  }
  return new StyleIndex(rules);
}

/** Own attributes after the cascade: presentation attribute < stylesheet < inline style. */
function resolveAttributes(element: Element, styles: StyleIndex): Attributes {
  const attributes: Attributes = new Map();
  let hrefPlain: string | undefined;
  let hrefXlink: string | undefined;
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.nodeType !== ATTRIBUTE_NODE) continue;
    const namespace = attribute.namespaceURI;
    if (namespace === null) {
      if (attribute.name.includes(':')) continue;
      if (attribute.name === 'href') hrefPlain = attribute.value;
      else attributes.set(attribute.name, attribute.value);
    } else if (namespace === XLINK_NS && attribute.localName === 'href') {
      hrefXlink = attribute.value;
    }
    // xmlns declarations, xml:*, and other namespaces carry nothing kept.
  }
  // SVG 2: a plain href takes precedence over xlink:href.
  const href = hrefPlain ?? hrefXlink;
  if (href !== undefined) attributes.set(XLINK_HREF, href);

  const declarations: Declaration[] = [];
  if (!styles.empty) {
    const classes = (attributes.get('class') ?? '').split(/[\t\n\f\r ]+/).filter(Boolean);
    const id = attributes.get('id') ?? null;
    for (const declaration of styles.match(element.localName ?? '', id, classes)) {
      declarations.push(declaration);
    }
  }
  const inline = attributes.get('style');
  if (inline !== undefined) {
    for (const declaration of parseDeclarations(inline)) declarations.push(declaration);
  }
  for (const [property, value] of declarations) attributes.set(property, value);
  attributes.delete('style');
  return attributes;
}

// ---------------------------------------------------------------- step ②: attribute whitelist

/** Kept attributes, sorted by name for a deterministic serialization. */
function keptAttributes(
  localName: string,
  attributes: Attributes,
  copy: boolean,
): Array<[string, string]> {
  const kept: Array<[string, string]> = [];
  for (const [name, value] of attributes) {
    if (name === 'id') {
      // Copies drop ids so the document keeps one element per id.
      if (!copy && value !== '') kept.push([name, value]);
    } else if (name === XLINK_HREF) {
      if (!HREF_ELEMENTS.has(localName)) continue;
      const id = localId(value);
      if (id !== null) kept.push([XLINK_HREF, `#${id}`]);
    } else if (ATTRIBUTES.has(name)) {
      // CSS escapes and comments can disguise references; such values are dropped outright.
      if (value.includes('\\') || value.includes('/*')) continue;
      const normalized = normalizeUrls(value);
      if (normalized !== null) kept.push([name, normalized]);
    }
  }
  return kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\t', '&#9;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;');
}

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;');
}

// ---------------------------------------------------------------- bounded streaming output

class Output {
  readonly #chunks: string[] = [];
  readonly #limit: number;
  #bytes = 0;
  #pending: string | null = null;

  constructor(limit: number) {
    this.#limit = limit;
  }

  #write(text: string): void {
    this.#bytes += Buffer.byteLength(text, 'utf8');
    if (this.#bytes > this.#limit) unconvertible('conversion output too large');
    this.#chunks.push(text);
  }

  #flush(): void {
    if (this.#pending !== null) {
      const pending = this.#pending;
      this.#pending = null;
      this.#write(`${pending}>`);
    }
  }

  open(name: string, attributes: ReadonlyArray<readonly [string, string]>): void {
    this.#flush();
    let tag = `<${name}`;
    for (const [attribute, value] of attributes) tag += ` ${attribute}="${escapeAttribute(value)}"`;
    this.#pending = tag;
  }

  text(value: string): void {
    if (value === '') return;
    this.#flush();
    this.#write(escapeText(value));
  }

  close(name: string): void {
    if (this.#pending !== null) {
      const pending = this.#pending;
      this.#pending = null;
      this.#write(`${pending}/>`);
    } else {
      this.#write(`</${name}>`);
    }
  }

  result(): string {
    return this.#chunks.join('');
  }
}

// ---------------------------------------------------------------- step ① + ② walk

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:px)?$/;

function useOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  if (!NUMBER.test(trimmed)) unconvertible('use x / y is not a plain length');
  const number = Number(trimmed.replace(/px$/, ''));
  if (!Number.isFinite(number)) unconvertible('use x / y is not finite');
  return number;
}

interface Context {
  /** use-reference hops above this element. */
  readonly depth: number;
  /** Inside an expanded copy. */
  readonly copy: boolean;
  /** Whether this subtree reaches the output (false under a removed element). */
  readonly emit: boolean;
}

type Step =
  | { readonly kind: 'enter'; readonly element: Element; readonly context: Context }
  | { readonly kind: 'text'; readonly value: string }
  /** Leaves an element: closes its tag (if emitted) and takes it off the active path. */
  | { readonly kind: 'exit'; readonly element: Element; readonly close: string | null };

class Converter {
  readonly #source: Source;
  readonly #styles: StyleIndex;
  readonly #deadline: Deadline;
  readonly #output: Output;
  readonly #resolved = new Map<Element, Attributes>();
  /** Elements on the current (virtual, through use) path: a reference to one is a cycle. */
  readonly #active = new Set<Element>();
  #elements: number;

  constructor(source: Source, styles: StyleIndex, deadline: Deadline, outputLimit: number) {
    this.#source = source;
    this.#styles = styles;
    this.#deadline = deadline;
    this.#output = new Output(outputLimit);
    this.#elements = source.elements.length;
  }

  run(): string {
    // Resolve (and so validate) every style before producing anything.
    for (const element of this.#source.elements) {
      checkDeadline(this.#deadline);
      this.#resolved.set(element, resolveAttributes(element, this.#styles));
    }
    // Explicit work stack: nesting may reach the element limit, deeper than a safe call stack.
    const work: Step[] = [
      { kind: 'enter', element: this.#source.root, context: { depth: 0, copy: false, emit: true } },
    ];
    for (let step = work.pop(); step; step = work.pop()) {
      switch (step.kind) {
        case 'enter':
          this.#enter(step.element, step.context, work);
          break;
        case 'text':
          this.#output.text(step.value);
          break;
        case 'exit':
          if (step.close !== null) this.#output.close(step.close);
          this.#active.delete(step.element);
          break;
      }
    }
    return this.#output.result();
  }

  #enter(element: Element, context: Context, work: Step[]): void {
    checkDeadline(this.#deadline);
    this.#active.add(element);
    if (element.localName === 'use' && element.namespaceURI === SVG_NS) {
      this.#expand(element, context, work);
      return;
    }
    const name = element.localName ?? '';
    const keep = context.emit && element.namespaceURI === SVG_NS && ELEMENTS.has(name);
    if (keep) {
      const attributes = keptAttributes(name, this.#resolved.get(element)!, context.copy);
      if (element === this.#source.root) {
        attributes.unshift(['xmlns', SVG_NS], ['xmlns:xlink', XLINK_NS]);
      }
      this.#output.open(name, attributes);
    }
    work.push({ kind: 'exit', element, close: keep ? name : null });
    const keepText = keep && TEXT_ELEMENTS.has(name);
    const children: Context = { ...context, emit: keep && !keepText };
    const steps: Step[] = [];
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === ELEMENT_NODE) {
        steps.push({ kind: 'enter', element: child as Element, context: children });
      } else if (
        keepText &&
        (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE)
      ) {
        steps.push({ kind: 'text', value: child.nodeValue ?? '' });
      }
    }
    for (let i = steps.length - 1; i >= 0; i--) work.push(steps[i]!);
  }

  /** Replaces a use by a group carrying its attributes and an x / y translation. */
  #expand(use: Element, context: Context, work: Step[]): void {
    const attributes = this.#resolved.get(use)!;
    const href = attributes.get(XLINK_HREF);
    if (href === undefined) {
      // A use without a reference draws nothing.
      work.push({ kind: 'exit', element: use, close: null });
      return;
    }
    const id = localId(href);
    if (id === null) unconvertible('use refers outside the document');
    const target = this.#source.ids.get(id);
    if (target === undefined) unconvertible('use refers to a missing element');
    if (this.#active.has(target)) unconvertible('use reference cycle');
    if (
      target.namespaceURI === SVG_NS &&
      (target.localName === 'svg' || target.localName === 'symbol')
    ) {
      // A new viewport (viewBox, width / height) cannot be rewritten as a plain group.
      unconvertible('use refers to a viewport element');
    }
    const depth = context.depth + 1;
    if (depth > MAX_USE_DEPTH) unconvertible('use nesting too deep');
    this.#elements += this.#source.subtreeSize.get(target)!;
    if (this.#elements > MAX_ELEMENTS) unconvertible('too many elements after expansion');

    const x = useOffset(attributes.get('x'));
    const y = useOffset(attributes.get('y'));
    const group: Attributes = new Map(attributes);
    for (const name of ['x', 'y', 'width', 'height', 'id', XLINK_HREF]) group.delete(name);
    if (x !== 0 || y !== 0) {
      const translate = `translate(${String(x)} ${String(y)})`;
      const transform = group.get('transform')?.trim();
      group.set('transform', transform ? `${transform} ${translate}` : translate);
    }
    const kept = context.emit ? keptAttributes('g', group, true) : [];
    const wrap = kept.length > 0;
    if (wrap) this.#output.open('g', kept);
    work.push({ kind: 'exit', element: use, close: wrap ? 'g' : null });
    work.push({
      kind: 'enter',
      element: target,
      context: { depth, copy: true, emit: context.emit },
    });
  }
}

export function sanitizeSvg(input: Uint8Array, maxBytes: number, deadline: Deadline): Uint8Array {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    invalid('not UTF-8');
  }
  const declared = /^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([^"']*)["']/.exec(text)?.[1];
  if (declared !== undefined && !/^utf-?8$/i.test(declared) && /[^\u0000-\u007f]/.test(text)) {
    invalid('non-UTF-8 declared encoding');
  }
  const document = parseDocument(text);
  const source = readSource(document, deadline);
  const styles = collectStyles(source);
  const output = new Converter(source, styles, deadline, maxBytes * OUTPUT_FACTOR).run();
  return new TextEncoder().encode(output);
}
