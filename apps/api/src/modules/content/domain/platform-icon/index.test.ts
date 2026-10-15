import { createHash } from 'node:crypto';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import pngjs from 'pngjs';
import { expect, it, vi } from 'vitest';
import { inspectPlatformIcon, type PlatformIconOptions, type PlatformIconResult } from './index.ts';
import { inflatedSize } from './png.ts';

const SVG = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

function options(maxBytes = 204800, remainingMs: () => number = () => 2000): PlatformIconOptions {
  return { maxBytes, deadline: { remainingMs } };
}

function svg(body: string, attributes = ''): string {
  return `<svg xmlns="${SVG}" ${attributes}>${body}</svg>`;
}

function inspect(source: string, config = options()): PlatformIconResult {
  return inspectPlatformIcon(new TextEncoder().encode(source), config);
}

function ok(result: PlatformIconResult): Extract<PlatformIconResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}`);
  expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'));
  return result;
}

function clean(source: string, config = options()): { text: string; document: Document } {
  const text = new TextDecoder().decode(ok(inspect(source, config)).bytes);
  let failed = false;
  const document = new DOMParser({
    onError: () => {
      failed = true;
    },
  }).parseFromString(text, 'image/svg+xml');
  expect(failed).toBe(false);
  return { text, document };
}

function all(document: Document, name = '*'): Element[] {
  return Array.from(document.getElementsByTagName(name));
}

function rejected(source: string, config = options()): string {
  const result = inspect(source, config);
  if (result.ok) throw new Error('expected rejection');
  return result.reason;
}

// ---------------------------------------------------------------- format and size

it.each([
  ['empty', new Uint8Array()],
  ['JPEG', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])],
  ['SVGZ', gzipSync(new TextEncoder().encode(svg('<rect/>')))],
  ['UTF-16 SVG', new Uint8Array(Buffer.from(`\uFEFF${svg('<rect/>')}`, 'utf16le'))],
  ['text', new TextEncoder().encode('hello <svg/>')],
])('[AC-F1-06v] unknown bytes are format-invalid: %s', (_name, input) => {
  expect(inspectPlatformIcon(input, options())).toEqual({
    ok: false,
    reason: 'icon_format_invalid',
  });
});

it('[AC-F1-06v] size is checked first, without parsing or polling the deadline', () => {
  const remainingMs = vi.fn(() => -1);
  expect(inspect('<<<not xml', options(3, remainingMs))).toEqual({
    ok: false,
    reason: 'icon_too_large',
  });
  expect(remainingMs).not.toHaveBeenCalled();
});

it.each([
  ['broken', '<svg xmlns="http://www.w3.org/2000/svg"><g></path></svg>'],
  ['unquoted attribute', `<svg xmlns="${SVG}"><rect width=1/></svg>`],
  ['html root', '<?xml version="1.0"?><html/>'],
  ['two roots', '<svg/><svg/>'],
  ['empty internal subset', '<!DOCTYPE svg []><svg/>'],
  ['entity', '<!DOCTYPE svg [<!ENTITY x "y">]><svg><title>&x;</title></svg>'],
  ['undeclared entity', svg('<title>&nope;</title>')],
  ['control character reference', svg('<title>&#1;</title>')],
  ['lone surrogate reference', svg('<title>&#xD800;</title>')],
  ['nested PI', svg('<?php echo 1 ?><rect/>')],
  ['other PI', '<?custom x?><svg/>'],
])('[AC-F1-06v] unparseable or disallowed XML is format-invalid: %s', (_name, source) => {
  expect(rejected(source)).toBe('icon_format_invalid');
});

it('[AC-F1-06v] invalid UTF-8 is format-invalid', () => {
  const bytes = Uint8Array.from([
    ...new TextEncoder().encode(`<svg xmlns="${SVG}"><title>`),
    0xc3,
    0x28,
  ]);
  expect(inspectPlatformIcon(bytes, options())).toEqual({
    ok: false,
    reason: 'icon_format_invalid',
  });
});

it('[AC-F1-06v] DOCTYPE without subset and BOM are accepted; xml-stylesheet is unconvertible', () => {
  const doctype = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://never.invalid/svg.dtd">';
  expect(
    all(clean(`\uFEFF<?xml version="1.0"?>${doctype}${svg('<path d="M0 0"/>')}`).document, 'path'),
  ).toHaveLength(1);
  expect(rejected(`<?xml-stylesheet href="https://x.invalid/a.css"?>${svg('<rect/>')}`)).toBe(
    'icon_svg_unconvertible',
  );
});

// ---------------------------------------------------------------- PNG

function png(width: number, height: number, colorType = 6, corner?: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  data[center] = 255;
  data[center + 3] = 255;
  if (corner !== undefined) {
    data[[0, width - 1, (height - 1) * width, height * width - 1][corner]! * 4 + 3] = 255;
  }
  return pngjs.PNG.sync.write(
    { width, height, data } as never,
    { colorType, inputColorType: 6 } as never,
  );
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

it('[AC-F1-06v] transparent PNG is accepted unchanged', () => {
  const input = png(512, 600);
  const result = ok(inspectPlatformIcon(input, options()));
  expect(result.format).toBe('png');
  expect(result.sanitized).toBe(false);
  expect(Buffer.from(result.bytes).equals(input)).toBe(true);
});

it.each([
  ['small', () => png(511, 512)],
  ['opaque corner', () => png(512, 512, 6, 3)],
  ['no alpha', () => png(512, 512, 2)],
  ['trailing data', () => Buffer.concat([png(512, 512), Buffer.from([0])])],
  ['truncated', () => png(512, 512).subarray(0, 100)],
])('[AC-F1-06v] PNG rejected: %s', (_name, make) => {
  expect(inspectPlatformIcon(make(), options())).toEqual({
    ok: false,
    reason: 'icon_format_invalid',
  });
});

it('[AC-F1-06v] oversized IHDR is rejected before decoding', () => {
  const source = png(512, 512);
  const ihdr = Buffer.from(source.subarray(16, 29));
  ihdr.writeUInt32BE(100000, 0);
  const input = Buffer.concat([source.subarray(0, 8), chunk('IHDR', ihdr), source.subarray(33)]);
  const read = vi.spyOn(pngjs.PNG.sync, 'read');
  try {
    expect(inspectPlatformIcon(input, options())).toEqual({
      ok: false,
      reason: 'icon_format_invalid',
    });
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

// ---------------------------------------------------------------- conversion

it('[AC-F1-06v] use expands with x / y as a translation after the use transform, class styles applied', () => {
  const { document } = clean(
    svg(
      `<style>.b{fill:#ef3340;stroke-width:2}</style>
       <defs><g id="m"><rect class="b" x="1" y="2" width="10" height="12"/></g></defs>
       <use xlink:href="#m" x="3" y="4" transform="scale(2)" fill="blue"/>`,
      `xmlns:xlink="${XLINK}"`,
    ),
  );
  expect(all(document, 'use')).toHaveLength(0);
  expect(all(document, 'style')).toHaveLength(0);
  const wrapper = all(document, 'g')[1]!;
  expect(wrapper.getAttribute('transform')).toBe('scale(2) translate(3 4)');
  expect(wrapper.getAttribute('fill')).toBe('blue');
  const copy = all(document, 'rect')[1]!;
  expect(copy.hasAttribute('id')).toBe(false);
  expect(copy.getAttribute('fill')).toBe('#ef3340');
  expect(copy.getAttribute('stroke-width')).toBe('2');
  expect(all(document, 'g')[0]!.getAttribute('id')).toBe('m');
});

it.each([
  ['cycle', '<g id="a"><use href="#a"/></g>'],
  ['self', '<use id="u" href="#u"/>'],
  ['missing', '<use href="#nope"/>'],
  ['external', '<use href="https://x.invalid/a.svg#a"/>'],
  ['empty href', '<use href=""/>'],
  ['symbol', '<symbol id="s" viewBox="0 0 1 1"><rect/></symbol><use href="#s"/>'],
  ['percent offset', '<rect id="r"/><use href="#r" x="10%"/>'],
  ['external use inside a removed element', '<a><use href="//x.invalid/a#b"/></a>'],
  ['unsupported inline property', '<rect style="display:none"/>'],
  ['important', '<rect style="fill:red !important"/>'],
  ['escape', '<rect style="fill:u\\72l(#a)"/>'],
  ['var()', '<rect style="fill:var(--x)"/>'],
  ['external url', '<rect style="fill:url(a.svg#x)"/>'],
  ['complex selector', '<style>g rect{fill:red}</style>'],
  ['universal selector', '<style>*{fill:red}</style>'],
  ['at rule', '<style>@font-face{}</style>'],
  ['foreign style', '<h:style xmlns:h="http://www.w3.org/1999/xhtml">rect{fill:red}</h:style>'],
  ['unused bad rule', '<style>.x{position:absolute}</style>'],
])('[AC-F1-06v] unconvertible SVG is rejected whole: %s', (_name, body) => {
  expect(rejected(svg(body))).toBe('icon_svg_unconvertible');
});

it('[AC-F1-06v] cascade: id > class > type > presentation attribute, inline wins, source order breaks ties', () => {
  const { document } = clean(
    svg(`<style>#w{fill:red}.c{fill:blue}rect{fill:green;stroke:green}.c{stroke:blue}</style>
      <rect id="w" class="c"/><rect class="c" fill="black" style="fill:yellow"/><rect fill="black"/>`),
  );
  expect(all(document, 'rect').map((r) => r.getAttribute('fill'))).toEqual([
    'red',
    'yellow',
    'green',
  ]);
  expect(all(document, 'rect').map((r) => r.getAttribute('stroke'))).toEqual([
    'blue',
    'blue',
    'green',
  ]);
});

// ---------------------------------------------------------------- whitelist

it('[AC-F1-06v] removes scripts, events, external references and unknown attributes', () => {
  const { text, document } = clean(
    svg(
      `<script>alert(1)</script><foreignObject><div/></foreignObject><a href="https://x.invalid"><rect/></a>
       <path d="M0 0" onclick="x()" fill="url(https://x.invalid/#g)" stroke="url(#g)" data-x="1" class="k"/>
       <linearGradient id="g" xlink:href="javascript:alert(1)"/><linearGradient id="h" href=" #g"/>
       <rect fill="u\\72l(https://x.invalid)" mask="url(#m) url(//x.invalid)" clip-path="url (#c)"/>`,
      `xmlns:xlink="${XLINK}" onload="x()" xml:base="https://x.invalid/" width="10"`,
    ),
  );
  expect(text).not.toMatch(/script|foreignObject|<a|onload|onclick|invalid|data-x|class=|xml:base/);
  const path = all(document, 'path')[0]!;
  expect(path.hasAttribute('fill')).toBe(false);
  expect(path.getAttribute('stroke')).toBe('url(#g)');
  const [g, h] = all(document, 'linearGradient');
  expect(g!.hasAttributeNS(XLINK, 'href')).toBe(false);
  expect(h!.getAttributeNS(XLINK, 'href')).toBe('#g');
  const rect = all(document, 'rect')[0]!;
  expect(
    rect.hasAttribute('fill') || rect.hasAttribute('mask') || rect.hasAttribute('clip-path'),
  ).toBe(false);
  expect(document.documentElement!.getAttribute('width')).toBe('10');
});

it('[AC-F1-06v] output is deterministic, attribute order is fixed and a second pass is a no-op', () => {
  const first = clean(svg('<title>a &amp; b</title><rect y="2" x="1" fill="red"/>')).text;
  const second = clean(svg('<title>a &amp; b</title><rect fill="red" x="1" y="2"/>')).text;
  expect(first).toBe(second);
  const again = ok(inspect(first));
  expect(new TextDecoder().decode(again.bytes)).toBe(first);
  expect(again.sanitized).toBe(false);
});

// ---------------------------------------------------------------- limits

it('[AC-F1-06v] element limit counts expanded copies and the root', () => {
  expect(ok(inspect(svg('<rect/>'.repeat(4999)))).ok).toBe(true);
  expect(rejected(svg('<rect/>'.repeat(5000)))).toBe('icon_svg_unconvertible');
  const many = svg(
    `<defs><g id="m">${'<rect/>'.repeat(1000)}</g></defs>${'<use href="#m"/>'.repeat(5)}`,
  );
  expect(rejected(many)).toBe('icon_svg_unconvertible');
});

it('[AC-F1-06v] eight use hops pass, nine are rejected; doubling chains stop early', () => {
  const chain = (depth: number, doubled: boolean): string => {
    let defs = '<path id="n0" d="M0 0"/>';
    for (let n = 1; n < depth; n++) {
      defs += `<g id="n${n}"><use href="#n${n - 1}"/>${doubled ? `<use href="#n${n - 1}"/>` : ''}</g>`;
    }
    return svg(`<defs>${defs}</defs><use href="#n${depth - 1}"/>`);
  };
  expect(ok(inspect(chain(8, false))).ok).toBe(true);
  expect(rejected(chain(9, false))).toBe('icon_svg_unconvertible');
  const remainingMs = vi.fn(() => 2000);
  expect(rejected(chain(30, true), options(204800, remainingMs))).toBe('icon_svg_unconvertible');
  // Source, style and output passes poll once per element each; copies stay within 5000.
  expect(remainingMs.mock.calls.length).toBeLessThan(15000);
});

it('[AC-F1-06v] output limit is four times maxBytes in UTF-8 bytes, inclusive', () => {
  const source = svg(
    `<defs><g id="t"><title>${'标'.repeat(100)}</title></g></defs>${'<use href="#t"/>'.repeat(10)}`,
  );
  const length = ok(inspect(source)).bytes.byteLength;
  const exact = Math.floor(length / 4);
  const fits = length % 4 === 0 ? exact : exact + 1;
  expect(ok(inspect(source, options(fits))).bytes.byteLength).toBe(length);
  expect(rejected(source, options(Math.ceil(length / 4) - 1))).toBe('icon_svg_unconvertible');
});

it('[AC-F1-06v] the deadline is polled per element and expiry stops at once', () => {
  let calls = 0;
  const remainingMs = vi.fn(() => (++calls < 5 ? 1 : 0));
  const source = svg(`<defs><path id="p" d="M0 0"/></defs>${'<use href="#p"/>'.repeat(50)}`);
  expect(rejected(source, options(204800, remainingMs))).toBe('icon_svg_unconvertible');
  expect(remainingMs).toHaveBeenCalledTimes(5);
});

it('[AC-F1-06v] every whitelisted element keeps its geometry, paint and transform attributes', () => {
  const source = svg(
    `<title>品牌</title><desc>d</desc><defs>
      <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1 2)" spreadMethod="pad"><stop offset="0.5" stop-color="#123" stop-opacity="0.8"/></linearGradient>
      <radialGradient id="rg" cx="5" cy="6" r="4" fx="2" fy="3"/>
      <clipPath id="c" clipPathUnits="userSpaceOnUse"><rect x="1" y="2" width="3" height="4" rx="1" ry="2"/></clipPath>
      <mask id="m" maskUnits="userSpaceOnUse"><circle cx="1" cy="2" r="3"/></mask></defs>
    <g transform="rotate(5)" opacity="0.7" clip-path="url(#c)" mask="url(#m)">
      <path d="M0 0Z" fill="url(#lg)" stroke="red" stroke-width="2" fill-rule="evenodd"/>
      <ellipse cx="1" cy="2" rx="3" ry="4"/><line x1="1" y1="2" x2="3" y2="4"/>
      <polyline points="1,2 3,4"/><polygon points="0,0 1,0 1,1"/></g>`,
    'viewBox="0 0 32 32" width="32" height="32" preserveAspectRatio="xMidYMid meet"',
  );
  const { document } = clean(source);
  const original = new DOMParser().parseFromString(source, 'image/svg+xml');
  for (const element of all(original)) {
    const output = all(document, element.tagName)[0]!;
    for (const attribute of Array.from(element.attributes)) {
      expect(output.getAttribute(attribute.name), `${element.tagName}.${attribute.name}`).toBe(
        attribute.value,
      );
    }
  }
  expect(all(document, 'title')[0]!.textContent).toBe('品牌');
});

it.each([
  'HTTPS://x.invalid/g.svg#a',
  '\t\n javascript:alert(1)',
  'data:image/svg+xml;base64,PHN2Zy8+',
  '#a b',
  '#a#b',
  "#a'",
])('[AC-F1-06v] non-fragment references are dropped under any href spelling: %j', (reference) => {
  const value = reference
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('\t', '&#9;')
    .replaceAll('\n', '&#10;');
  const { text, document } = clean(
    svg(
      `<linearGradient id="a"/><linearGradient id="p" q:href="${value}"/><linearGradient id="l" q:href="#a"/>
       <path d="M0 0" fill="url('${value.replaceAll("'", '&apos;')}')" stroke="red"/>`,
      `xmlns:q="${XLINK}" href="#a"`,
    ),
  );
  expect(text).not.toMatch(/invalid|javascript|data:/i);
  const [, bad, good] = all(document, 'linearGradient');
  expect(bad!.hasAttributeNS(XLINK, 'href')).toBe(false);
  expect(good!.getAttributeNS(XLINK, 'href')).toBe('#a');
  expect(all(document, 'path')[0]!.hasAttribute('fill')).toBe(false);
  expect(document.documentElement!.hasAttribute('href')).toBe(false);
});

