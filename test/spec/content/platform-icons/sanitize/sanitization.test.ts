import { expect, it } from 'vitest';
import { inspectPlatformIcon } from '../../../../../apps/api/src/modules/content/domain/platform-icon/index.ts';
import { XLINK_NS, bytes, clean, elements, inspect, options, parse, success, svg } from './kit.ts';

it('[AC-F1-06v#29] fixed hostile sample loses script and every external reference but keeps safe artwork', () => {
  const source = svg(
    `
    <script>alert('unsafe')</script>
    <image href="https://invalid.example/pixel.png"/>
    <path id="safe" d="M0 0L10 10" fill="url(https://invalid.example/paint.svg#g)" stroke="blue"/>
    <rect width="10" height="10" onload="alert(1)"/>
    <defs><linearGradient id="g" xlink:href="//invalid.example/g.svg#x"/></defs>
  `,
    `xmlns:xlink="${XLINK_NS}"`,
  );
  const result = success(inspect(source), bytes(source));
  const document = parse(result.bytes);
  expect(result.sanitized).toBe(true);
  expect(elements(document, 'script')).toHaveLength(0);
  expect(elements(document, 'image')).toHaveLength(0);
  expect(elements(document, 'path')[0]!.getAttribute('d')).toBe('M0 0L10 10');
  expect(elements(document, 'path')[0]!.getAttribute('stroke')).toBe('blue');
  expect(elements(document, 'path')[0]!.hasAttribute('fill')).toBe(false);
  expect(elements(document, 'linearGradient')[0]!.hasAttribute('xlink:href')).toBe(false);
  for (const element of elements(document)) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name).not.toMatch(/^on/i);
      if (!attribute.name.startsWith('xmlns'))
        expect(attribute.value).not.toMatch(/https?:|\/\/invalid/);
    }
  }
});

it.each([
  'script',
  'foreignObject',
  'image',
  'a',
  'animate',
  'animateTransform',
  'set',
  'font',
  'font-face',
  'iframe',
  'unknown',
])('[AC-F1-06v#30] removes non-whitelisted element %s', (tag) => {
  const document = clean(
    svg(`<${tag} href="https://invalid.example/x"/><rect width="7" height="8"/>`),
  );
  expect(elements(document, tag)).toHaveLength(0);
  expect(elements(document, 'rect')[0]!.getAttribute('width')).toBe('7');
});

it('[AC-F1-06v#31] all seventeen whitelisted drawing elements and their meaningful geometry survive', () => {
  const source = svg(
    `
    <title>品牌</title><desc>描述</desc>
    <defs>
      <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1 2)">
        <stop offset="0.5" stop-color="#123456" stop-opacity="0.8"/>
      </linearGradient>
      <radialGradient id="rg" cx="5" cy="6" r="4" fx="2" fy="3"/>
      <clipPath id="clip"><rect x="1" y="2" width="10" height="12" rx="2" ry="3"/></clipPath>
      <mask id="mask"><circle cx="5" cy="6" r="4"/></mask>
    </defs>
    <g transform="translate(1 2)" opacity="0.7">
      <path d="M0 0L10 10Z" fill="url(#lg)" stroke="red" stroke-width="2"/>
      <ellipse cx="3" cy="4" rx="1" ry="2"/>
      <line x1="1" y1="2" x2="3" y2="4"/>
      <polyline points="1,2 3,4"/><polygon points="0,0 1,0 1,1"/>
    </g>
  `,
    'viewBox="0 0 32 32" width="32" height="32" preserveAspectRatio="xMidYMid meet"',
  );
  const document = clean(source);
  expect(
    elements(document)
      .map((e) => e.localName)
      .sort(),
  ).toEqual(
    [
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
    ].sort(),
  );
  const original = parse(bytes(source));
  for (const originalElement of elements(original)) {
    const actual = elements(document, originalElement.tagName)[0]!;
    for (const attribute of Array.from(originalElement.attributes)) {
      expect(
        actual.getAttribute(attribute.name),
        `${originalElement.tagName}.${attribute.name}`,
      ).toBe(attribute.value);
    }
  }
  expect(elements(document, 'title')[0]!.textContent).toBe('品牌');
  expect(elements(document, 'desc')[0]!.textContent).toBe('描述');
});

it('[AC-F1-06v#32] removes event, arbitrary, style and XML base attributes', () => {
  const document = clean(
    svg(
      '<rect width="2" height="3" onload="bad()" onClick="bad()" data-external="https://invalid.example" xml:base="https://invalid.example/" style="fill: red;"/>',
    ),
  );
  const rectangle = elements(document, 'rect')[0]!;
  for (const name of ['onload', 'onClick', 'data-external', 'xml:base', 'style']) {
    expect(rectangle.hasAttribute(name), name).toBe(false);
  }
  expect(rectangle.getAttribute('fill')).toBe('red');
});

