// Placeholder check until the app is implemented: the entry exports only its package name, and
// unit tests of this package run in the jsdom environment configured in vitest.config.ts.
import { expect, it } from 'vitest';
import * as entry from './index.ts';

it('exports exactly the workspace package name', () => {
  expect(Object.keys(entry)).toEqual(['PACKAGE_NAME']);
  expect(entry.PACKAGE_NAME).toBe('@couli/h5');
});

it('runs in the jsdom environment', () => {
  expect(navigator.userAgent).toContain('jsdom');
  const node = document.createElement('div');
  node.textContent = '凑狸';
  document.body.append(node);
  expect(node).toBeInstanceOf(HTMLElement);
  expect(document.body.textContent).toContain('凑狸');
});
