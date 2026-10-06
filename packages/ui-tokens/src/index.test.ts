// Placeholder check until the package is implemented: the entry exports only its package name.
import { expect, it } from 'vitest';
import * as entry from './index.ts';

it('exports exactly the workspace package name', () => {
  expect(Object.keys(entry)).toEqual(['PACKAGE_NAME']);
  expect(entry.PACKAGE_NAME).toBe('@couli/ui-tokens');
});
