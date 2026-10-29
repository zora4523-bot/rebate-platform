import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import type { AvailableEntryRow } from '../infra/wallet-ledger-store.ts';
import {
  decodeWalletLedgerCursor,
  encodeWalletLedgerCursor,
  entriesAfter,
  getWalletLedger,
  linkOf,
  mergeNewestFirst,
  orderKeysOf,
  positionOf,
  projectWalletLedger,
  WalletLedgerQueryError,
  withdrawalsAfter,
  type WalletLedgerCursor,
  type WalletLedgerDependencies,
  type WalletLedgerPaidWithdrawal,
  type WalletLedgerPosition,
} from './wallet-ledger.ts';

const WD = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a90';
const WD2 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a91';
const ORDER_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a92';

function entry(
  id: string,
  at: string,
  overrides: Partial<AvailableEntryRow> = {},
): AvailableEntryRow {
  return {
    id,
    at,
    ledgerType: 'ADMIN_ADJUST',
    subType: 'OTHER',
    amountFen: -100n,
    balanceAfterFen: 100n,
    accountingDate: '2026-10-14',
    bizType: 'ADMIN_ADJUST',
    bizId: 'adj-1',
    orderKey: null,
    role: null,
    ...overrides,
  };
}

function paid(withdrawalId: string, paidAt: string, netFen = 910n): WalletLedgerPaidWithdrawal {
  return { withdrawalId, feeFen: 10n, taxFen: 80n, netFen, paidAt, paidDate: '2026-10-09' };
}

const T1 = '2026-10-14T02:00:00.000000Z';
const T0 = '2026-10-13T02:00:00.000000Z';

it('[AC-B2-04zc-UNIT#1] 游标只含来源与 id、不含任何时刻；往返不变；不是本接口给出的游标（篡改、旧版本带时刻、坏 id）一律 null', () => {
  const cursors: WalletLedgerCursor[] = [
    { source: 'entry', id: '42' },
    { source: 'withdrawal', id: WD },
  ];
  for (const cursor of cursors) {
    const encoded = encodeWalletLedgerCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeWalletLedgerCursor(encoded)).toEqual(cursor);
  }
  // 位置带着时刻也不进游标（masked 的邀请分佣行只到日，BR-TEXT-19 / J7）。
  const withInstant: WalletLedgerPosition = { at: T1, source: 'entry', id: '42' };
  const plain = Buffer.from(encodeWalletLedgerCursor(withInstant), 'base64url').toString('utf8');
  expect(plain).toBe('["wl2","e","42"]');
  expect(plain).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:/);
  const forged = (value: unknown) =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const rejected = [
    '',
    'not a cursor!',
    forged(['wl1', T1, 'e', '42']),
    forged(['wl2', T1, 'e', '42']),
    forged(['wl2', 'e', '0']),
    forged(['wl2', 'e', '9223372036854775808']),
    forged(['wl2', 'e', '42 OR 1=1']),
    forged(['wl2', 'w', '42']),
    forged(['wl2', 'x', WD]),
    forged(['wl2', 'e']),
    forged({ source: 'e', id: '42' }),
  ];
  for (const bad of rejected) {
    expect(decodeWalletLedgerCursor(bad), bad).toBeNull();
  }
});

it('[AC-B2-04zc-UNIT#2] 游标之后的起点：分录游标之后同一时刻只取更小 id 的分录、不再取汇总；汇总游标之后同一时刻的分录全取', () => {
  const atEntry: WalletLedgerPosition = { at: T1, source: 'entry', id: '7' };
  expect(entriesAfter(atEntry)).toEqual({ at: T1, idBelow: '7' });
  expect(withdrawalsAfter(atEntry)).toEqual({ paidAt: T1, idBelow: null });
  const atSummary: WalletLedgerPosition = { at: T1, source: 'withdrawal', id: WD };
  expect(entriesAfter(atSummary)).toEqual({ at: T1, idBelow: null });
  expect(withdrawalsAfter(atSummary)).toEqual({ paidAt: T1, idBelow: WD });
  expect(entriesAfter(null)).toBeNull();
  expect(withdrawalsAfter(null)).toBeNull();
});