it('[AC-F1-06v] palette PNG with tRNS and transparent corners is accepted', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(512, 0);
  ihdr.writeUInt32BE(512, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const rows = Buffer.alloc(513 * 512);
  rows[513 * 256 + 257] = 1;
  const input = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('PLTE', Buffer.from([0, 0, 0, 255, 0, 0])),
    chunk('tRNS', Buffer.from([0, 255])),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  expect(ok(inspectPlatformIcon(input, options())).sanitized).toBe(false);
});

it('[AC-F1-06v] deep nesting at the element limit converts without exhausting the stack', () => {
  const deep = svg(`${'<g>'.repeat(4998)}<rect/>${'</g>'.repeat(4998)}`);
  expect(all(clean(deep).document, 'g')).toHaveLength(4998);
});

// ---------------------------------------------------------------- round 2: style values in SVG syntax

function styled(declaration: string): Element {
  return all(clean(svg(`<path d="M0 0L1 1" style="${declaration}"/>`)).document, 'path')[0]!;
}

it.each([
  ['translate(10px,20px)', 'translate(10 20)'],
  ['translate(10px, 20px) rotate(45deg)', 'translate(10 20) rotate(45)'],
  ['rotate(45deg)', 'rotate(45)'],
  ['rotate(30 5 5)', 'rotate(30 5 5)'],
  ['skewX(10deg) scale(2,3)', 'skewX(10) scale(2 3)'],
  ['matrix(1,0,0,1,2,3)', 'matrix(1 0 0 1 2 3)'],
  ['translate(2 3)', 'translate(2 3)'],
])('[AC-F1-06v] CSS transform %s is rewritten in SVG transform-list syntax', (css, attribute) => {
  expect(styled(`transform: ${css}`).getAttribute('transform')).toBe(attribute);
});

