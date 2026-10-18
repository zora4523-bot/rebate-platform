import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, createRootLogger, type FieldCrypto } from '../../platform/index.ts';
import {
  createPayoutAccountService,
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
