// Step ①, value part: a declaration value moves from CSS (`style`) into an SVG presentation
// attribute only when it means the same thing there. SVG attribute grammar is narrower than CSS
// (SVG 1.1 transform lists take bare numbers; native decoders read SVG 1.1 colours and lengths),
// so each of the fifteen properties has a small accepted grammar. Values outside it — CSS-only
// transform functions, units the attribute does not take, newer colour syntax — reject the whole
// document instead of being guessed at. Input values have already passed the url() checks.
import { NAMED_COLORS } from './colors.ts';
import { unconvertible } from './rejection.ts';

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER_ONLY = new RegExp(`^${NUMBER}$`);
const NON_NEGATIVE = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** SVG 1.1 length units (identical meaning in CSS and in the attribute). */
const LENGTH = new RegExp(`^(${NUMBER})(px|em|ex|in|cm|mm|pt|pc|%)?$`);
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGB_COLOR = new RegExp(
  `^rgb\\(\\s*(?:${NUMBER}\\s*,\\s*${NUMBER}\\s*,\\s*${NUMBER}|${NUMBER}%\\s*,\\s*${NUMBER}%\\s*,\\s*${NUMBER}%)\\s*\\)$`,
);
const LOCAL_URL = /^url\(#[^()\s]+\)$/;

const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  'stroke-linecap': ['butt', 'round', 'square'],
  'stroke-linejoin': ['miter', 'round', 'bevel'],
  'fill-rule': ['nonzero', 'evenodd'],
  'clip-rule': ['nonzero', 'evenodd'],
};

function isColor(value: string): boolean {
  return (
    value === 'currentColor' ||
    HEX_COLOR.test(value) ||
    RGB_COLOR.test(value) ||
    NAMED_COLORS.has(value)
  );
}

/** `none`, a colour, or `url(#id)` with an optional `none` / colour fallback. */
function isPaint(value: string): boolean {
  if (value === 'none' || isColor(value)) return true;
  const space = value.indexOf(' ');
  const reference = space < 0 ? value : value.slice(0, space);
  if (!LOCAL_URL.test(reference)) return false;
  if (space < 0) return true;
  const fallback = value.slice(space + 1);
  return fallback === 'none' || isColor(fallback);
}

function isNonNegativeLength(value: string): boolean {
  const match = LENGTH.exec(value);
  return match !== null && NON_NEGATIVE.test(match[1]!);
}

function isDashArray(value: string): boolean {
  if (value === 'none') return true;
  const items = value.split(/\s*,\s*|\s+/);
  return items.length > 0 && items.every(isNonNegativeLength);
}

// ------------------------------------------------------------------ transform

/** SVG transform functions: argument counts, and the one unit that may be dropped. */
const TRANSFORMS: ReadonlyMap<
  string,
  { readonly name: string; readonly counts: readonly number[]; readonly unit: string | null }
> = new Map([
  ['matrix', { name: 'matrix', counts: [6], unit: null }],
  ['translate', { name: 'translate', counts: [1, 2], unit: 'px' }],
  ['scale', { name: 'scale', counts: [1, 2], unit: null }],
  ['rotate', { name: 'rotate', counts: [1, 3], unit: 'deg' }],
  ['skewX', { name: 'skewX', counts: [1], unit: 'deg' }],
  ['skewY', { name: 'skewY', counts: [1], unit: 'deg' }],
]);
const TRANSFORM_FUNCTION = /\s*([A-Za-z]+)\(([^()]*)\)\s*/y;
const ARGUMENT = new RegExp(`^(${NUMBER})([A-Za-z%]*)$`);

/**
 * CSS transform list → SVG transform list. Only the six SVG functions (exact SVG spelling),
 * with bare numbers, or with `px` (translate) / `deg` (rotate, skewX, skewY) that can be dropped
 * without changing the meaning. rotate's centre form takes bare numbers only.
 */
