import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createDefaultInviteCodeFilter } from '../../../../apps/api/src/modules/identity/application/registration.ts';

it('[BR-INV-01] 默认过滤器使用非空种子词表，按 invite_code 场景不分大小写子串命中', () => {
  // Invoke the shell before reading the not-yet-implemented seed asset: valid NotImplemented red.
  const filter = createDefaultInviteCodeFilter();
  // Implementation creates this asset; a missing file becomes an assertion, never ENOENT red.
  let content = '';
  try {
    content = readFileSync(
      new URL('../../../../specs/sensitive-words.invite-code.txt', import.meta.url),
      'utf8',
    );
  } catch {
    /* the explicit assertion below reports a missing seed */
  }
  const words = content
    .split(/\r?\n/)
    .map((word) => word.trim())
    .filter((word) => word && !word.startsWith('#'));
  expect(words.length).toBeGreaterThan(0);
  expect(content).toMatch(/替换|replace/i);
  for (const word of words) {
    expect(filter.matches('invite_code', `2${word.toLowerCase()}9`)).toBe(true);
    expect(filter.matches('invite_code', `2${word.toUpperCase()}9`)).toBe(true);
  }
  const clean = ['234567', '89ABCD', 'EFGHJK', 'LMNPQR', 'STUVWX', 'YZ2345'].find((code) =>
    words.every((word) => !code.toLowerCase().includes(word.toLowerCase())),
  );
  expect(clean, '种子词库不应拒绝所有正常候选').toBeDefined();
  expect(filter.matches('invite_code', clean!)).toBe(false);
  expect(filter.matches('invite_code', '')).toBe(false);
}, 30_000);
