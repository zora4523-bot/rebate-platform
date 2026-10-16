import { expect, it } from 'vitest';
import { XLINK_NS, clean, elements, inspect, point, presentation, rendered, svg } from './kit.ts';

it.each(['href', 'xlink:href'])(
  '[AC-F1-06v#18] fixed normal sample: expands %s and class styles without changing geometry or color',
  (href) => {
    const document = clean(
      svg(
        `
      <style>.brand { fill: #ef3340; stroke: #102030; stroke-width: 2; }</style>
      <defs><g id="mark"><rect class="brand" x="1" y="2" width="10" height="12"/></g></defs>
      <use ${href}="#mark" x="3" y="4" transform="scale(2)"/>
    `,
        `xmlns:xlink="${XLINK_NS}" viewBox="0 0 32 32"`,
      ),
    );
    const rectangles = rendered(document, 'rect');
    expect(rectangles).toHaveLength(1);
    const rectangle = rectangles[0]!;
    expect(rectangle.getAttribute('width')).toBe('10');
    expect(rectangle.getAttribute('height')).toBe('12');
    expect(
      point(rectangle, Number(rectangle.getAttribute('x')), Number(rectangle.getAttribute('y'))),
    ).toEqual([8, 12]);
    expect(point(rectangle, 11, 14)).toEqual([28, 36]);
    expect(presentation(rectangle, 'fill')).toBe('#ef3340');
    expect(presentation(rectangle, 'stroke')).toBe('#102030');
    expect(presentation(rectangle, 'stroke-width')).toBe('2');
    expect(document.documentElement.getAttribute('viewBox')).toBe('0 0 32 32');
    expect(elements(document, 'use')).toHaveLength(0);
    expect(elements(document, 'style')).toHaveLength(0);
  },
);

it('[AC-F1-06v#19] nested and repeated use instances remain independent, preserving inherited fill and translations', () => {
  const document = clean(
    svg(`
    <defs>
      <rect id="shape" x="1" y="2" width="5" height="6"/>
      <g id="shift"><use href="#shape" x="7" y="8"/></g>
    </defs>
    <use href="#shift" x="10" y="20" fill="red"/>
    <use href="#shift" x="30" y="40" fill="blue"/>
  `),
  );
  const rectangles = rendered(document, 'rect');
  expect(rectangles).toHaveLength(2);
  expect(
    rectangles.map((r) => point(r, Number(r.getAttribute('x')), Number(r.getAttribute('y')))),
  ).toEqual([
    [18, 30],
    [38, 50],
  ]);
  expect(rectangles.map((r) => presentation(r, 'fill'))).toEqual(['red', 'blue']);
  expect(elements(document, 'use')).toHaveLength(0);
});

it('[AC-F1-06v#20] a forward local reference is expanded, not silently dropped', () => {
  const document = clean(svg('<use href="#later"/><defs><path id="later" d="M1 2L3 4"/></defs>'));
  expect(rendered(document, 'path').map((p) => p.getAttribute('d'))).toEqual(['M1 2L3 4']);
});

it.each([
  ['self cycle', '<defs><g id="a"><use href="#a"/></g></defs><use href="#a"/>'],
  [
    'indirect cycle',
    '<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/>',
  ],
  ['missing target', '<use href="#missing"/>'],
  ['external target', '<use href="https://invalid.example/mark.svg#x"/>'],
  ['relative target', '<use href="other.svg#x"/>'],
  [
    'external xlink target',
    `<use xmlns:xlink="${XLINK_NS}" xlink:href="//invalid.example/x.svg#mark"/>`,
  ],
])(
  '[AC-F1-06v#21] impossible faithful use conversion rejects the whole document: %s',
  (_name, body) => {
    expect(inspect(svg(`<rect width="10" height="10"/>${body}`))).toEqual({
      ok: false,
      reason: 'icon_svg_unconvertible',
    });
  },
);

const declarations = [
  ['fill', '#123456'],
  ['stroke', '#654321'],
  ['stroke-width', '2'],
  ['stroke-linecap', 'round'],
  ['stroke-linejoin', 'bevel'],
  ['stroke-miterlimit', '4'],
  ['stroke-dasharray', '2 3'],
  ['opacity', '0.8'],
  ['fill-opacity', '0.6'],
  ['stroke-opacity', '0.7'],
  ['fill-rule', 'evenodd'],
  ['clip-rule', 'evenodd'],
  ['stop-color', '#abcdef'],
  ['stop-opacity', '0.5'],
  ['transform', 'translate(2 3)'],
] as const;

