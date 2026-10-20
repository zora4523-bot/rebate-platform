import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getOrderNets } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  TIMEOUT,
  close,
  entry,
  fixture,
  key,
  open,
  ordered,
  platform,
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

it('[AC-B2-04h#1] 空订单和没有历史的租户返回空列表及 bigint 零', async () => {
  const f = await fixture(h.db);
  await transfer(h.db, f, f.receivable, f.user, 100n, key(f, 'CREDIT'));
  for (const selection of [
    { ...f, orderKey: `${f.orderKey}:missing` },
    { ...f, appId: `${f.appId}:missing` },
  ]) {
    const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, selection));
    expect(result).toEqual({
      beneficiaries: [],
      platform_net_fen: 0n,
      union_receivable_net_fen: 0n,
    });
  }
});

it('[AC-B2-04h#2] 按受益人和角色分组，分录不因连接重复，平台入账含预留', async () => {
  const f = await fixture(h.db);
  const v = await voucher(h.db, {
    app_id: f.appId,
    order_key: f.orderKey,
    ...key(f, 'CREDIT'),
  });
  await entry(h.db, f.receivable, v, 100n);
  await entry(h.db, f.user, v, -60n);
  await entry(h.db, f.user, v, -40n);
  await transfer(h.db, f, f.receivable, f.user, 200n, key(f, 'CREDIT', 'share'), {
    ledger_type: 'SHARE_CREDIT',
  });
  await transfer(h.db, f, f.receivable, f.user, 300n, key(f, 'CREDIT', 'direct'), {
    ledger_type: 'REFERRAL_CREDIT',
    sub_type: 'DIRECT',
  });
  await transfer(h.db, f, f.receivable, f.user, 400n, key(f, 'CREDIT', 'indirect'), {
    ledger_type: 'REFERRAL_CREDIT',
    sub_type: 'INDIRECT',
  });
  await transfer(h.db, f, f.receivable, f.other, 71n, key(f, 'CREDIT', 'self', f.other));
  await transfer(h.db, f, f.receivable, f.revenue, 520n, { voucher_kind: 'CREDIT' });
  const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(ordered(result)).toEqual(
    ordered({
      beneficiaries: [
        { beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 100n },
        { beneficiary_user_id: f.user.owner_id, role: 'share', net_fen: 200n },
        { beneficiary_user_id: f.user.owner_id, role: 'direct', net_fen: 300n },
        { beneficiary_user_id: f.user.owner_id, role: 'indirect', net_fen: 400n },
        { beneficiary_user_id: f.other.owner_id, role: 'self', net_fen: 71n },
      ],
      platform_net_fen: 520n,
      union_receivable_net_fen: 1591n,
    }),
  );
});

it('[AC-B2-04h#3] 部分扣回、正负补差和申诉补发按代数和取数，平台可为负', async () => {
  const f = await fixture(h.db);
  await transfer(h.db, f, f.receivable, f.user, 400n, key(f, 'CREDIT'));
  await transfer(h.db, f, f.user, f.receivable, 125n, key(f, 'CLAWBACK'), {
    ledger_type: 'CLAWBACK',
    sub_type: 'PART_REFUND',
  });
  await transfer(h.db, f, f.receivable, f.user, 31n, key(f, 'SETTLE_ADJUST'), {
    ledger_type: 'SETTLE_ADJUST',
    sub_type: 'SETTLE_DIFF',
  });
  await transfer(h.db, f, f.user, f.receivable, 7n, key(f, 'SETTLE_ADJUST'), {
    ledger_type: 'SETTLE_ADJUST',
    sub_type: 'PRICE_PROTECT',
  });
  // Appeal payment moves platform revenue to the user without changing receivable.
  await transfer(h.db, f, f.revenue, f.user, 83n, key(f, 'ADMIN_ADJUST'), {
    ledger_type: 'ADMIN_ADJUST',
    sub_type: 'RESTORE',
  });
  const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(result).toEqual({
    beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 382n }],
    platform_net_fen: -83n,
    union_receivable_net_fen: 299n,
  });
});

