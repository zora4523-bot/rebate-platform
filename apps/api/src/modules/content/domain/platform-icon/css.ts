// Step ①, style part: parse `<style>` text and `style` attributes into declarations that can be
// rewritten faithfully as presentation attributes. Anything outside the narrow grammar below
// (other properties, complex selectors, @ rules, !important, escapes, non-local url()) cannot be
// converted faithfully and rejects the whole document.
import { STYLE_FUNCTIONS, STYLE_PROPERTIES } from './policy.ts';
import { normalizeUrls, withoutUrls } from './references.ts';
import { unconvertible } from './rejection.ts';

export type Declaration = readonly [property: string, value: string];

export interface StyleRule {
  readonly kind: 'type' | 'class' | 'id';
  readonly name: string;
  /** id 100, class 10, type 1 (a single simple selector each). */
  readonly specificity: number;
  /** Source order across all `<style>` elements. */
  readonly order: number;
  readonly declarations: readonly Declaration[];
}

const IDENT = '-?[A-Za-z_][A-Za-z0-9_-]*';
const SIMPLE_SELECTOR = new RegExp(`^(?:(${IDENT})|\\.(${IDENT})|#(${IDENT}))$`);
const PROPERTY_NAME = /^[A-Za-z-]+$/;
const FUNCTION_CALL = /([A-Za-z0-9_-]*)\(/g;
const COMMENT = /\/\*[\s\S]*?\*\//g;

function stripComments(text: string): string {
  // Escapes are never faithful here (they can hide url(...)); reject before touching comments.
  if (text.includes('\\')) unconvertible('escape in style');
  const stripped = text.replace(COMMENT, ' ');
  if (stripped.includes('/*') || stripped.includes('*/')) unconvertible('unterminated comment');
  return stripped;
}

function validateValue(value: string): void {
  if (value === '') unconvertible('empty declaration value');
  if (/[{}<>;!@\\]/.test(value)) unconvertible('unsupported character in declaration value');
  for (const match of value.matchAll(FUNCTION_CALL)) {
    if (!STYLE_FUNCTIONS.has(match[1]!.toLowerCase())) unconvertible('unsupported function');
  }
  if (normalizeUrls(value) === null) unconvertible('non-local url()');
  if (/["']/.test(withoutUrls(value))) unconvertible('quoted text outside url()');
}

/** Parses a declaration block (inline `style` or a rule body); last declaration wins later. */
export function parseDeclarations(text: string): Declaration[] {
  const declarations: Declaration[] = [];
  for (const piece of stripComments(text).split(';')) {
    const declaration = piece.trim();
    if (declaration === '') continue;
    const colon = declaration.indexOf(':');
    if (colon <= 0) unconvertible('malformed declaration');
    const property = declaration.slice(0, colon).trim();
    if (!PROPERTY_NAME.test(property)) unconvertible('malformed property name');
    const name = property.toLowerCase();
    if (!STYLE_PROPERTIES.has(name)) unconvertible(`unsupported property ${name}`);
    const value = declaration.slice(colon + 1).trim();
    validateValue(value);
    declarations.push([name, value]);
  }
  return declarations;
}

/** Parses one stylesheet; `firstOrder` continues source order across several `<style>`. */
export function parseStylesheet(text: string, firstOrder: number): StyleRule[] {
  if (/@|<!--|-->/.test(text)) unconvertible('@ rule or CDO/CDC in stylesheet');
  let rest = stripComments(text);
  const rules: StyleRule[] = [];
  let order = firstOrder;
  for (;;) {
    rest = rest.trimStart();
    if (rest === '') return rules;
    const open = rest.indexOf('{');
    const close = rest.indexOf('}');
    if (open < 0 || close < open) unconvertible('malformed rule');
    const body = rest.slice(open + 1, close);
    if (body.includes('{')) unconvertible('nested block');
    const declarations = parseDeclarations(body);
    for (const selector of rest.slice(0, open).split(',')) {
      const match = SIMPLE_SELECTOR.exec(selector.trim());
      if (!match) unconvertible('complex selector');
      const [, type, className, id] = match;
      rules.push(
        type !== undefined
          ? { kind: 'type', name: type, specificity: 1, order, declarations }
          : className !== undefined
            ? { kind: 'class', name: className, specificity: 10, order, declarations }
            : { kind: 'id', name: id!, specificity: 100, order, declarations },
      );
    }
    order++;
    rest = rest.slice(close + 1);
  }
}

export class StyleIndex {
  readonly #byKey = new Map<string, StyleRule[]>();

  constructor(rules: readonly StyleRule[]) {
    for (const rule of rules) {
      const key = `${rule.kind}:${rule.name}`;
      const list = this.#byKey.get(key);
      if (list) list.push(rule);
      else this.#byKey.set(key, [rule]);
    }
  }

  get empty(): boolean {
    return this.#byKey.size === 0;
  }

  /** Matching declarations in cascade order (specificity, then source order). */
  match(localName: string, id: string | null, classes: readonly string[]): Declaration[] {
    const keys = [`type:${localName}`];
    for (const name of new Set(classes)) keys.push(`class:${name}`);
    if (id !== null) keys.push(`id:${id}`);
    const matched: StyleRule[] = [];
    for (const key of keys) for (const rule of this.#byKey.get(key) ?? []) matched.push(rule);
    matched.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
    return matched.flatMap((rule) => rule.declarations);
  }
}
