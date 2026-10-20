import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  LedgerError,
  type LedgerInvariantSource,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { directoryInvariantSource } from '../../../../apps/api/src/modules/ledger/infra/invariant-files.ts';
import { DAY, setup, snapshots } from '../daily-check/kit.ts';
import { TIMEOUT, account, close, context, open, post, snapshot, voucher } from '../posting/kit.ts';

// Exercise the real writer's inputs: one existing snapshot would be overwritten and
// the posted platform entry would create another. An empty database could hide either bug.
async function rejectsEmptySource(source: LedgerInvariantSource): Promise<void> {
  const h = await open(createTestDatabase);
  try {
    const { ledger, appId } = context();
    const a = await account(h.db, ledger, appId);
    await post(h.db, ledger, [a.user_id], voucher(appId, a.account_id, -100n));
    const { runner, logs, clock } = setup(source);
    await h.db
      .insertInto('daily_balances')
      .values({
        app_id: appId,
        account_id: a.account_id,
        sub_account: 'available',
        accounting_date: DAY,
        opening_fen: 0n,
        debit_fen: 0n,
        credit_fen: 0n,
        closing_fen: 0n,
        computed_at: clock.now(),
      })
      .execute();
    const beforeDaily = await snapshots(h.db, appId);
    const beforeLedger = await snapshot(h.db, appId);
    expect(beforeDaily).toHaveLength(1);
    expect(beforeLedger.entries).toHaveLength(2);
    clock.advanceMs(1000);

    const attempt = runner.runDailyCheck(h.db, { appId, accountingDate: DAY });
    await expect(attempt).rejects.toBeInstanceOf(LedgerError);
    await expect(attempt).rejects.toMatchObject({ code: 'DAILY_CHECK_FAILED' });
    expect(await snapshots(h.db, appId)).toEqual(beforeDaily);
    expect(await snapshot(h.db, appId)).toEqual(beforeLedger);
    expect(logs.filter((log) => log.level === 'error')).toEqual([
      {
        level: 'error',
        fields: expect.objectContaining({
          event: 'ledger_daily_check_failed',
          accounting_date: DAY,
        }),
      },
    ]);
  } finally {
    await close(h);
  }
}

it(
  '[AC-B2-02n#1] load 返回空集合必须 DAILY_CHECK_FAILED、记录失败且不新增或覆盖日终快照',
  async () => {
    await rejectsEmptySource({
      async load() {
        return [];
      },
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02n#2] 真实目录的 SQL 全被 superseded 排除后同样拒绝、记录失败且零写入',
  async () => {
    const root = new URL('../../../../.tmp/b2-02n-invariants/', import.meta.url);
    await mkdir(root, { recursive: true });
    const path = await mkdtemp(fileURLToPath(new URL('case-', root)));
    const directory = pathToFileURL(`${path}/`);
    try {
      // A valid read-only sentinel would pass if the source ignored superseded.json.
      await writeFile(
        new URL('01_retired.sql', directory),
        `SELECT '01'::text AS invariant, 0::bigint AS checked_rows,
          'none'::text AS scope, NULL::text AS app_id,
          NULL::uuid AS account_id, NULL::jsonb AS detail`,
      );
      await writeFile(
        new URL('superseded.json', directory),
        JSON.stringify([
          { file: '01_retired.sql', replaced_by: '01_replacement.sql', reason: 'test fixture' },
        ]),
      );
      const source = directoryInvariantSource(directory);
      expect(await source.load()).toEqual([]);
      await rejectsEmptySource(source);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