it.each([
  'translateX(10px)',
  'translateY(1px)',
  'scaleX(2)',
  'translate(10%, 0)',
  'translate(1em, 0)',
  'rotate(1rad)',
  'rotate(0.5turn)',
  'rotate(45deg 5 5)',
  'scale(2px)',
  'skew(10deg)',
  'translate3d(1px,1px,0)',
  'none',
  'translate(1px',
])('[AC-F1-06v] CSS transform without a faithful SVG form is unconvertible: %s', (css) => {
  expect(rejected(svg(`<path d="M0 0" style="transform: ${css}"/>`))).toBe(
    'icon_svg_unconvertible',
  );
  expect(rejected(svg(`<style>.t{transform:${css}}</style><path class="t" d="M0 0"/>`))).toBe(
    'icon_svg_unconvertible',
  );
});

it.each([
  ['fill', 'currentColor'],
  ['fill', 'none'],
  ['fill', 'rgb(255, 0, 0)'],
  ['fill', 'rgb(100%,0%,0%)'],
  ['fill', 'url(#g) none'],
  ['fill', 'url(#g) #fff'],
  ['stroke', 'darkslategray'],
  ['stroke-width', '2px'],
  ['stroke-width', '1.5'],
  ['stroke-width', '10%'],
  ['stroke-dasharray', '2px, 3'],
  ['stroke-dasharray', 'none'],
  ['stroke-miterlimit', '1'],
  ['opacity', '.5'],
  ['fill-rule', 'nonzero'],
  ['stroke-linecap', 'square'],
  ['stroke-linejoin', 'miter'],
  ['fill', 'inherit'],
])('[AC-F1-06v] style value with the same SVG meaning is kept: %s: %s', (name, value) => {
  const source = `<defs><linearGradient id="g"/></defs><path d="M0 0L1 1" style="${name}: ${value}"/>`;
  expect(all(clean(svg(source)).document, 'path')[0]!.getAttribute(name)).toBe(value);
});

