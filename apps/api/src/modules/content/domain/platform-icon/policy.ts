// Fixed limits and whitelists for platform icon inspection (08 BR-TEXT-24 细则「上传与发布」;
// F1-06n orchestrator rulings 3–6). Only content.platform_icon.max_bytes is configurable, and it
// arrives as an argument; everything here is a code constant.

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** PNG edge length bounds, both sides, inclusive. */
export const PNG_MIN_EDGE = 512;
export const PNG_MAX_EDGE = 4096;

/** Accumulated elements (source plus expanded copies, the root svg included). */
export const MAX_ELEMENTS = 5000;
/** Nested use-reference hops. */
export const MAX_USE_DEPTH = 8;
/** Conversion output budget as a multiple of the upload size limit (UTF-8 bytes). */
export const OUTPUT_FACTOR = 4;

/** Step ①: declarations that may be rewritten into same-named presentation attributes. */
export const STYLE_PROPERTIES: ReadonlySet<string> = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'fill-rule',
  'clip-rule',
  'stop-color',
  'stop-opacity',
  'transform',
]);

/** CSS functions a converted declaration value may use; url() is further limited to `#id`. */
export const STYLE_FUNCTIONS: ReadonlySet<string> = new Set([
  'url',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'matrix',
  'translate',
  'translatex',
  'translatey',
  'scale',
  'scalex',
  'scaley',
  'rotate',
  'skewx',
  'skewy',
]);

/** Step ②: the seventeen drawing elements kept (SVG namespace only). */
export const ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'title',
  'desc',
]);

/** Elements whose text content is kept. */
export const TEXT_ELEMENTS: ReadonlySet<string> = new Set(['title', 'desc']);

/** Elements that may keep a local `#id` href (gradient template inheritance). */
export const HREF_ELEMENTS: ReadonlySet<string> = new Set(['linearGradient', 'radialGradient']);

/**
 * Step ②: geometry, paint, stroke and transform attributes (no namespace) kept on whitelisted
 * elements. `id` and href are handled separately. `display` / `visibility` / `color` are kept
 * because dropping them would change what is drawn; none of them can carry an address.
 */
export const ATTRIBUTES: ReadonlySet<string> = new Set([
  // viewport and geometry
  'x',
  'y',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'd',
  'pathLength',
  'points',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'offset',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'transform',
  // paint and stroke
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'paint-order',
  'vector-effect',
  'opacity',
  'color',
  'stop-color',
  'stop-opacity',
  'clip-rule',
  'clip-path',
  'mask',
  'display',
  'visibility',
]);
