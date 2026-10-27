// B2-11a (static): production W1 writes the snapshot. Every createWithdrawApply(…) of the assembly
// sources passes riskFlags, built by createWithdrawRiskFlags (exported through payout's index.ts).
// Reads the sources only; the behaviour is in apply.int.test.ts.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** The argument text of every `name(…)` call, parentheses balanced. */
function calls(text: string, name: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = start;
    while (end < text.length && depth > 0) {
      const ch = text[end];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      end += 1;
    }
    found.push(text.slice(start, end - 1));
  }
  return found;
}

const APP_MODULE = '../../../../apps/api/src/app.module.ts';
const PAYOUT_MODULE = '../../../../apps/api/src/modules/payout/payout.module.ts';
const PAYOUT_INDEX = '../../../../apps/api/src/modules/payout/index.ts';

it('[AC-B2-11a#10] 装配源码中每个 createWithdrawApply 调用都带 riskFlags，且由 createWithdrawRiskFlags 构造', () => {
  const texts = [APP_MODULE, PAYOUT_MODULE].map((path) => ({ path, text: source(path) }));
  const applies = texts.flatMap(({ path, text }) =>
    calls(text, 'createWithdrawApply').map((call) => ({ path, call })),
  );
  expect(applies.length).toBeGreaterThan(0);
  for (const { path, call } of applies) {
    expect(call, `${path}: createWithdrawApply(${call})`).toMatch(/\briskFlags\b/);
  }
  const builders = texts.flatMap(({ text }) => calls(text, 'createWithdrawRiskFlags'));
  expect(builders.length).toBeGreaterThan(0);
  expect(source(PAYOUT_INDEX)).toMatch(
    /export\s*\{[^}]*\bcreateWithdrawRiskFlags\b[^}]*\}\s*from\s*'\.\/application\/withdraw-risk-flags\.ts'/,
  );
});