it.each([
  ['fill', 'rgba(0,0,0,0.5)'],
  ['fill', 'hsl(0, 100%, 50%)'],
  ['fill', '#ff000080'],
  ['fill', 'RED'],
  ['fill', 'notacolor'],
  ['fill', 'transparent'],
  ['fill', 'red blue'],
  ['stroke', 'url(#g) url(#g)'],
  ['stop-color', 'none'],
  ['stroke-width', '2rem'],
  ['stroke-width', '-1'],
  ['stroke-width', '2vw'],
  ['stroke-dasharray', '2 -3'],
  ['stroke-miterlimit', '0.5'],
  ['opacity', '50%'],
  ['fill-opacity', 'half'],
  ['stroke-linejoin', 'arcs'],
  ['stroke-linecap', 'ROUND'],
  ['fill-rule', 'odd'],
])('[AC-F1-06v] style value SVG would read differently is unconvertible: %s: %s', (name, value) => {
  const tag = name.startsWith('stop-') ? 'stop' : 'path';
  expect(
    rejected(
      svg(
        `<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><${tag} style="${name}: ${value}"/>`,
      ),
    ),
  ).toBe('icon_svg_unconvertible');
});

// ---------------------------------------------------------------- round 2: interlaced and 16-bit PNG

function rawPng(
  ihdrFields: {
    width: number;
    height: number;
    depth: number;
    colorType: number;
    interlace: number;
  },
  inflated: Buffer,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ihdrFields.width, 0);
  ihdr.writeUInt32BE(ihdrFields.height, 4);
  ihdr[8] = ihdrFields.depth;
  ihdr[9] = ihdrFields.colorType;
  ihdr[12] = ihdrFields.interlace;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(inflated)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const INTERLACED = { width: 512, height: 512, depth: 8, colorType: 6, interlace: 1 } as const;