function convertTransform(value: string): string {
  const converted: string[] = [];
  TRANSFORM_FUNCTION.lastIndex = 0;
  while (TRANSFORM_FUNCTION.lastIndex < value.length) {
    const match = TRANSFORM_FUNCTION.exec(value);
    if (match === null) unconvertible('malformed transform');
    const spec = TRANSFORMS.get(match[1]!);
    if (spec === undefined) unconvertible(`transform function ${match[1]} has no SVG equivalent`);
    const raw = match[2]!.trim();
    const pieces = raw === '' ? [] : raw.split(/\s*,\s*|\s+/);
    if (!spec.counts.includes(pieces.length)) unconvertible('transform argument count');
    const numbers = pieces.map((piece) => {
      const argument = ARGUMENT.exec(piece);
      if (argument === null) unconvertible('transform argument');
      const unit = argument[2]!;
      // rotate(a cx cy): the centre is in user units, so its form takes bare numbers only.
      if (unit !== '' && (unit !== spec.unit || (spec.name === 'rotate' && pieces.length === 3))) {
        unconvertible(`transform unit ${unit} cannot be dropped`);
      }
      return argument[1]!;
    });
    converted.push(`${spec.name}(${numbers.join(' ')})`);
  }
  if (converted.length === 0) unconvertible('empty transform');
  return converted.join(' ');
}

// ------------------------------------------------------------------ entry

/**
 * Returns the attribute value for a whitelisted declaration (whitespace collapsed; transform
 * rewritten in SVG syntax), or rejects the document when SVG would read it differently.
 */
export function presentationValue(property: string, value: string): string {
  const collapsed = value.trim().replace(/\s+/g, ' ');
  if (property === 'transform') return convertTransform(collapsed);
  if (collapsed === 'inherit') return collapsed;
  let valid: boolean;
  switch (property) {
    case 'fill':
    case 'stroke':
      valid = isPaint(collapsed);
      break;
    case 'stop-color':
      valid = isColor(collapsed);
      break;
    case 'stroke-width':
      valid = isNonNegativeLength(collapsed);
      break;
    case 'stroke-dasharray':
      valid = isDashArray(collapsed);
      break;
    case 'stroke-miterlimit':
      valid = NON_NEGATIVE.test(collapsed) && Number(collapsed) >= 1;
      break;
    case 'opacity':
    case 'fill-opacity':
    case 'stroke-opacity':
    case 'stop-opacity':
      // SVG 1.1 opacity is a bare number; CSS percentages are not read by the attribute.
      valid = NUMBER_ONLY.test(collapsed);
      break;
    default:
      valid = KEYWORDS[property]?.includes(collapsed) ?? false;
  }
  if (!valid) unconvertible(`${property} value has no faithful SVG attribute form`);
  return collapsed;
}

// ------------------------------------------------------------------ transform attribute

const COMMA_WSP = String.raw`(?:\s+,?\s*|,\s*)`;
const ATTRIBUTE_TRANSFORM = new RegExp(
  `^\\s*(?:(?:matrix|translate|scale|rotate|skewX|skewY)\\s*\\(\\s*${NUMBER}(?:${COMMA_WSP}${NUMBER})*\\s*\\)\\s*,?\\s*)+$`,
);

/**
 * Whether an SVG `transform` attribute value is a transform list every reader parses alike
 * (the six SVG functions, numeric arguments in the counts SVG allows). Merging transforms by
 * concatenation is only faithful when each part parses on its own: an unparseable part would
 * void the merged list instead of only itself.
 */
export function isTransformList(value: string): boolean {
  if (!ATTRIBUTE_TRANSFORM.test(value)) return false;
  const functionCall = /([A-Za-z]+)\s*\(([^()]*)\)/g;
  for (let match = functionCall.exec(value); match; match = functionCall.exec(value)) {
    const count = match[2]!.trim().split(new RegExp(COMMA_WSP)).length;
    if (!TRANSFORMS.get(match[1]!)!.counts.includes(count)) return false;
  }
  return true;
}
