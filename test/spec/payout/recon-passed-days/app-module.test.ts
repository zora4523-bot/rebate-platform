// B2-07d (编排裁定 D10-392, D10-408; task brief §9.1 §9.3): app.module hands the BR-WDR-30 开启前置检查
// the real reconciliation port from payout's index.ts instead of D10-392's default that always
// answers 0. The behaviour through the admin entry is wiring.int.test.ts's; here only the source
// (read as text: the rule-test build stays free of Nest's decorators).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(`../../../../apps/api/src/${path}`, import.meta.url), 'utf8');
}

it('[AC-B2-07d#17] payout 的 index.ts 导出真实端口 createReconPassedDays，app.module 经它取用并替换恒 0 的缺省端口', () => {
  expect(source('modules/payout/index.ts')).toMatch(
    /export\s*\{[^}]*\bcreateReconPassedDays\b[^}]*\}\s*from\s*'\.\/application\/recon-passed-days\.ts'/u,
  );
  const app = source('app.module.ts');
  const payoutImports = [
    ...app.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/modules\/payout\/index\.ts'/gu),
  ].map((match) => match[1] ?? '');
  expect(payoutImports.some((names) => /\bcreateReconPassedDays\b/u.test(names))).toBe(true);
  expect(app).toMatch(/\bcreateReconPassedDays\(/u);
  expect(app).not.toMatch(/\bcreateDefaultReconPassedDays\(/u);
});
