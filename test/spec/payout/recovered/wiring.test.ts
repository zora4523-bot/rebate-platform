// B2-05k ⑦ (static): every ledger that books on the payout paths gets payout's recovery port.
// Reads the assembly sources only; the connected check is assembly.int.test.ts.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** The argument text of every `createLedger(…)` call, parentheses balanced. */
function createLedgerCalls(text: string): string[] {
  const calls: string[] = [];
  for (const match of text.matchAll(/\bcreateLedger\s*\(/g)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = start;
    while (end < text.length && depth > 0) {
      const ch = text[end];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      end += 1;
    }
    calls.push(text.slice(start, end - 1));
  }
  return calls;
}

const APP_MODULE = '../../../../apps/api/src/app.module.ts';
const PAYOUT_MODULE = '../../../../apps/api/src/modules/payout/payout.module.ts';
const PAYOUT_INDEX = '../../../../apps/api/src/modules/payout/index.ts';

it('[AC-B2-05k#7] 源码里每个带 eventBus 的 createLedger 调用（apply、went-negative 消费者）都带 balanceRecoveredHook', () => {
  const files = [APP_MODULE, PAYOUT_MODULE].map((path) => ({ path, text: source(path) }));
  const withBus = files.flatMap(({ path, text }) =>
    createLedgerCalls(text)
      .filter((call) => /\beventBus\b/.test(call))
      .map((call) => ({ path, call })),
  );
  expect(withBus.length).toBeGreaterThan(0);
  for (const { path, call } of withBus) {
    expect(call, `${path}: createLedger(${call})`).toMatch(/\bbalanceRecoveredHook\b/);
  }
  // The port is payout's public surface (cross-module use only through index.ts).
  expect(source(PAYOUT_INDEX)).toMatch(
    /export\s*\{[^}]*\bcreateBalanceRecoveredHook\b[^}]*\}\s*from\s*'\.\/application\/balance-recovered\.ts'/,
  );
});
