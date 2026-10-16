import { expect, it, vi } from 'vitest';
import {
  bytes,
  clean,
  elements,
  inspect,
  options,
  parse,
  rendered,
  success,
  svg,
  xml,
} from './kit.ts';

it.each([5000, 5001])(
  '[AC-F1-06v#39] accumulated element limit includes the svg root: %i',
  (count) => {
    const source = svg('<rect width="1" height="1"/>'.repeat(count - 1));
    const result = inspect(source);
    if (count === 5000) {
      const output = success(result, bytes(source));
      expect(elements(parse(output.bytes))).toHaveLength(5000);
    } else {
      expect(result).toEqual({ ok: false, reason: 'icon_svg_unconvertible' });
    }
  },
);

function chain(depth: number, doubled = false): string {
  let definitions = '<path id="n0" d="M0 0L1 1"/>';
  for (let n = 1; n < depth; n++) {
    definitions += `<g id="n${n}"><use href="#n${n - 1}"/>${doubled ? `<use href="#n${n - 1}"/>` : ''}</g>`;
  }
  return svg(`<defs>${definitions}</defs><use href="#n${depth - 1}"/>`);
}

it.each([8, 9])(
  '[AC-F1-06v#40] reference nesting allows eight use hops, rejects nine: %i',
  (depth) => {
    const source = chain(depth);
    const result = inspect(source);
    if (depth === 8) {
      const document = parse(success(result, bytes(source)).bytes);
      expect(rendered(document, 'path').map((p) => p.getAttribute('d'))).toEqual(['M0 0L1 1']);
      expect(elements(document, 'use')).toHaveLength(0);
    } else {
      expect(result).toEqual({ ok: false, reason: 'icon_svg_unconvertible' });
    }
  },
);

it('[AC-F1-06v#41] ordinary group nesting does not consume the use-reference depth budget', () => {
  const document = clean(
    svg('<g>'.repeat(12) + '<rect width="1" height="1"/>' + '</g>'.repeat(12)),
  );
  expect(elements(document, 'rect')).toHaveLength(1);
});

it('[AC-F1-06v#42] fixed 30-level doubling reference sample is rejected without fully expanding it', () => {
  const source = chain(30, true);
  const remainingMs = vi.fn(() => 2000);
  // Guard against copying a complete exponential subtree before checking the budget.
  const originalClone = xml.Node.prototype.cloneNode;
  let copiedElements = 0;
  const clone = vi.spyOn(xml.Node.prototype, 'cloneNode').mockImplementation(function (
    this: Node,
    deep?: boolean,
  ) {
    if (this.nodeType === 1) {
      copiedElements += 1 + (deep ? (this as Element).getElementsByTagName('*').length : 0);
      expect(copiedElements).toBeLessThanOrEqual(10000);
    }
    return originalClone.call(this, deep);
  });
  try {
    expect(inspect(source, { ...options(), deadline: { remainingMs } })).toEqual({
      ok: false,
      reason: 'icon_svg_unconvertible',
    });
    expect(copiedElements).toBeLessThanOrEqual(10000);
  } finally {
    clone.mockRestore();
  }
});

it('[AC-F1-06v#43] expanded copies count toward the limit, even with only one reference hop', () => {
  const source = svg(
    `<defs><g id="many">${'<rect width="1" height="1"/>'.repeat(700)}</g></defs>${'<use href="#many"/>'.repeat(20)}`,
  );
  // 700 source shapes, but 14,000 rendered copies: comfortably below the upload-size limit.
  expect(bytes(source).length).toBeLessThan(options().maxBytes);
  const originalClone = xml.Node.prototype.cloneNode;
  let copiedElements = 0;
  const clone = vi.spyOn(xml.Node.prototype, 'cloneNode').mockImplementation(function (
    this: Node,
    deep?: boolean,
  ) {
    if (this.nodeType === 1) {
      copiedElements += 1 + (deep ? (this as Element).getElementsByTagName('*').length : 0);
      // Allow an initial document copy; still reject implementations that build all 14,000.
      expect(copiedElements).toBeLessThanOrEqual(10000);
    }
    return originalClone.call(this, deep);
  });
  try {
    expect(inspect(source)).toEqual({ ok: false, reason: 'icon_svg_unconvertible' });
    expect(copiedElements).toBeLessThanOrEqual(10000);
  } finally {
    clone.mockRestore();
  }
});