it('[AC-B2-04zc-UNIT#3] 归并按时刻倒序，同一时刻汇总条目在分录之前，各来源内顺序不变', () => {
  const entries = [entry('9', T1), entry('8', T1), entry('3', T0)];
  const summaries = [paid(WD2, T1), paid(WD, T0)];
  const merged = mergeNewestFirst(entries, summaries);
  expect(merged.map(positionOf)).toEqual([
    { at: T1, source: 'withdrawal', id: WD2 },
    { at: T1, source: 'entry', id: '9' },
    { at: T1, source: 'entry', id: '8' },
    { at: T0, source: 'withdrawal', id: WD },
    { at: T0, source: 'entry', id: '3' },
  ]);
  expect(mergeNewestFirst([], [])).toEqual([]);
});

it('[AC-B2-04zc-UNIT#4] BR-TEXT-19 跳转与 masked：邀请分佣与 referrer 角色一律 masked，提现凭证跳提现单，自购 / 分享单跳订单，其余不跳转', () => {
  const order = { orderKey: 'taobao:123', bizType: 'ORDER_CREDIT', bizId: 'taobao:123' };
  expect(linkOf({ ...order, ledgerType: 'REFERRAL_CREDIT', role: 'direct' })).toEqual({
    masked: true,
  });
  // 角色缺失也按类型 masked。
  expect(linkOf({ ...order, ledgerType: 'REFERRAL_CREDIT', role: null })).toEqual({ masked: true });
  for (const ledgerType of ['CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST'] as const) {
    for (const role of ['direct', 'indirect']) {
      expect(linkOf({ ...order, ledgerType, role }), `${ledgerType}/${role}`).toEqual({
        masked: true,
      });
    }
  }
  const own = ['REBATE_CREDIT', 'SHARE_CREDIT', 'CLAWBACK', 'SETTLE_ADJUST'] as const;
  for (const ledgerType of own) {
    for (const role of ['self', 'share']) {
      expect(linkOf({ ...order, ledgerType, role })).toEqual({
        masked: false,
        kind: 'order',
        orderKey: 'taobao:123',
      });
    }
  }
  const withdrawal = { bizType: 'withdrawal', bizId: WD, orderKey: null, role: null };
  for (const ledgerType of ['WITHDRAW_FREEZE', 'WITHDRAW_RETURN'] as const) {
    expect(linkOf({ ...withdrawal, ledgerType })).toEqual({
      masked: false,
      kind: 'withdrawal',
      withdrawalId: WD,
    });
  }
  const none = { bizType: 'ADMIN_ADJUST', bizId: 'x', orderKey: null, role: null };
  for (const ledgerType of ['ADMIN_ADJUST', 'BAD_DEBT_WRITEOFF', 'REWARD'] as const) {
    expect(linkOf({ ...none, ledgerType })).toEqual({ masked: false, kind: 'none' });
  }
  // 带 order_key 但没有受益角色：不知道是谁的单，不跳转。
  expect(linkOf({ ...order, ledgerType: 'CLAWBACK', role: null })).toEqual({
    masked: false,
    kind: 'none',
  });
});

