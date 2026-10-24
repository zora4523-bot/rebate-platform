import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('[AC-B1-27j#6] app.module 的注销读口改用 payout 的 hasSucceeded，删掉写死的 false 与 TODO', () => {
  const source = readFileSync(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url),
    'utf8',
  );
  expect(source).toMatch(/createWithdrawalInFlightReader\s*\(/);
  expect(source).not.toContain('blocked on payout 提供成功提现读口');
  expect(source).not.toMatch(
    /hasSucceeded\s*[:(][^\n]*(?:Promise\.resolve\(\s*false\s*\)|=>\s*(?:\{\s*return\s+)?false\b)/,
  );
});