function expandedSample(padding: number): string {
  const path = 'M0 0' + 'L1 1'.repeat(1000);
  return svg(
    `<title>${'x'.repeat(padding)}</title><defs><path id="long" d="${path}"/></defs>${'<use href="#long"/>'.repeat(50)}`,
  );
}

it.each([0, 1])(
  '[AC-F1-06v#44] conversion byte limit: output at four times maxBytes plus %i',
  (extra) => {
    // Use the deterministic serializer's length, avoiding a prescribed whitespace/quoting style.
    // A one-byte title pad lets us choose an output length congruent to 0 or 1 modulo four.
    let chosen: { source: string; length: number } | undefined;
    for (let pad = 1; pad <= 4; pad++) {
      const source = expandedSample(pad);
      const output = success(inspect(source), bytes(source));
      expect(rendered(parse(output.bytes), 'path')).toHaveLength(50);
      if (output.bytes.byteLength % 4 === extra) {
        chosen = { source, length: output.bytes.byteLength };
        break;
      }
    }
    expect(chosen).toBeDefined();
    const { source, length } = chosen!;
    const maxBytes = (length - extra) / 4;
    expect(bytes(source).length).toBeLessThan(maxBytes);
    const result = inspect(source, options(maxBytes));
    if (extra === 0) {
      expect(success(result, bytes(source)).bytes.byteLength).toBe(maxBytes * 4);
    } else {
      expect(result).toEqual({ ok: false, reason: 'icon_svg_unconvertible' });
    }
  },
);

it('[AC-F1-06v#45] output budget uses UTF-8 bytes, not JavaScript character count', () => {
  const source = svg(
    `<defs><g id="text"><title>${'标'.repeat(1000)}</title><rect width="1" height="1"/></g></defs>${'<use href="#text"/>'.repeat(20)}`,
  );
  const output = success(inspect(source), bytes(source));
  const characterLength = new TextDecoder().decode(output.bytes).length;
  const maxBytes = Math.ceil(characterLength / 4);
  expect(bytes(source).length).toBeLessThan(maxBytes);
  expect(output.bytes.length).toBeGreaterThan(maxBytes * 4);
  expect(inspect(source, options(maxBytes))).toEqual({
    ok: false,
    reason: 'icon_svg_unconvertible',
  });
});

it('[AC-F1-06v#46] an expired injected conversion deadline rejects the entire SVG', () => {
  const remainingMs = vi.fn(() => -1);
  expect(
    inspect(svg('<rect width="1" height="1"/>'), { ...options(), deadline: { remainingMs } }),
  ).toEqual({
    ok: false,
    reason: 'icon_svg_unconvertible',
  });
  expect(remainingMs).toHaveBeenCalled();
});

it('[AC-F1-06v#47] a deadline that expires after conversion starts is checked again and stops work', () => {
  const remainingMs = vi.fn().mockReturnValueOnce(2000).mockReturnValue(-1);
  const source = svg(
    '<defs><rect id="r" width="1" height="1"/></defs>' + '<use href="#r"/>'.repeat(200),
  );
  const originalClone = xml.Node.prototype.cloneNode;
  let copiesAfterExpiry = 0;
  const clone = vi.spyOn(xml.Node.prototype, 'cloneNode').mockImplementation(function (
    this: Node,
    deep?: boolean,
  ) {
    // No copying may continue after the injected deadline reported expiration.
    if (remainingMs.mock.results.some((call) => call.value === -1)) copiesAfterExpiry++;
    return originalClone.call(this, deep);
  });
  try {
    expect(inspect(source, { ...options(), deadline: { remainingMs } })).toEqual({
      ok: false,
      reason: 'icon_svg_unconvertible',
    });
    expect(remainingMs).toHaveBeenCalledTimes(2);
    expect(copiesAfterExpiry).toBe(0);
  } finally {
    clone.mockRestore();
  }
});

it('[AC-F1-06v#48] a positive remaining deadline permits a valid conversion', () => {
  const source = svg('<rect width="1" height="1"/>');
  const remainingMs = vi.fn(() => 1);
  success(inspect(source, { ...options(), deadline: { remainingMs } }), bytes(source));
  expect(remainingMs).toHaveBeenCalled();
});
