import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import type {
  WalletSummaryDependencies,
  WalletSummaryQuery,
} from '../../../../apps/api/src/modules/ledger/application/wallet-summary.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

export const ZERO: Awaited<ReturnType<WalletSummaryQuery>> = {
  available_fen: 0,
  withdrawable_fen: 0,
  negative_fen: 0,
  frozen_fen: 0,
  estimated_total_fen: 0,
  estimated_fen: 0,
  pending_credit_fen: 0,
  pending_credit_paused_fen: 0,
  next_credit_period: null,
  credit_overdue: false,
  withdrawn_fen: 0,
  risk_paused_reason: null,
  withdraw_enabled: true,
};

export function sources() {
  const clock = new FixedClock('2026-10-23T04:00:00.000Z');
  const readUser = vi
    .fn<WalletSummaryDependencies['pendingEarnings']['readUser']>()
    .mockResolvedValue({
      estimated_fen: 123n,
      pending_credit_fen: 925n,
      pending_credit_paused_fen: 617n,
      next_credit_period: '2026-11',
      credit_overdue: false,
    });
  const readAppTotals = vi
    .fn<WalletSummaryDependencies['pendingEarnings']['readAppTotals']>()
    .mockRejectedValue(new Error('Wallet summary must not read app-wide earnings'));
  const readPaidTotal = vi
    .fn<WalletSummaryDependencies['withdrawals']['readPaidTotal']>()
    .mockResolvedValue(0n);
  const readPauseReason = vi
    .fn<WalletSummaryDependencies['risk']['readPauseReason']>()
    .mockResolvedValue(null);
  const readWithdrawEnabled = vi
    .fn<WalletSummaryDependencies['config']['readWithdrawEnabled']>()
    .mockResolvedValue(true);
  const dependencies: WalletSummaryDependencies = {
    clock,
    pendingEarnings: { readUser, readAppTotals },
    withdrawals: { readPaidTotal },
    risk: { readPauseReason },
    config: { readWithdrawEnabled },
  };
  return {
    dependencies,
    clock,
    readUser,
    readAppTotals,
    readPaidTotal,
    readPauseReason,
    readWithdrawEnabled,
  };
}

export async function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, { get: Record<string, unknown> }>;
      components: { schemas: Record<string, JsonSchema> };
    }>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
}

export async function validateSummary(body: unknown, envelope = false) {
  const doc = await contract();
  const validate = createValidatorCompiler()({
    schema: doc.components.schemas[envelope ? 'WalletSummaryResponse' : 'WalletSummary']!,
    httpPart: 'body',
  });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}
