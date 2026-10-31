// B2-08c rule-test kit, database part (claude-independent; 规划/08 BR-WDR-20; task §9.2 1, §9.3 累计
// 算例 / int). Only *.int.test.ts files call it. Real pieces: PostgreSQL through @couli/db/testing
// (couli_app), content's config_items table read on the caller's handle, identity's
// realname-identity-key port (app.realname as identity's verification / correction leaves it, from
// tax-ytd/kit.ts), tax_ytd rows (as B2-08b's accumulator leaves them) and withdrawals in a chosen
// status with a chosen created_at (INSERT only: no freeze voucher, the calculator reads amounts and
// statuses only). No real person, id number or channel data: every hmac is random hex.
// The factory under test (createFeeTaxCalculator) is called by calculatorOf, which every test calls
// before it seeds anything: red is the skeleton's NotImplemented.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { createRealnameIdentityKeyReader } from '../../../../apps/api/src/modules/identity/ports/realname-identity-key.ts';
import { createFeeTaxCalculator } from '../../../../apps/api/src/modules/payout/application/fee-tax-calculator.ts';
import type {
  FeeTaxCalculator,
  PayoutConfigPort,
} from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import { TAX_KEYS, type recordingLogger } from './kit.ts';

export const TIMEOUT = 60_000;
export const SERVICE_FEE = 'SERVICE_FEE';

/** content's configuration as payout reads it: app.config_items on the caller's handle. */
export const configPort: PayoutConfigPort = {
  async configValue(appId, key, handle) {
    return (
      (await handle
        .withSchema('app')
        .selectFrom('config_items')
        .select(['value', 'version'])
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .executeTakeFirst()) ?? null
    );
  },
};

/** The calculator under test, over configPort and identity's real port. */
export function calculatorOf(logger: ReturnType<typeof recordingLogger>): FeeTaxCalculator {
  return createFeeTaxCalculator({
    config: configPort,
    identityKey: createRealnameIdentityKeyReader(),
    logger,
  });
}

/** A fresh synthetic app id (config_items has no row for it: every key is missing). */
export function newAppId(): string {
  return `taxcalc_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/** One config_items row of the app (insert or overwrite, version + 1). */
export async function setConfig(
  db: Kysely<DB>,
  appId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'synthetic')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value,
      version = app.config_items.version + 1`.execute(db);
}

/** The tax.SERVICE_FEE.* rows given (an omitted key stays missing). */
export async function setTax(
  db: Kysely<DB>,
  appId: string,
  values: { method?: unknown; rate_bp?: unknown; rate_table?: unknown },
): Promise<void> {
  if (values.method !== undefined) await setConfig(db, appId, TAX_KEYS.method, values.method);
  if (values.rate_bp !== undefined) await setConfig(db, appId, TAX_KEYS.rateBp, values.rate_bp);
  if (values.rate_table !== undefined) {
    await setConfig(db, appId, TAX_KEYS.rateTable, values.rate_table);
  }
}

/** A tax_ytd row as B2-08b's accumulator leaves it. */
export async function seedYtd(
  db: Kysely<DB>,
  row: {
    appId: string;
    userId: string;
    year: number;
    identityHmac: string;
    income: bigint;
    withheld: bigint;
  },
): Promise<void> {
  await sql`INSERT INTO app.tax_ytd
    (id, app_id, user_id, year, income_type, identity_hmac, cum_income_fen, cum_withheld_fen,
     continuous_months)
    VALUES (${randomUUID()}, ${row.appId}, ${row.userId}, ${row.year}, ${SERVICE_FEE},
      ${row.identityHmac}, ${row.income}, ${row.withheld}, 0)`.execute(db);
}

export type WithdrawalStatus =
  'PENDING_REVIEW' | 'APPROVED' | 'PAYING' | 'REJECTED' | 'FAILED' | 'PAID_API';

/**
 * A withdrawal of the member in `status`, created at `createdAt` (fee 0, net = amount − tax,
 * alipay, synthetic payee). REJECTED carries a reason, PAID_API a paid_at.
 */
export async function seedWithdrawal(
  db: Kysely<DB>,
  row: {
    appId: string;
    userId: string;
    status: WithdrawalStatus;
    amount: bigint;
    tax: bigint;
    createdAt: Date;
  },
): Promise<string> {
  const id = randomUUID();
  const rejected = row.status === 'REJECTED' ? 'OTHER' : null;
  const paidAt = row.status === 'PAID_API' ? row.createdAt : null;
  await sql`INSERT INTO app.withdrawals
    (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
     payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel,
     reject_reason_code, paid_at, created_at, updated_at)
    VALUES (${id}, ${row.appId}, ${row.userId}, ${row.amount}, 0, ${row.tax},
      ${row.amount - row.tax}, ${SERVICE_FEE}, 'alipay', '合成姓名',
      ${Buffer.from('synthetic-encrypted-account')}, ${randomBytes(32).toString('hex')},
      ${row.status}, ${randomBytes(16).toString('hex')}, 'alipay', ${rejected}, ${paidAt},
      ${row.createdAt}, ${row.createdAt})`.execute(db);
  return id;
}
