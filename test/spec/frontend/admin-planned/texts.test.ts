// F1-06zu (D10-284): the placeholder copy lives with the other shell texts (admin copy stays in
// apps/admin/src/texts, 规划/03 §9), not inline in a page or component.
import { expect, it } from 'vitest';
import { requiredText } from './contract.ts';

it('[AC-F1-06zu-TEXT#1] 「功能开发中」文案登记在 apps/admin/src/texts/shell.ts', () => {
  const source = requiredText('apps/admin/src/texts/shell.ts');
  expect(source).toMatch(/['"`]功能开发中/);
});
