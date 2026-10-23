import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, createRootLogger, type FieldCrypto } from '../../platform/index.ts';
import {
  createPayoutAccountService,
  project,
  type CurrentAccount,
  type PayoutAccountConfigPort,
  type SaveAlipayCommand,
} from './payout-account.ts';

// A handle that fails any query: the pre-lock refusals must not touch the database themselves.
function untouchable(): { trx: Transaction<DB>; handle: Kysely<DB> } {
  const handle = new Proxy(
    {},
    {
      get(_target, name) {
        throw new Error(`database touched: ${String(name)}`);
      },
    },
  ) as Kysely<DB>;
  const trx = { withSchema: () => handle } as unknown as Transaction<DB>;
  return { trx, handle };
}

function harness(values: Readonly<Record<string, unknown>>) {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const reads: { appId: string; key: string; handle: unknown }[] = [];
  const config: PayoutAccountConfigPort = {
    configValue(appId, key, handle) {
      reads.push({ appId, key, handle });
      return Promise.resolve(Object.hasOwn(values, key) ? { value: values[key] } : null);
    },
  };
  const service = createPayoutAccountService({
    db: untouchable().handle,
    clock: new FixedClock('2026-10-18T04:00:00.000Z'),
    crypto: {} as FieldCrypto,
    logger,
    blocklist: { check: () => Promise.reject(new Error('blocklist consulted')) },
    config,
  });
  return { service, lines, reads };
}

const command: SaveAlipayCommand = {
  appId: 'app_a',
  userId: '00000000-0000-7000-8000-000000000001',
  alipayLogonId: 'zhang.san@example.com',
  payeeName: '张三',
};

it('[AC-B1-13e] save: the injected port decides payout_methods before any query or lock', async () => {
  const { service, reads } = harness({ 'withdraw.payout_methods': ['bank_card'] });
  const { trx, handle } = untouchable();
  expect(await service.save(trx, { ...command, alipayLogonId: '@' })).toEqual({
    code: 20001,
    data: { fields: ['payout_method'] },
  });
  expect(reads.map((read) => [read.appId, read.key])).toEqual([
    ['app_a', 'withdraw.payout_methods'],
    ['app_a', 'withdraw.payout_account_change_per_month'],
  ]);
  // The port is handed the caller's handle (the transaction), never the pool.
  for (const read of reads) expect(read.handle).toBe(handle);
});

it('[AC-B1-13e] save: an invalid logon id is refused before the lock', async () => {
  const { service } = harness({ 'withdraw.payout_methods': ['alipay'] });
  expect(
    await service.save(untouchable().trx, { ...command, alipayLogonId: '+852 5123 4567' }),
  ).toEqual({ code: 20001, data: { fields: ['alipay_logon_id'], reason: 'phone_invalid' } });
  expect(await service.save(untouchable().trx, { ...command, alipayLogonId: 'a@b@c' })).toEqual({
    code: 20001,
    data: { fields: ['alipay_logon_id'] },
  });
});

it('[AC-B1-13e] save: missing or malformed configuration warns with config_key only', async () => {
  const { service, lines } = harness({
    'withdraw.payout_methods': ['bank_card', 'bank_card'],
    'withdraw.payout_account_change_per_month': 1.5,
  });
  // Malformed methods fall back to the default (alipay open), so the logon check answers.
  expect(await service.save(untouchable().trx, { ...command, alipayLogonId: '@' })).toEqual({
    code: 20001,
    data: { fields: ['alipay_logon_id'] },
  });
  const warnings = lines.filter((line) => line['level'] === 40);
  expect(warnings.map((line) => line['config_key'])).toEqual([
    'withdraw.payout_methods',
    'withdraw.payout_account_change_per_month',
  ]);
  for (const warning of warnings) {
    expect(Object.keys(warning).sort()).toEqual(
      ['config_key', 'entry', 'env', 'level', 'msg', 'pid', 'time'].sort(),
    );
  }
});

// A stand-in for the field cipher: the stored "cipher" is the plain text (masking is what matters).
const plainCrypto = { decrypt: (cipher: string) => cipher } as unknown as FieldCrypto;

const ROW_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a80';

function row(overrides: Partial<CurrentAccount>): CurrentAccount {
  return {
    id: ROW_ID,
    payout_method: 'alipay',
    alipay_hmac: 'hmac-alipay',
    alipay_logon_id_cipher: Buffer.from('13812345678', 'utf8'),
    bank_card_hmac: null,
    bank_card_no_cipher: null,
    bank_name: null,
    payee_name: '张三',
    row_version: 1,
    ...overrides,
  };
}

it('[AC-CT-26c] project: an alipay row carries payout_account_id = the current row id', () => {
  const projected = project(row({}), plainCrypto, 2);
  expect(projected.payout_account_id).toBe(ROW_ID);
  expect(Object.keys(projected).sort()).toEqual(
    [
      'change_remaining_this_month',
      'masked_account',
      'masked_payee_name',
      'payout_account_id',
      'payout_method',
    ].sort(),
  );
  expect(projected.payout_method).toBe('alipay');
  expect(projected.masked_account).not.toContain('12345678');
});

it('[AC-CT-26c] project: a bank-card row carries payout_account_id = the current row id', () => {
  const projected = project(
    row({
      id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a81',
      payout_method: 'bank_card',
      alipay_hmac: null,
      alipay_logon_id_cipher: null,
      bank_card_hmac: 'hmac-card',
      bank_card_no_cipher: Buffer.from('6222000000000009', 'utf8'),
      bank_name: '示例银行',
    }),
    plainCrypto,
    0,
  );
  expect(projected).toMatchObject({
    payout_account_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a81',
    payout_method: 'bank_card',
    bank_name: '示例银行',
    change_remaining_this_month: 0,
  });
  expect(projected.masked_account).not.toContain('6222000000000009');
});
