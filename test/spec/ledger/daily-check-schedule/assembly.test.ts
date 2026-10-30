// B2-02q: app.module's assembly of the daily ledger check on the worker entry (task brief §9.3):
// LedgerDailyCheckModule.forWorker gets payout's createWithdrawHolds (through payout/index.ts) as
// the B2-02p hold port and content's createSystemSwitchWriter as its switch port; ledger imports
// neither. The options are captured from forWorker (the module is not built, nothing connects).
// What the ports write is checked against PostgreSQL in ./assembly.int.test.ts.
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { RUN_AT, ROOT, capturedWorkerOptions, rootLogger } from './kit.ts';

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

/** Source text without line and block comments (a mention in a comment is not a call). */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

it('[AC-B2-02q#8] 装配：worker 入口的 app.module 恰调用一次 LedgerDailyCheckModule.forWorker，给出 holds 与 autoSettlement 两个工厂；工厂按 (clock, logger) 造出 B2-02p 的两个端口', async () => {
  const clock = new FixedClock(RUN_AT);
  const { logger } = rootLogger();
  const options = await capturedWorkerOptions(clock, logger);
  expect(options).toMatchObject({
    holds: expect.any(Function),
    autoSettlement: expect.any(Function),
  });
  const holds = options.holds(clock, logger);
  const settle = options.autoSettlement(clock, logger);
  expect(typeof holds.add).toBe('function');
  expect(typeof settle.turnOff).toBe('function');
  expect(typeof settle.alertCommitted).toBe('function');
});

it('[AC-B2-02q#9] 装配（源码）：app.module 用 payout 的 createWithdrawHolds 与 content 的 createSystemSwitchWriter 造端口；ledger 模块自己不导入 payout 或 content', () => {
  const app = code('apps/api/src/app.module.ts');
  expect(app).toMatch(/\bcreateWithdrawHolds\s*\(/u);
  expect(app).toMatch(/\bcreateSystemSwitchWriter\s*\(/u);
  expect(app).toMatch(/\bLedgerDailyCheckModule\.forWorker\s*\(/u);
  const ledger = [
    'apps/api/src/modules/ledger/daily-check.module.ts',
    'apps/api/src/modules/ledger/application/daily-check-schedule.ts',
  ].map(code);
  for (const text of ledger) {
    expect(text).not.toMatch(/from\s+['"][^'"]*modules\/(payout|content)\//u);
    expect(text).not.toMatch(/from\s+['"]\.\.\/(\.\.\/)?(payout|content)\//u);
  }
});