it('[AC-B2-04h#4] 全额扣回、恢复、再次扣回后保留零净额受益人', async () => {
  const f = await fixture(h.db);
  await transfer(h.db, f, f.receivable, f.user, 400n, key(f, 'CREDIT'));
  await transfer(h.db, f, f.user, f.receivable, 400n, key(f, 'CLAWBACK'), {
    ledger_type: 'CLAWBACK',
    sub_type: 'FULL',
  });
  await transfer(h.db, f, f.receivable, f.user, 400n, key(f, 'ADMIN_ADJUST'), {
    ledger_type: 'ADMIN_ADJUST',
    sub_type: 'RESTORE',
  });
  await transfer(h.db, f, f.user, f.receivable, 400n, key(f, 'CLAWBACK'), {
    ledger_type: 'CLAWBACK',
    sub_type: 'FULL',
  });
  const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(result).toEqual({
    beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 0n }],
    platform_net_fen: 0n,
    union_receivable_net_fen: 0n,
  });
});

it('[AC-B2-04h#5] 改记坏账的扣回与负差计入受益人，归平台正差和没收不计入', async () => {
  const f = await fixture(h.db);
  await transfer(h.db, f, f.receivable, f.user, 500n, key(f, 'CREDIT'));
  await transfer(h.db, f, f.debt, f.receivable, 40n, key(f, 'CLAWBACK'), {
    ledger_type: 'CLAWBACK',
    sub_type: 'PART_REFUND',
  });
  await transfer(h.db, f, f.debt, f.receivable, 60n, key(f, 'SETTLE_ADJUST'), {
    ledger_type: 'SETTLE_ADJUST',
    sub_type: 'SETTLE_DIFF',
  });
  await transfer(h.db, f, f.receivable, f.revenue, 100n, key(f, 'SETTLE_ADJUST'), {
    ledger_type: 'SETTLE_ADJUST',
    sub_type: 'SETTLE_DIFF',
  });
  await transfer(h.db, f, f.receivable, f.revenue, 33n, key(f, 'FORFEIT', 'share', f.other));
  const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(result).toEqual({
    beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 400n }],
    platform_net_fen: 133n,
    union_receivable_net_fen: 533n,
  });
});

it('[AC-B2-04h#6] 凭证种类和 RESTORE 类型决定范围，应收排除回款及非订单调账', async () => {
  const f = await fixture(h.db);
  await transfer(h.db, f, f.receivable, f.user, 100n, key(f, 'CREDIT'));
  for (const [kind, ledgerType, subType] of [
    ['REWARD', 'REWARD', 'newbie'],
    ['ADMIN_ADJUST', 'ADMIN_ADJUST', 'RECON_FIX'],
    ['ADMIN_ADJUST', 'ADMIN_ADJUST', null],
    ['ADMIN_ADJUST', 'REWARD', 'RESTORE'],
    ['WITHDRAW_RETURN', 'WITHDRAW_RETURN', null],
    ['unknown', 'REBATE_CREDIT', null],
    [null, 'REBATE_CREDIT', null],
  ] as const) {
    await transfer(
      h.db,
      f,
      f.receivable,
      f.user,
      17n,
      {
        ...key(f, 'unused'),
        voucher_kind: kind,
      },
      { ledger_type: ledgerType, sub_type: subType },
    );
  }
  // Incomplete beneficiary keys still contribute to the order's receivable/platform totals.
  await transfer(h.db, f, f.receivable, f.user, 13n, { ...key(f, 'CREDIT'), role: null });
  await transfer(h.db, f, f.receivable, f.revenue, 7n, {
    ...key(f, 'CREDIT'),
    beneficiary_user_id: null,
  });
  const cash = await platform(h.db, 'CASH_ALIPAY', f.appId);
  await transfer(h.db, f, cash, f.receivable, 80n, { voucher_kind: 'UNION_RECEIPT' });
  // BR-FUND-08 platform net uses ALL order vouchers, unlike BR-FUND-19⑤ receivable.
  await transfer(
    h.db,
    f,
    f.revenue,
    cash,
    5n,
    { voucher_kind: 'ADMIN_ADJUST' },
    {
      ledger_type: 'ADMIN_ADJUST',
      sub_type: 'RECON_FIX',
    },
  );
  const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(result).toEqual({
    beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 100n }],
    platform_net_fen: 2n,
    union_receivable_net_fen: 120n,
  });
});

