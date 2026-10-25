import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  recommendDailyCheckActions,
  type DailyCheckFinding,
} from '../../../../apps/api/src/modules/ledger/application/daily-check-advice.ts';
import type {
  DailyCheckResult,
  LedgerInvariantFile,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { APP, DAY, OTHER, TIMEOUT, inDatabase, setup } from '../daily-check/kit.ts';

// Fixture invariant sources only (no db/invariants/ledger/pay-*.sql): the advice depends on the
// file name, so each case names its own files and controls exactly which of them differ.
const ACCOUNT = '00000000-0000-4000-8000-0000000002f0';

type Scope = 'account' | 'global';
const SCOPES: readonly Scope[] = ['account', 'global'];

/** One row per difference in the unified invariant output (B2-02j). */
function differing(
  name: string,
  code: string,
  differences: readonly { scope: Scope; appId?: string }[],
): LedgerInvariantFile {
  const rows = differences.map(
    (
      d,
      index,
    ) => `SELECT '${code}'::text AS invariant, ${differences.length}::bigint AS checked_rows,
      '${d.scope}'::text AS scope, '${d.appId ?? APP}'::text AS app_id,
      ${d.scope === 'account' ? `'${ACCOUNT}'::uuid` : 'NULL::uuid'} AS account_id,
      jsonb_build_object('fixture', '${name}', 'row', ${index}) AS detail`,
  );
  return { name, sql: rows.join('\nUNION ALL\n') };
}

/** The clean sentinel: checkedRows inspected, nothing reported. */
function clean(name: string, code: string, checkedRows = 1): LedgerInvariantFile {
  return {
    name,
    sql: `SELECT '${code}'::text AS invariant, ${checkedRows}::bigint AS checked_rows,
      'none'::text AS scope, NULL::text AS app_id, NULL::uuid AS account_id, NULL::jsonb AS detail`,
  };
}

interface Checked {
  readonly result: DailyCheckResult;
  readonly differenceLogs: readonly Record<string, unknown>[];
  /** What the runner reported, by file, read back from its difference warnings. */
  readonly findings: readonly DailyCheckFinding[];
}

async function check(files: readonly LedgerInvariantFile[], appId?: string): Promise<Checked> {
  const { runner, logs } = setup({
    async load() {
      return files;
    },
  });
  const results: DailyCheckResult[] = [];
  await inDatabase(createTestDatabase, async (db) => {
    results.push(
      await runner.runDailyCheck(db, {
        accountingDate: DAY,
        ...(appId === undefined ? {} : { appId }),
      }),
    );
  });
  const [result] = results;
  if (result === undefined) throw new Error('daily check returned nothing');
  const differenceLogs = logs
    .filter((l) => l.level === 'warn' && l.fields['event'] === 'ledger_daily_check_difference')
    .map((l) => l.fields);
  const findings = differenceLogs.map((fields) => {
    const file = fields['file'];
    const scope = SCOPES.find((s) => s === fields['scope']);
    if (typeof file !== 'string' || scope === undefined) {
      throw new Error(`difference warning without file or scope: ${JSON.stringify(fields)}`);
    }
    return { file, scope };
  });
  return { result, differenceLogs, findings };
}

it(
  '[AC-B2-02o#1] 只有 pay- 不变量报账户级差异：不建议冻结提现，照常建议差错单、写差异与告警，不关月结',
  async () => {
    const { result, differenceLogs, findings } = await check([
      clean('01_balance.sql', '01'),
      differing('pay-receipts.sql', 'P1', [{ scope: 'account' }]),
    ]);
    expect(result.recommendations).toEqual({
      createDiscrepancies: true,
      freezeWithdrawals: false,
      disableAutoSettlement: false,
    });
    expect(result.checks.map((c) => [c.file, c.invariant, c.checkedRows])).toEqual([
      ['01_balance.sql', '01', 1n],
      ['pay-receipts.sql', 'P1', 1n],
    ]);
    expect(result.accountDifferences).toEqual([
      {
        invariant: 'P1',
        scope: 'account',
        app_id: APP,
        account_id: ACCOUNT,
        detail: { fixture: 'pay-receipts.sql', row: 0 },
      },
    ]);
    expect(result.globalDifferences).toEqual([]);
    expect(differenceLogs).toEqual([
      expect.objectContaining({
        event: 'ledger_daily_check_difference',
        accounting_date: DAY,
        file: 'pay-receipts.sql',
        invariant: 'P1',
        scope: 'account',
        app_id: APP,
        account_id: ACCOUNT,
      }),
    ]);
    expect(recommendDailyCheckActions(findings)).toEqual(result.recommendations);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02o#2] 只有 pay- 不变量报全局差异：不建议冻结提现；差错单与关闭月结建议同改前（全局即关）',
  async () => {
    const { result, differenceLogs, findings } = await check([
      clean('01_balance.sql', '01'),
      differing('pay-suspense.sql', 'P4', [{ scope: 'global' }, { scope: 'global' }]),
    ]);
    expect(result.recommendations).toEqual({
      createDiscrepancies: true,
      freezeWithdrawals: false,
      disableAutoSettlement: true,
    });
    expect(result.accountDifferences).toEqual([]);
    expect(result.globalDifferences).toEqual([
      expect.objectContaining({ invariant: 'P4', scope: 'global', app_id: APP, account_id: null }),
      expect.objectContaining({ invariant: 'P4', scope: 'global', app_id: APP, account_id: null }),
    ]);
    expect(differenceLogs).toEqual([
      expect.objectContaining({ file: 'pay-suspense.sql', invariant: 'P4', scope: 'global' }),
      expect.objectContaining({ file: 'pay-suspense.sql', invariant: 'P4', scope: 'global' }),
    ]);
    expect(recommendDailyCheckActions(findings)).toEqual(result.recommendations);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02o#3] 只有非 pay- 不变量报账户级差异：照旧建议冻结提现与差错单，不关月结',
  async () => {
    const { result, differenceLogs, findings } = await check([
      differing('01_balance.sql', '01', [{ scope: 'account' }]),
      clean('pay-receipts.sql', 'P1'),
    ]);
    expect(result.recommendations).toEqual({
      createDiscrepancies: true,
      freezeWithdrawals: true,
      disableAutoSettlement: false,
    });
    expect(result.accountDifferences).toEqual([
      expect.objectContaining({ invariant: '01', scope: 'account', account_id: ACCOUNT }),
    ]);
    expect(differenceLogs).toEqual([
      expect.objectContaining({ file: '01_balance.sql', invariant: '01', scope: 'account' }),
    ]);
    expect(recommendDailyCheckActions(findings)).toEqual(result.recommendations);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02o#4] 只有非 pay- 不变量报全局差异：照旧三项建议全部为真',
  async () => {
    const { result, findings } = await check([
      differing('02_voucher.sql', '02', [{ scope: 'global' }]),
      clean('pay-receipts.sql', 'P1'),
    ]);
    expect(result.recommendations).toEqual({
      createDiscrepancies: true,
      freezeWithdrawals: true,
      disableAutoSettlement: true,
    });
    expect(recommendDailyCheckActions(findings)).toEqual(result.recommendations);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02o#5] pay- 与非 pay- 同时报差异：建议冻结提现，两边差异与告警都保留',
  async () => {
    const { result, differenceLogs, findings } = await check([
      differing('01_balance.sql', '01', [{ scope: 'account' }]),
      differing('pay-receipts.sql', 'P1', [{ scope: 'account' }]),
    ]);
    expect(result.recommendations).toEqual({
      createDiscrepancies: true,
      freezeWithdrawals: true,
      disableAutoSettlement: false,
    });
    expect(result.accountDifferences.map((d) => d.invariant)).toEqual(['01', 'P1']);
    expect(differenceLogs.map((f) => f['file'])).toEqual(['01_balance.sql', 'pay-receipts.sql']);
    expect(recommendDailyCheckActions(findings)).toEqual(result.recommendations);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02o#6] pay- 全局差异与非 pay- 账户级差异同时出现：冻结提现、差错单、关闭月结都建议',
  async () => {
    const { result, findings } = await check([
      differing('07_negative.sql', '07', [{ scope: 'account' }]),
      differing('pay-suspense.sql', 'P4', [{ scope: 'global' }]),
    ]);
    expect(result.recommendations).toEqual({
      createDiscrepancies: true,
      freezeWithdrawals: true,
      disableAutoSettlement: true,
    });
    expect(recommendDailyCheckActions(findings)).toEqual(result.recommendations);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02o#7] 无差异（含 pay- 空检）时三项建议同改前全为假，空检照常告警',
  async () => {
    const { result, differenceLogs, findings } = await check([
      clean('01_balance.sql', '01'),
      clean('pay-receipts.sql', 'P1', 0),
    ]);
    expect(result.recommendations).toEqual({
      createDiscrepancies: false,
      freezeWithdrawals: false,
      disableAutoSettlement: false,
    });
    expect(result.accountDifferences).toEqual([]);
    expect(result.globalDifferences).toEqual([]);
    expect(result.emptyChecks).toEqual(['P1']);
    expect(differenceLogs).toEqual([]);
    expect(findings).toEqual([]);
    expect(recommendDailyCheckActions(findings)).toEqual(result.recommendations);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02o#8] 只是名字里含 pay 的非 pay- 文件（01_pay-、payout、pay_）照旧建议冻结提现',
  async () => {
    for (const name of ['01_pay-receipts.sql', 'payout-holds.sql', 'pay_receipts.sql']) {
      const { result, findings } = await check([
        differing(name, '09', [{ scope: 'account' }]),
        clean('pay-receipts.sql', 'P1'),
      ]);
      expect(result.recommendations).toEqual({
        createDiscrepancies: true,
        freezeWithdrawals: true,
        disableAutoSettlement: false,
      });
      expect(recommendDailyCheckActions(findings)).toEqual(result.recommendations);
    }
  },
  TIMEOUT * 3,
);

it(
  '[AC-B2-02o#9] 指定 appId 时按过滤后的差异给建议：外应用的非 pay- 差异不使本应用的 pay- 差异变为冻结',
  async () => {
    const { result, differenceLogs, findings } = await check(
      [
        differing('01_balance.sql', '01', [{ scope: 'account', appId: OTHER }]),
        differing('pay-receipts.sql', 'P1', [{ scope: 'account', appId: APP }]),
      ],
      APP,
    );
    expect(result.recommendations).toEqual({
      createDiscrepancies: true,
      freezeWithdrawals: false,
      disableAutoSettlement: false,
    });
    expect(result.accountDifferences).toEqual([
      expect.objectContaining({ invariant: 'P1', app_id: APP }),
    ]);
    expect(differenceLogs.some((f) => f['app_id'] === OTHER)).toBe(false);
    expect(recommendDailyCheckActions(findings)).toEqual(result.recommendations);
  },
  TIMEOUT,
);
