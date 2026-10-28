// B2-06f: the payout_attempts port B2-05e left as a stub ("until B2-06 app.module hands in a port that
// reports none") reads the real table through payout's own store, and the stub's note is gone.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../../../apps/api/src/${path}`, import.meta.url), 'utf8');

it('[AC-B2-06f#22] forWorker 的 attempts 端口是真实读取，B2-05e 留下的桩说明已删除', () => {
  const module = read('modules/payout/payout.module.ts');
  expect(module).not.toMatch(/until B2-06\b/);
  expect(module).not.toMatch(/reports none/);
  const app = read('app.module.ts');
  expect(app).toMatch(/PayoutModule\.forWorker\(\{[^}]*attempts:\s*createPayoutAttemptsStore\(\)/s);
});