it('[AC-B2-04h#7] 普通红冲保留业务种类并相抵，历史改派红冲与重记按结构化种类计入', async () => {
  const f = await fixture(h.db);
  const original = await transfer(h.db, f, f.receivable, f.user, 40n, key(f, 'CREDIT'));
  await transfer(h.db, f, f.user, f.receivable, 40n, {
    ...key(f, 'CREDIT'),
    uniq_key: `${original.uniq_key}:REVERSE`,
  });
  await transfer(h.db, f, f.receivable, f.user, 100n, key(f, 'CREDIT', 'direct'));
  // R14 is closed to new writes; this read-only port must still classify stored history.
  await transfer(h.db, f, f.user, f.receivable, 100n, key(f, 'REASSIGN_REV', 'direct'));
  await transfer(h.db, f, f.receivable, f.other, 70n, key(f, 'REASSIGN_CREDIT', 'direct', f.other));
  const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(ordered(result)).toEqual(
    ordered({
      beneficiaries: [
        { beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 0n },
        { beneficiary_user_id: f.user.owner_id, role: 'direct', net_fen: 0n },
        { beneficiary_user_id: f.other.owner_id, role: 'direct', net_fen: 70n },
      ],
      platform_net_fen: 0n,
      union_receivable_net_fen: 70n,
    }),
  );
});

it('[AC-B2-04h#8] 超过 JS 安全整数后仍逐分精确，不经过浮点或丢弃尾数', async () => {
  const f = await fixture(h.db);
  await transfer(h.db, f, f.receivable, f.user, 9007199254740993n, key(f, 'CREDIT'));
  await transfer(h.db, f, f.receivable, f.user, 1n, key(f, 'SETTLE_ADJUST'), {
    ledger_type: 'SETTLE_ADJUST',
    sub_type: 'SETTLE_DIFF',
  });
  await transfer(h.db, f, f.user, f.receivable, 2n, key(f, 'CLAWBACK'), {
    ledger_type: 'CLAWBACK',
    sub_type: 'PART_REFUND',
  });
  await transfer(h.db, f, f.receivable, f.revenue, 9007199254740993n, { voucher_kind: 'CREDIT' });
  const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(result).toEqual({
    beneficiaries: [
      { beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 9007199254740992n },
    ],
    platform_net_fen: 9007199254740993n,
    union_receivable_net_fen: 18014398509481985n,
  });
});

it('[AC-B2-04h#15] 平台扣回与补差可双向，没收后申诉补发扣减平台，联盟科目不限淘宝', async () => {
  for (const union of ['jd', 'pdd']) {
    const f = await fixture(h.db);
    f.orderKey = `${union}:child`;
    const receivable = await platform(h.db, `UNION_RECEIVABLE:${union}`, f.appId);
    await transfer(h.db, f, receivable, f.revenue, 520n, { voucher_kind: 'CREDIT' });
    await transfer(h.db, f, receivable, f.revenue, 80n, { voucher_kind: 'FORFEIT' });
    await transfer(
      h.db,
      f,
      f.revenue,
      receivable,
      120n,
      { voucher_kind: 'CLAWBACK' },
      {
        ledger_type: 'CLAWBACK',
        sub_type: 'PART_REFUND',
      },
    );
    await transfer(
      h.db,
      f,
      receivable,
      f.revenue,
      30n,
      { voucher_kind: 'CLAWBACK' },
      {
        ledger_type: 'CLAWBACK',
        sub_type: 'PART_REFUND',
      },
    );
    await transfer(
      h.db,
      f,
      f.revenue,
      receivable,
      40n,
      { voucher_kind: 'SETTLE_ADJUST' },
      {
        ledger_type: 'SETTLE_ADJUST',
        sub_type: 'SETTLE_DIFF',
      },
    );
    await transfer(
      h.db,
      f,
      receivable,
      f.revenue,
      20n,
      { voucher_kind: 'SETTLE_ADJUST' },
      {
        ledger_type: 'SETTLE_ADJUST',
        sub_type: 'SETTLE_DIFF',
      },
    );
    await transfer(h.db, f, f.revenue, f.user, 15n, key(f, 'ADMIN_ADJUST'), {
      ledger_type: 'ADMIN_ADJUST',
      sub_type: 'RESTORE',
    });
    const result = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
    expect(result).toEqual({
      beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 15n }],
      platform_net_fen: 475n,
      union_receivable_net_fen: 490n,
    });
  }
});
