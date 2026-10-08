import { themeFromTokens, type DesignTokens } from '@couli/ui-tokens';
import { expect, it } from 'vitest';

const probe = 'f1-01o-pollution-probe';
const dangerous = ['constructor', 'prototype', '__proto__'];
const cases = dangerous.flatMap((segment) => [
  { name: `${segment} 分组`, path: ['color', segment, probe], forbiddenPath: `color.${segment}` },
  { name: `${segment} 叶子`, path: ['color', segment], forbiddenPath: `color.${segment}` },
]);
cases.push(
  {
    name: 'Object.prototype 分组',
    path: ['constructor', 'prototype', probe],
    forbiddenPath: 'constructor',
  },
  {
    name: 'Function.prototype 分组',
    path: ['constructor', 'constructor', 'prototype', probe],
    forbiddenPath: 'constructor',
  },
);

it.each(cases)(
  '[AC-F1-01o-THEME#1] 拒绝 $name，报告危险路径且不修改 Object 或原型链',
  ({ path, forbiddenPath }) => {
    // Computed own keys preserve __proto__ as input data, not object-literal prototype syntax.
    let branch: Record<string, unknown> = { type: 'color', value: '#123ABC' };
    for (const segment of [...path].reverse()) branch = { [segment]: branch };
    const input: DesignTokens = {
      schemaVersion: '1',
      metadata: { version: 'test', cssFontBase: 16 },
      tokens: branch,
    };
    const snapshots = [Object, Object.prototype as object, Function.prototype as object].map(
      (target) => ({
        target,
        descriptors: Object.getOwnPropertyDescriptors(target),
        prototype: Object.getPrototypeOf(target) as object | null,
      }),
    );
    let error: unknown;
    try {
      try {
        themeFromTokens(input);
      } catch (caught) {
        error = caught;
      }
      // Soft checks inspect pollution even if the expected rejection is missing.
      expect.soft(error).toBeInstanceOf(Error);
      expect.soft(error).not.toBeInstanceOf(TypeError);
      const message = error instanceof Error ? error.message : '';
      expect.soft(message).toMatch(/^design tokens: /);
      expect.soft(message).toContain(forbiddenPath);
      for (const { target, descriptors, prototype } of snapshots) {
        expect.soft(Object.getOwnPropertyDescriptors(target)).toEqual(descriptors);
        expect.soft(Object.getPrototypeOf(target)).toBe(prototype);
      }
    } finally {
      // The red implementation really writes globals; restore them even after assertion failure.
      for (const { target, descriptors, prototype } of snapshots) {
        for (const key of Reflect.ownKeys(target)) {
          if (!Object.hasOwn(descriptors, key)) Reflect.deleteProperty(target, key);
        }
        Object.defineProperties(target, descriptors);
        Object.setPrototypeOf(target, prototype);
      }
    }
    expect(
      themeFromTokens({
        ...input,
        tokens: { color: { brand: { type: 'color', value: '#123ABC' } } },
      }),
    ).toEqual({ color: { brand: 'var(--color-brand)' } });
  },
);