it('[AC-B2-04zc-UNIT#5] 投影：分录金额取相反数、带变动后余额；汇总条目为 −实际到账、带税费、无余额；masked 不带订单号', () => {
  const page = mergeNewestFirst(
    [
      entry('5', T1, {
        ledgerType: 'REBATE_CREDIT',
        subType: null,
        amountFen: -520n,
        balanceAfterFen: 1234n,
        accountingDate: '2026-10-14',
        bizType: 'ORDER_CREDIT',
        bizId: 'taobao:1',
        orderKey: 'taobao:1',
        role: 'self',
      }),
      entry('4', T1, {
        ledgerType: 'REFERRAL_CREDIT',
        subType: 'INDIRECT',
        amountFen: -61n,
        balanceAfterFen: 714n,
        bizType: 'ORDER_CREDIT',
        bizId: 'taobao:2',
        orderKey: 'taobao:2',
        role: 'indirect',
      }),
      entry('3', T0, { amountFen: 30n, balanceAfterFen: -80n, accountingDate: '2026-10-13' }),
    ],
    [paid(WD, T0)],
  );
  expect(orderKeysOf(page)).toEqual(['taobao:1']);
  const data = projectWalletLedger(page, new Map([['taobao:1', ORDER_ID]]), positionOf(page[3]!));
  expect(data.items).toEqual([
    {
      ledger_type: 'REBATE_CREDIT',
      sub_type: null,
      amount_fen: 520,
      accounting_date: '2026-10-14',
      link_type: 'order',
      link_id: ORDER_ID,
      masked: false,
      balance_after_fen: 1234,
    },
    {
      ledger_type: 'REFERRAL_CREDIT',
      sub_type: 'INDIRECT',
      amount_fen: 61,
      accounting_date: '2026-10-14',
      link_type: null,
      link_id: null,
      masked: true,
      balance_after_fen: 714,
    },
    {
      ledger_type: 'WITHDRAW_PAID',
      sub_type: null,
      amount_fen: -910,
      accounting_date: '2026-10-09',
      link_type: 'withdrawal',
      link_id: WD,
      masked: false,
      balance_after_fen: null,
      fee_fen: 10,
      tax_fen: 80,
    },
    {
      ledger_type: 'ADMIN_ADJUST',
      sub_type: 'OTHER',
      amount_fen: -30,
      accounting_date: '2026-10-13',
      link_type: null,
      link_id: null,
      masked: false,
      balance_after_fen: -80,
    },
  ]);
  expect(decodeWalletLedgerCursor(data.next_cursor ?? '')).toEqual({ source: 'entry', id: '3' });
  expect(JSON.stringify(data)).not.toContain('taobao:2');
  // 订单号查不到时不跳转，也不 masked。
  const orphan = projectWalletLedger(page.slice(0, 1), new Map(), null);
  expect(orphan).toEqual({
    items: [expect.objectContaining({ link_type: null, link_id: null, masked: false })],
    next_cursor: null,
  });
});

it('[AC-B2-04zc-UNIT#6] 坏游标与越界 limit 在读库之前就拒绝（字段 cursor / limit）', async () => {
  const unused = {} as Kysely<DB>;
  const ports: WalletLedgerDependencies = {
    withdrawals: {
      readPaid: () => Promise.reject(new Error('not reached')),
      readPaidAt: () => Promise.reject(new Error('not reached')),
    },
    orders: { readOrderIds: () => Promise.reject(new Error('not reached')) },
  };
  const subject = { appId: 'couli', userId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a93' };
  const cases = [
    [{ ...subject, cursor: 'garbage' }, 'cursor'],
    [{ ...subject, limit: 0 }, 'limit'],
    [{ ...subject, limit: 51 }, 'limit'],
    [{ ...subject, limit: 2.5 }, 'limit'],
  ] as const;
  for (const [request, field] of cases) {
    const refused = await getWalletLedger(unused, request, ports).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WalletLedgerQueryError);
    expect((refused as WalletLedgerQueryError).fields).toEqual([field]);
  }
});

it('[AC-B2-04zc-UNIT#7] 游标所指的提现单只在本人范围内回查；查不到（别人的、未到账的）→ cursor 拒绝，不读流水', async () => {
  // 已在事务里的句柄：查询直接跑在它上面；这里走不到任何 SQL。
  const trx = { isTransaction: true } as unknown as Kysely<DB>;
  const asked: unknown[] = [];
  const ports: WalletLedgerDependencies = {
    withdrawals: {
      readPaid: () => Promise.reject(new Error('not reached')),
      readPaidAt: (_handle, input) => {
        asked.push(input);
        return Promise.resolve(null);
      },
    },
    orders: { readOrderIds: () => Promise.reject(new Error('not reached')) },
  };
  const subject = { appId: 'couli', userId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a93' };
  const cursor = encodeWalletLedgerCursor({ source: 'withdrawal', id: WD });
  const pending = getWalletLedger(trx, { ...subject, cursor }, ports);
  const refused = await pending.catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(WalletLedgerQueryError);
  expect((refused as WalletLedgerQueryError).fields).toEqual(['cursor']);
  expect(asked).toEqual([{ ...subject, withdrawalId: WD }]);
});
