// Placeholder check until the package is implemented: each entry exports only its own name.
import { expect, it } from 'vitest';
import * as conformance from './index.conformance.ts';
import * as entry from './index.ts';

it('exports exactly the workspace package name', () => {
  expect(Object.keys(entry)).toEqual(['PACKAGE_NAME']);
  expect(entry.PACKAGE_NAME).toBe('@couli/bridge-sdk');
});

it('exports exactly the conformance subpath name from the conformance entry', () => {
  expect(Object.keys(conformance)).toEqual(['ENTRY_NAME']);
  expect(conformance.ENTRY_NAME).toBe('@couli/bridge-sdk/conformance');
});
