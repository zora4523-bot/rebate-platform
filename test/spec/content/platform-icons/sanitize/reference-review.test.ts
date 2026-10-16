import { expect, it } from 'vitest';
import { XLINK_NS, clean, elements, inspect, svg } from './kit.ts';

function attributeValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('\t', '&#9;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;');
}

// Inspect every retained attribute, including namespace aliases and the root.
// Decode CSS escapes so escaped spelling cannot evade the URL assertion.
function expectLocalReferences(document: Document): void {
  for (const element of elements(document)) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      const label = `${element.tagName}.${attribute.name}`;
      const value = attribute.value.replace(
        /\\([0-9a-f]{1,6})[\t\n\r\f ]?|\\([^\r\n\f])/gi,
        (_match, hex: string | undefined, literal: string | undefined) =>
          hex ? String.fromCodePoint(parseInt(hex, 16)) : literal!,
      );
      if ((attribute.localName || attribute.name.split(':').at(-1))?.toLowerCase() === 'href') {
        expect(value, label).toMatch(/^#[^\s#]+$/);
      }
      const urls = [...value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)];
      expect(value.match(/url\s*\(/gi)?.length ?? 0, label).toBe(urls.length);
      for (const url of urls) {
        expect((url[1] ?? url[2] ?? url[3] ?? '').trim(), label).toMatch(/^#[^\s#]+$/);
      }
      expect(attribute.name, label).not.toMatch(/^on/i);
      expect(attribute.name, label).not.toBe('style');
    }
  }
}

const externalReferences = [
  'HTTPS://invalid.example/g.svg#base',
  'JavaScript:alert(1)',
  'javascript:alert(1)',
  'data:image/svg+xml;base64,PHN2Zy8+',
  'a.svg#id',
  '../x',
  '//invalid.example/g.svg#base',
  '  https://invalid.example/g.svg#base',
  '\t\n\rHTTPS://invalid.example/g.svg#base',
  'java\tscript:alert(1)',
];

it.each(externalReferences)(
  '[AC-F1-06v#49] removes every external href namespace spelling and presentation reference: %s',
  (reference) => {
    const document = clean(
      svg(
        `<defs>
          <linearGradient id="base"><stop offset="0" stop-color="red"/></linearGradient>
          <linearGradient id="local" x:href="#base"/>
          ${['href', 'xlink:href', 'x:href']
            .map(
              (name, index) =>
                `<linearGradient id="remote${index}" ${name}="${attributeValue(reference)}"/>`,
            )
            .join('')}
        </defs>
        ${['fill', 'stroke', 'clip-path', 'mask', 'filter']
          .map(
            (name) =>
              `<path id="bad-${name}" d="M0 0L8 8" ${name}="${attributeValue(`url('${reference}')`)}"/>`,
          )
          .join('')}
        <rect width="8" height="8" fill="url(#base)"/>`,
        `xmlns:xlink="${XLINK_NS}" xmlns:x="${XLINK_NS}"`,
      ),
    );
    expectLocalReferences(document);
    const gradients = elements(document, 'linearGradient');
    expect(gradients).toHaveLength(5);
    const local = gradients.find((element) => element.getAttribute('id') === 'local')!;
    expect(
      Array.from(local.attributes)
        .filter((attribute) => attribute.localName === 'href')
        .map((attribute) => attribute.value),
    ).toEqual(['#base']);
    for (const remote of gradients.filter((element) =>
      element.getAttribute('id')?.startsWith('remote'),
    )) {
      expect(
        Array.from(remote.attributes).some((attribute) => attribute.localName === 'href'),
      ).toBe(false);
    }
    expect(elements(document, 'path')).toHaveLength(5);
    for (const path of elements(document, 'path')) {
      const name = path.getAttribute('id')!.slice('bad-'.length);
      expect(path.hasAttribute(name), name).toBe(false);
      expect(path.getAttribute('d')).toBe('M0 0L8 8');
    }
    expect(elements(document, 'rect')[0]!.getAttribute('fill')).toMatch(
      /^url\(\s*['"]?#base['"]?\s*\)$/,
    );
  },
);

it('[AC-F1-06v#50] sanitizes root attributes while retaining geometry and converted safe style', () => {
  const document = clean(
    svg(
      '<rect x="1" y="2" width="3" height="4"/>',
      `xmlns:x="${XLINK_NS}" width="32" height="24" viewBox="0 0 32 24" preserveAspectRatio="xMidYMid meet"
       onload="bad()" onClick="bad()" ONFOCUS="bad()" style="fill: red; stroke: blue;"
       xml:base="https://invalid.example/" href="../x" x:href="HTTPS://invalid.example/x"`,
    ),
  );
  const root = document.documentElement;
  for (const name of ['onload', 'onClick', 'ONFOCUS', 'style', 'xml:base', 'href', 'x:href']) {
    expect(root.hasAttribute(name), name).toBe(false);
  }
  for (const [name, value] of Object.entries({
    width: '32',
    height: '24',
    viewBox: '0 0 32 24',
    preserveAspectRatio: 'xMidYMid meet',
    fill: 'red',
    stroke: 'blue',
  })) {
    expect(root.getAttribute(name), name).toBe(value);
  }
  expect(elements(document, 'rect')).toHaveLength(1);
  expectLocalReferences(document);
});

it.each([
  "url('https://invalid.example/g.svg#base')",
  'url("https://invalid.example/g.svg#base")',
  String.raw`url(\68 ttps://invalid.example/g.svg#base)`,
  String.raw`url('\68 ttps://invalid.example/g.svg#base')`,
  String.raw`url("\68 ttps://invalid.example/g.svg#base")`,
  String.raw`u\72l(https://invalid.example/g.svg#base)`,
])(
  '[AC-F1-06v#51] quoted or CSS-escaped external stylesheet URLs reject the entire icon: %s',
  (value) => {
    expect(
      inspect(
        svg(
          `<rect width="1" height="1"/><style>.brand { fill: ${value}; }</style><path class="brand" d="M0 0L8 8"/>`,
        ),
      ),
    ).toEqual({ ok: false, reason: 'icon_svg_unconvertible' });
  },
);
