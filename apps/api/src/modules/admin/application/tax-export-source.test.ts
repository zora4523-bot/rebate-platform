import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { RealnameExportIdentity } from '../../identity/index.ts';
import type { TaxExportRow } from '../../payout/index.ts';
import {
  readTaxExportPage,
  TaxRealnameUnreadableError,
  type TaxExportPageInput,
  type TaxExportPorts,
} from './tax-export-source.ts';

const ID_NO = '11010119900101123X';
const PAID_AT = new Date('2026-10-15T04:00:00.000Z');
const USER = '0190d000-0000-7000-8000-000000000001';
const HANDLE = {} as Kysely<DB>;
const INPUT: TaxExportPageInput = {
  appId: 'couli',
  quarter: '2026-Q4',
  masked: true,
  cursor: undefined,
  limit: 500,
};

const ROW: TaxExportRow = {
  withdrawal_id: '0190d000-0000-7000-8000-000000000002',
  user_id: USER,
  income_type: 'SERVICE_FEE',
  amount_fen: 9_007_199_254_740_993n,
  tax_fen: 456n,
  paid_at: PAID_AT,
  masked_account: '138****5678',
  out_biz_no: 'W1',
  payout_channel: 'alipay',
};

function ports(identity: RealnameExportIdentity | undefined): TaxExportPorts {
  return {
    withdrawals: vi.fn(async () => ({ items: [ROW], next_cursor: 'next' })),
    realnames: {
      read: vi.fn(async () => new Map(identity === undefined ? [] : [[USER, identity]])),
    },
  };
}

const identity = (corrected: Date | null = null): RealnameExportIdentity => ({
  name: '张三',
  id_no: ID_NO,
  correctedAfter: () => corrected,
});

it('[AC-B2-08e] masked page: contract column order, whole fen as text, cursor passed on', async () => {
  const page = await readTaxExportPage(ports(identity()), HANDLE, INPUT);
  expect(page.nextCursor).toBe('next');
  expect(page.rows).toEqual([
    [
      '张三',
      '110101********123X',
      'SERVICE_FEE',
      '9007199254740993',
      '456',
      '2026-10-15T12:00:00.000+08:00',
      '138****5678',
      'W1',
      null,
    ],
  ]);
});

it('[AC-B2-08e] full page keeps the ID number and shows the correction instant', async () => {
  const corrected = new Date('2026-10-20T00:00:00.000Z');
  const page = await readTaxExportPage(ports(identity(corrected)), HANDLE, {
    ...INPUT,
    masked: false,
  });
  expect(page.rows[0]?.[1]).toBe(ID_NO);
  expect(page.rows[0]?.[8]).toBe('2026-10-20T08:00:00.000+08:00');
});

it('[AC-B2-08e] a missing real name refuses the page', async () => {
  await expect(readTaxExportPage(ports(undefined), HANDLE, INPUT)).rejects.toBeInstanceOf(
    TaxRealnameUnreadableError,
  );
});

it('[AC-B2-08e] a failing read refuses the page and drops the cause', async () => {
  const failing = ports(identity());
  vi.mocked(failing.realnames.read).mockRejectedValue(new Error(`bad ${ID_NO}`));
  const error = await readTaxExportPage(failing, HANDLE, INPUT).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(TaxRealnameUnreadableError);
  expect(String((error as Error).message)).not.toContain(ID_NO);
  expect((error as Error).cause).toBeUndefined();
});
