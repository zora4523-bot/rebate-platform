// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const repository = new URL('../../../../', moduleUrl);

// The brief names the package-level HTML, which does not yet exist. Also cover the
// three HTML files actually built by apps/h5/vite.config.ts: a declaration in an
// unused package-level file alone must not leave the shipped entries unchanged.
const entries = [
  'apps/h5/src/entries/app/index.html',
  'apps/h5/src/entries/landing/index.html',
  'apps/h5/src/entries/conformance/index.html',
] as const;

for (const [index, entry] of entries.entries()) {
  it(`[AC-F1-01r-META#${index + 1}] ${entry} 在 head 中声明支持浅色和深色`, () => {
    const file = new URL(entry, repository);
    // Missing HTML must fail the declaration assertion, not throw ENOENT during
    // collection or import (the red phase accepts assertion failures only).
    const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const html = new DOMParser().parseFromString(source, 'text/html');
    const declarations = Array.from(html.head.querySelectorAll('meta[name]'))
      .filter((meta) => meta.getAttribute('name')?.toLowerCase() === 'color-scheme')
      .map((meta) => meta.getAttribute('content')?.trim().split(/\s+/));

    // Parsing the head excludes comments, script text and body-only declarations;
    // checking the entire list rejects conflicting duplicate declarations too.
    expect(declarations, `${entry}: <meta name="color-scheme" content="light dark">`).toEqual([
      ['light', 'dark'],
    ]);
  });
}