it('[AC-F1-06v] inflated size follows the Adam7 pass layout', () => {
  expect(inflatedSize(8, 8, 32, false)).toBe(264);
  expect(inflatedSize(8, 8, 32, true)).toBe(5 + 5 + 9 + 18 + 34 + 68 + 132);
  expect(inflatedSize(1, 1, 8, true)).toBe(2);
  expect(inflatedSize(3, 1, 1, true)).toBe(2 + 2 + 2);
});

it('[AC-F1-06v] interlaced PNG of exactly its Adam7 size is decoded and accepted', () => {
  const input = rawPng(INTERLACED, Buffer.alloc(inflatedSize(512, 512, 32, true)));
  expect(ok(inspectPlatformIcon(input, options())).format).toBe('png');
});

it.each([
  ['one byte over', () => inflatedSize(512, 512, 32, true) + 1],
  ['decompression bomb', () => 64 * 1024 * 1024],
])(
  '[AC-F1-06v] interlaced PNG inflating past its size is rejected before pngjs: %s',
  (_n, size) => {
    const input = rawPng(INTERLACED, Buffer.alloc(size()));
    expect(input.length).toBeLessThan(204800);
    const read = vi.spyOn(pngjs.PNG.sync, 'read');
    try {
      expect(inspectPlatformIcon(input, options())).toEqual({
        ok: false,
        reason: 'icon_format_invalid',
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  },
);

it('[AC-F1-06v] interlace method other than 0 / 1 is format-invalid', () => {
  const input = rawPng({ ...INTERLACED, interlace: 2 }, Buffer.alloc(16));
  expect(inspectPlatformIcon(input, options())).toEqual({
    ok: false,
    reason: 'icon_format_invalid',
  });
});

function rgba16(cornerAlpha: number): Buffer {
  const stride = 1 + 512 * 8;
  const rows = Buffer.alloc(stride * 512);
  // Opaque centre pixel; top-left corner alpha set to the raw 16-bit value under test.
  rows.writeUInt16BE(0xffff, stride * 256 + 1 + 256 * 8 + 6);
  rows.writeUInt16BE(cornerAlpha, 1 + 6);
  return rawPng({ width: 512, height: 512, depth: 16, colorType: 6, interlace: 0 }, rows);
}

it('[AC-F1-06v] 16-bit RGBA PNG with raw corner alpha 0 is accepted', () => {
  expect(ok(inspectPlatformIcon(rgba16(0), options())).sanitized).toBe(false);
});

it.each([1, 128, 0xffff])(
  '[AC-F1-06v] 16-bit RGBA PNG corner alpha is judged unscaled: raw %i is rejected',
  (alpha) => {
    expect(inspectPlatformIcon(rgba16(alpha), options())).toEqual({
      ok: false,
      reason: 'icon_format_invalid',
    });
  },
);

// ---------------------------------------------------------------- use under clipPath

function clipChildren(document: Document): Element[] {
  const clip = all(document, 'clipPath')[0]!;
  return Array.from(clip.childNodes).filter((node): node is Element => node.nodeType === 1);
}

it('[AC-F1-06v] use under clipPath is expanded without a g: offset merged into the shape', () => {
  const { document } = clean(
    svg(
      '<defs><rect id="r" width="4" height="4"/></defs>' +
        '<clipPath id="c"><use href="#r" x="5"/></clipPath><path d="M0 0H9V9z" clip-path="url(#c)"/>',
    ),
  );
  const children = clipChildren(document);
  expect(children.map((child) => child.localName)).toEqual(['rect']);
  expect(children[0]!.getAttribute('transform')).toBe('translate(5 0)');
  expect(children[0]!.getAttribute('width')).toBe('4');
  expect(children[0]!.hasAttribute('id')).toBe(false);
  expect(all(document, 'g')).toHaveLength(0);
});

it('[AC-F1-06v] clipPath use: use transform and offset precede the shape transform', () => {
  const { document } = clean(
    svg(
      '<defs><rect id="r" width="4" height="4" transform="rotate(45)"/></defs>' +
        '<clipPath id="c"><use href="#r" x="1" y="2" transform="scale(2)"/></clipPath>',
    ),
  );
  const [rect] = clipChildren(document);
  expect(rect!.getAttribute('transform')).toBe('scale(2) translate(1 2) rotate(45)');
});

it('[AC-F1-06v] clipPath use of a group flattens each shape, nested uses included', () => {
  const { document } = clean(
    svg(
      '<defs><circle id="dot" r="1"/>' +
        '<g id="pair" transform="translate(10 0)" clip-rule="evenodd">' +
        '<rect width="2" height="2"/><g><use href="#dot" y="3"/></g><title>t</title></g></defs>' +
        '<clipPath id="c"><use href="#pair" x="5" clip-rule="nonzero"/><rect width="1" height="1"/></clipPath>',
    ),
  );
  const children = clipChildren(document);
  expect(children.map((child) => child.localName)).toEqual(['rect', 'circle', 'rect']);
  expect(children[0]!.getAttribute('transform')).toBe('translate(5 0) translate(10 0)');
  expect(children[1]!.getAttribute('transform')).toBe(
    'translate(5 0) translate(10 0) translate(0 3)',
  );
  // The inner g's clip-rule wins over the outer use's, as inheritance would give.
  expect(children[0]!.getAttribute('clip-rule')).toBe('evenodd');
  expect(children[1]!.getAttribute('clip-rule')).toBe('evenodd');
  expect(children[2]!.hasAttribute('transform')).toBe(false);
  expect(all(document, 'g').filter((g) => g.parentNode?.nodeName === 'clipPath')).toHaveLength(0);
});

it('[AC-F1-06v] clipPath use: the shape keeps its own inherited property and display none drops', () => {
  const { document } = clean(
    svg(
      '<defs><rect id="r" width="4" height="4" clip-rule="evenodd"/></defs>' +
        '<clipPath id="c"><use href="#r" clip-rule="nonzero"/><use href="#r" display="none"/></clipPath>',
    ),
  );
  const children = clipChildren(document);
  expect(children).toHaveLength(1);
  expect(children[0]!.getAttribute('clip-rule')).toBe('evenodd');
  expect(children[0]!.hasAttribute('transform')).toBe(false);
});

it('[AC-F1-06v] use outside clipPath still expands into a g', () => {
  const { document } = clean(
    svg(
      '<defs><rect id="r" width="4" height="4"/></defs><mask id="m"><use href="#r" x="5"/></mask>',
    ),
  );
  const mask = all(document, 'mask')[0]!;
  expect(mask.firstChild?.nodeName).toBe('g');
  expect((mask.firstChild as Element).getAttribute('transform')).toBe('translate(5 0)');
});

it.each([
  ['clip-path on the use', '<use href="#r" clip-path="url(#o)"/>', ''],
  ['mask on a referenced group', '<use href="#g"/>', ''],
  ['malformed use transform', '<use href="#r" transform="rotate(1 2)"/>', ''],
  ['unparseable shape transform', '<use href="#bad"/>', ''],
  ['cycle through the flattening', '<use href="#loop"/>', ''],
  ['external reference', '<use href="other.svg#r"/>', ''],
])('[AC-F1-06v] clipPath use that needs a group is unconvertible: %s', (_name, use) => {
  const source = svg(
    '<defs><rect id="r" width="4" height="4"/><clipPath id="o"><rect width="1" height="1"/></clipPath>' +
      '<g id="g" mask="url(#o)"><rect width="1" height="1"/></g>' +
      '<rect id="bad" width="1" height="1" transform="translate(1px)"/>' +
      '<g id="loop"><use href="#loop"/></g></defs>' +
      `<clipPath id="c">${use}</clipPath>`,
  );
  expect(rejected(source)).toBe('icon_svg_unconvertible');
});

it('[AC-F1-06v] clipPath flattening polls the deadline and counts copies', () => {
  let calls = 0;
  const source = svg(
    `<defs><g id="many">${'<rect width="1" height="1"/>'.repeat(10)}</g></defs><clipPath id="c"><use href="#many"/></clipPath>`,
  );
  clean(
    source,
    options(204800, () => {
      calls += 1;
      return 2000;
    }),
  );
  const baseline = calls;
  expect(baseline).toBeGreaterThan(10);
  const limited = svg(
    `<defs><g id="many">${'<rect width="1" height="1"/>'.repeat(600)}</g></defs><clipPath id="c">${'<use href="#many"/>'.repeat(9)}</clipPath>`,
  );
  expect(rejected(limited)).toBe('icon_svg_unconvertible');
});
