import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect } from 'vitest';
import {
  inspectPlatformIcon,
  type PlatformIconOptions,
  type PlatformIconResult,
} from '../../../../../apps/api/src/modules/content/domain/platform-icon/index.ts';

// Reuse F1-06q's pinned API dependencies, as in the platform/qrcode rule tests.
export const requireApi = createRequire(
  new URL('../../../../../apps/api/package.json', import.meta.url),
);
export const xml = requireApi('@xmldom/xmldom') as {
  DOMParser: new (options?: { onError: (level: string, message: string) => void }) => {
    parseFromString(source: string, mime: string): Document;
  };
  Node: { prototype: Node };
};
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';
export const MAX_BYTES = 204800;

export function options(maxBytes = MAX_BYTES): PlatformIconOptions {
  return { maxBytes, deadline: { remainingMs: () => 2000 } };
}

export function svg(body: string, attributes = ''): string {
  return `<svg xmlns="${SVG_NS}" ${attributes}>${body}</svg>`;
}

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function inspect(source: string, config = options()): PlatformIconResult {
  return inspectPlatformIcon(bytes(source), config);
}

export function success(
  result: PlatformIconResult,
  original: Uint8Array,
  format: 'svg' | 'png' = 'svg',
): Extract<PlatformIconResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected successful inspection');
  expect(result.bytes).toBeInstanceOf(Uint8Array);
  expect(result.format).toBe(format);
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'));
  expect(result.sanitized).toBe(!Buffer.from(result.bytes).equals(Buffer.from(original)));
  return result;
}

export function clean(source: string, config = options()): Document {
  const output = success(inspect(source, config), bytes(source));
  return parse(output.bytes);
}

export function parse(input: Uint8Array): Document {
  return new xml.DOMParser({
    onError: (level, message) => {
      expect(['error', 'fatalError'], message).not.toContain(level);
    },
  }).parseFromString(new TextDecoder().decode(input), 'image/svg+xml');
}

export function elements(document: Document, name = '*'): Element[] {
  return Array.from(document.getElementsByTagName(name));
}

export function rendered(document: Document, name: string): Element[] {
  return elements(document, name).filter((element) => {
    for (let parent = element.parentNode; parent; parent = parent.parentNode) {
      if (parent.nodeName === 'defs') return false;
    }
    return true;
  });
}

export function presentation(element: Element, name: string): string | null {
  for (let node: Node | null = element; node?.nodeType === 1; node = node.parentNode) {
    const value = (node as Element).getAttribute(name);
    if (value) return value;
  }
  return null;
}

// Compare effective coordinates, allowing either a wrapper or a composed matrix.
// The fixtures only need translation, scale and their matrix equivalents.
export function point(element: Element, x: number, y: number): [number, number] {
  for (let node: Node | null = element; node?.nodeType === 1; node = node.parentNode) {
    const transform = (node as Element).getAttribute('transform') ?? '';
    const terms = [...transform.matchAll(/(matrix|translate|scale)\s*\(([^)]*)\)/g)];
    expect(transform.replace(/(matrix|translate|scale)\s*\([^)]*\)/g, '').trim()).toBe('');
    for (const term of terms.reverse()) {
      const values = term[2]!
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (term[1] === 'translate') {
        x += values[0]!;
        y += values[1] ?? 0;
      } else if (term[1] === 'scale') {
        x *= values[0]!;
        y *= values[1] ?? values[0]!;
      } else {
        expect(values).toHaveLength(6);
        [x, y] = [
          values[0]! * x + values[2]! * y + values[4]!,
          values[1]! * x + values[3]! * y + values[5]!,
        ];
      }
    }
  }
  return [x, y];
}