it.each(declarations)(
  '[AC-F1-06v#22] converts allowed inline declaration %s to a presentation attribute',
  (name, value) => {
    const tag = name.startsWith('stop-') ? 'stop' : 'path';
    const source =
      tag === 'stop'
        ? `<defs><linearGradient id="g"><stop offset="0" style="${name}: ${value};"/></linearGradient></defs>`
        : `<path d="M0 0L10 10" style="${name}: ${value};"/>`;
    const document = clean(svg(source));
    const element = elements(document, tag)[0]!;
    expect(element.getAttribute(name)).toBe(value);
    expect(element.hasAttribute('style')).toBe(false);
  },
);

it.each(declarations)(
  '[AC-F1-06v#23] converts allowed stylesheet declaration %s',
  (name, value) => {
    const tag = name.startsWith('stop-') ? 'stop' : 'path';
    const body =
      tag === 'stop'
        ? '<defs><linearGradient id="g"><stop class="paint" offset="0"/></linearGradient></defs>'
        : '<path class="paint" d="M0 0L10 10"/>';
    const document = clean(svg(`<style>.paint { ${name}: ${value}; }</style>${body}`));
    expect(elements(document, tag)[0]!.getAttribute(name)).toBe(value);
    expect(elements(document, 'style')).toHaveLength(0);
  },
);

it('[AC-F1-06v#24] simple element, class, id and inline cascade preserve specificity and source order', () => {
  const document = clean(
    svg(`
    <style>
      #winner { fill: red; }
      .brand { fill: blue; stroke: red; }
      rect { fill: green; stroke: green; }
      .brand { stroke: blue; }
    </style>
    <rect id="winner" class="brand" width="1" height="1"/>
    <rect id="inline" class="brand" width="2" height="2" fill="black" style="fill: yellow;"/>
    <rect id="class" class="brand" width="3" height="3" fill="black"/>
    <rect id="element" width="4" height="4"/>
  `),
  );
  const rectangles = elements(document, 'rect');
  expect(rectangles.map((r) => r.getAttribute('fill'))).toEqual(['red', 'yellow', 'blue', 'green']);
  expect(rectangles.map((r) => r.getAttribute('stroke'))).toEqual([
    'blue',
    'blue',
    'blue',
    'green',
  ]);
  expect(rectangles.every((r) => !r.hasAttribute('style'))).toBe(true);
});

it('[AC-F1-06v#25] repeated inline declarations use the last declaration and preserve group inheritance', () => {
  const document = clean(
    svg('<g style="fill: red; fill: blue; stroke: black;"><path d="M0 0L2 2"/></g>'),
  );
  const path = elements(document, 'path')[0]!;
  expect(presentation(path, 'fill')).toBe('blue');
  expect(presentation(path, 'stroke')).toBe('black');
});

it.each([
  ['unsupported property', '.paint { position: absolute; }'],
  ['unsupported unused rule', '.unused { display: none; }'],
  ['descendant selector', 'g path { fill: red; }'],
  ['child selector', 'g > path { fill: red; }'],
  ['attribute selector', '[id="p"] { fill: red; }'],
  ['pseudo selector', 'path:hover { fill: red; }'],
  ['compound selector', 'path.paint { fill: red; }'],
  ['media rule', '@media screen { path { fill: red; } }'],
  ['import rule', '@import url("https://invalid.example/a.css");'],
  ['external URL', '.paint { fill: url(https://invalid.example/g.svg#x); }'],
])(
  '[AC-F1-06v#26] rejects unconvertible stylesheet without returning a partial icon: %s',
  (_name, stylesheet) => {
    expect(
      inspect(
        svg(
          `<rect width="1" height="1"/><style>${stylesheet}</style><path class="paint" d="M0 0"/>`,
        ),
      ),
    ).toEqual({
      ok: false,
      reason: 'icon_svg_unconvertible',
    });
  },
);

it.each([
  'display: none;',
  'filter: blur(1px);',
  'fill: url(https://invalid.example/g.svg#x);',
  'stroke: url(//invalid.example/x);',
  'fill: url(data:image/svg+xml;base64,PHN2Zy8+);',
  'fill: url(other.svg#x);',
])('[AC-F1-06v#27] unsupported inline styles reject the whole document: %s', (style) => {
  expect(inspect(svg(`<path d="M0 0L1 1" style="${style}"/>`))).toEqual({
    ok: false,
    reason: 'icon_svg_unconvertible',
  });
});

it.each(['style="fill: url(#paint);"', 'class="painted"'])(
  '[AC-F1-06v#28] local paint-server references survive style conversion: %s',
  (attribute) => {
    const document = clean(
      svg(`<defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient></defs>
      <style>.painted { fill: url('#paint'); }</style><path d="M0 0L2 2" ${attribute}/>`),
    );
    expect(elements(document, 'path')[0]!.getAttribute('fill')).toMatch(
      /^url\(\s*['"]?#paint['"]?\s*\)$/,
    );
    expect(elements(document, 'style')).toHaveLength(0);
  },
);