it.each(['href', 'xlink:href'])(
  '[AC-F1-06v#33] deletes external %s on retained gradients while preserving a local gradient link',
  (name) => {
    const document = clean(
      svg(
        `<defs>
      <linearGradient id="base"><stop offset="0" stop-color="red"/></linearGradient>
      <linearGradient id="local" ${name}="#base"/>
      <linearGradient id="remote" ${name}="https://invalid.example/g.svg#base"/>
    </defs>`,
        `xmlns:xlink="${XLINK_NS}"`,
      ),
    );
    const gradients = elements(document, 'linearGradient');
    const local = gradients.find((e) => e.getAttribute('id') === 'local')!;
    expect(local.getAttribute('href') || local.getAttribute('xlink:href')).toBe('#base');
    const remote = gradients.find((e) => e.getAttribute('id') === 'remote')!;
    expect(remote.hasAttribute('href')).toBe(false);
    expect(remote.hasAttribute('xlink:href')).toBe(false);
  },
);

it.each([
  'url(https://invalid.example/p.svg#x)',
  "url(' //invalid.example/p.svg#x ')",
  'url(other.svg#x)',
  'url(data:image/svg+xml;base64,PHN2Zy8+)',
  'url(javascript:alert(1))',
  'url(&#104;ttps://invalid.example/p.svg#x)',
  'URL(https://invalid.example/p.svg#x)',
  'url(#local) url(https://invalid.example/p.svg#x)',
  'url(\\68 ttps://invalid.example/p.svg#x)',
  'u\\72l(https://invalid.example/p.svg#x)',
])(
  '[AC-F1-06v#34] normalizes address references before removing the entire unsafe attribute: %s',
  (value) => {
    const document = clean(svg(`<path d="M0 0L1 1" fill="${value}" stroke="red"/>`));
    const path = elements(document, 'path')[0]!;
    expect(path.hasAttribute('fill')).toBe(false);
    expect(path.getAttribute('stroke')).toBe('red');
    expect(path.getAttribute('d')).toBe('M0 0L1 1');
  },
);

it.each(['fill', 'stroke', 'clip-path', 'mask', 'filter'])(
  '[AC-F1-06v#35] address filtering applies to %s, not just href',
  (name) => {
    const document = clean(
      svg(`<rect width="2" height="3" ${name}="url(https://invalid.example/a.svg#x)"/>`),
    );
    expect(elements(document, 'rect')[0]!.hasAttribute(name)).toBe(false);
  },
);

it('[AC-F1-06v#36] normalized local fill, stroke, clip-path and mask references remain usable', () => {
  const document = clean(
    svg(`<defs>
    <linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient>
    <clipPath id="c"><rect width="3" height="3"/></clipPath>
    <mask id="m"><rect width="3" height="3" fill="white"/></mask>
  </defs><path d="M0 0L3 3" fill="url( '#g' )" stroke="url(&quot;#g&quot;)" clip-path="url(#c)" mask="url(#m)"/>`),
  );
  const path = elements(document, 'path')[0]!;
  for (const [attribute, id] of [
    ['fill', 'g'],
    ['stroke', 'g'],
    ['clip-path', 'c'],
    ['mask', 'm'],
  ]) {
    expect(path.getAttribute(attribute!)).toMatch(
      new RegExp(`^url\\(\\s*['"]?#${id}['"]?\\s*\\)$`),
    );
  }
});

it('[AC-F1-06v#37] output is deterministic, hashes cleaned bytes and never mutates input', () => {
  const source = svg('<path stroke="red" d="M0 0L1 1" fill="blue"/><script>bad()</script>');
  const input = bytes(source);
  const before = Uint8Array.from(input);
  const first = success(inspectPlatformIcon(input, options()), input);
  const second = success(inspectPlatformIcon(input, options()), input);
  expect(first.bytes).toEqual(second.bytes);
  expect(first.sha256).toBe(second.sha256);
  expect(first.sanitized).toBe(true);
  expect(input).toEqual(before);
  const roundTrip = success(inspect(new TextDecoder().decode(first.bytes)), first.bytes);
  expect(roundTrip.bytes).toEqual(first.bytes);
  expect(roundTrip.sanitized).toBe(false);
});

it('[AC-F1-06v#38] serializer fixes attribute order independently of the original order', () => {
  const first = svg('<rect x="1" y="2" width="3" height="4" fill="red"/>');
  const second = svg('<rect fill="red" height="4" width="3" y="2" x="1"/>');
  expect(success(inspect(first), bytes(first)).bytes).toEqual(
    success(inspect(second), bytes(second)).bytes,
  );
});
