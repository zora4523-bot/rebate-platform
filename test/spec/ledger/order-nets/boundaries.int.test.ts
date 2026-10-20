import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getOrderNets } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  TIMEOUT,
  account,
  close,
  entry,
  fixture,
  key,
  open,
  transfer,
  voucher,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-04h#9] app_id 与 order_key 精确隔离，归属不解析 uniq_key、biz_id 或 memo', async () => {
  const f = await fixture(h.db);
  // Quotes and LIKE metacharacters are ordinary order-key data.
  f.orderKey = `${f.orderKey}:'_%`;
  const misleadingKey = `other-order:${f.other.owner_id}:direct:REWARD`;
  await transfer(h.db, f, f.receivable, f.user, 61n, {
    ...key(f, 'CREDIT'),
    uniq_key: misleadingKey,
    biz_id: 'not-this-order',
    memo: 'not attribution metadata',
  });
  await transfer(h.db, f, f.receivable, f.revenue, 12n, { voucher_kind: 'CREDIT' });
  for (const orderKey of [`${f.orderKey}:child`, null]) {
    await transfer(h.db, f, f.receivable, f.user, 1000n, {
      ...key(f, 'CREDIT'),
      order_key: orderKey,
      uniq_key: `${f.orderKey}:${f.user.owner_id}:self:CREDIT:${String(orderKey)}`,
      biz_id: f.orderKey,
      memo: f.orderKey,
    });
    await transfer(h.db, f, f.receivable, f.revenue, 2000n, {
      voucher_kind: 'FORFEIT',
      order_key: orderKey,
    });
  }
  const otherApp = await fixture(h.db);
  const sameUser = await account(h.db, { app_id: otherApp.appId, owner_id: f.user.owner_id });
  const foreignScope = { appId: otherApp.appId, orderKey: f.orderKey };
  await transfer(h.db, foreignScope, otherApp.receivable, sameUser, 3000n, {
    ...key(f, 'CREDIT'),
    uniq_key: misleadingKey,
  });
  await transfer(h.db, foreignScope, otherApp.receivable, otherApp.revenue, 4000n, {
    voucher_kind: 'CREDIT',
  });
  const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(result).toEqual({
    beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 61n }],
    platform_net_fen: 12n,
    union_receivable_net_fen: 73n,
  });
});

it('[AC-B2-04h#10] 受益人净额只归集其自身账户，包含两子户及历史会计日', async () => {
  const f = await fixture(h.db);
  const v = await voucher(h.db, {
    app_id: f.appId,
    order_key: f.orderKey,
    accounting_date: '2020-01-01',
    ...key(f, 'CREDIT'),
  });
  await entry(h.db, f.receivable, v, 67n, { booked_at: '2020-01-01T00:00:00Z' });
  await entry(h.db, f.user, v, -41n, { booked_at: '2020-01-01T00:00:00Z' });
  await entry(h.db, f.user, v, -19n, {
    sub_account: 'frozen',
    booked_at: '2020-01-01T00:00:00Z',
  });
  // A different account on the same voucher must not be assigned to the beneficiary key.
  await entry(h.db, f.other, v, -7n, { booked_at: '2020-01-01T00:00:00Z' });
  const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(result).toEqual({
    beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 60n }],
    platform_net_fen: 0n,
    union_receivable_net_fen: 67n,
  });
});

it('[AC-B2-04h#11] 只读口径保留异常负净额，不把历史过扣截断为零', async () => {
  const f = await fixture(h.db);
  await transfer(h.db, f, f.receivable, f.user, 10n, key(f, 'CREDIT'));
  await transfer(h.db, f, f.user, f.receivable, 15n, key(f, 'CLAWBACK'), {
    ledger_type: 'CLAWBACK',
    sub_type: 'FULL',
  });
  const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(result).toEqual({
    beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: -5n }],
    platform_net_fen: 0n,
    union_receivable_net_fen: -5n,
  });
});
