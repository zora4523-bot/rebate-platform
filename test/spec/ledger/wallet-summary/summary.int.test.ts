import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@couli/db/testing';
import { InvalidAmount } from '@couli/money';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as readEntry from '../../../../apps/api/src/modules/ledger/read.ts';
import { getWalletSummary } from '../../../../apps/api/src/modules/ledger/application/wallet-summary.ts';
import { WalletSummaryController } from '../../../../apps/api/src/modules/ledger/http/public/wallet-summary.controller.ts';
import { account, balance } from '../../db/ledger/invariants/kit.ts';
import { open, close, TIMEOUT, type Harness } from '../order-nets/kit.ts';
import { snapshot } from '../posting/kit.ts';
import { sources, validateSummary, ZERO } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

async function fixture(available = -400n, frozen = 0n) {
  const user = await account(h.db, { app_id: `wallet-${randomUUID()}` });
  await balance(h.db, user, available, frozen);
  return { user, subject: { appId: user.app_id, userId: user.owner_id } };
}

it('[AC-B2-04y#1] BR-AI-02 只读入口只导出查询函数；BR-FUND-18 原文负余额例逐字段一致', async () => {
  const { subject } = await fixture();
  const s = sources();
  expect(Object.keys(readEntry)).toEqual(['getWalletSummary']);
  expect(readEntry.getWalletSummary).toBe(getWalletSummary);
  const path = new URL('../../../../apps/api/src/modules/ledger/read.ts', import.meta.url);
  const source = ts.createSourceFile(
    path.pathname,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  expect(source.statements).toHaveLength(1);
  const declaration = source.statements[0]!;
  expect(ts.isExportDeclaration(declaration)).toBe(true);
  if (!ts.isExportDeclaration(declaration)) throw new Error('Expected named re-export');
  expect(declaration.isTypeOnly).toBe(false);
  expect(declaration.moduleSpecifier?.getText(source)).toMatch(
    /^['"]\.\/application\/wallet-summary\.ts['"]$/,
  );
  expect(declaration.exportClause && ts.isNamedExports(declaration.exportClause)).toBe(true);
  if (!declaration.exportClause || !ts.isNamedExports(declaration.exportClause))
    throw new Error('Expected named exports');
  expect(
    declaration.exportClause.elements.map((item) => ({
      name: item.name.text,
      original: item.propertyName?.text,
      typeOnly: item.isTypeOnly,
    })),
  ).toEqual([{ name: 'getWalletSummary', original: undefined, typeOnly: false }]);
  const before = await snapshot(h.db, subject.appId);
  const summary = await readEntry.getWalletSummary(h.reader, subject, s.dependencies);
  expect(summary).toEqual({
    ...ZERO,
    available_fen: -400,
    negative_fen: 400,
    estimated_total_fen: 1048,
    estimated_fen: 123,
    pending_credit_fen: 925,
    pending_credit_paused_fen: 617,
    next_credit_period: '2026-11',
  });
  await validateSummary(summary);
  expect(s.readAppTotals).not.toHaveBeenCalled();
  expect(await snapshot(h.db, subject.appId)).toEqual(before);
});

it.each([
  [0n, 0, 0, 0],
  [1n, 1, 1, 0],
  [-1n, -1, 0, 1],
  [1234n, 1234, 1234, 0],
  [-321n, -321, 0, 321],
  [9007199254740991n, 9007199254740991, 9007199254740991, 0],
  [-9007199254740991n, -9007199254740991, 0, 9007199254740991],
] as const)(
  '[AC-B2-04y#2] BR-FUND-10/18 余额 %s 分的可提现与负余额不扣冻结或提现门槛',
  async (fen, available, withdrawable, negative) => {
    const { subject } = await fixture(fen, 87n);
    const result = await readEntry.getWalletSummary(h.reader, subject, sources().dependencies);
    expect(result).toMatchObject({
      available_fen: available,
      withdrawable_fen: withdrawable,
      negative_fen: negative,
      frozen_fen: 87,
    });
    await validateSummary(result);
  },
);

it('[AC-B2-04y#3] BR-FUND-13/18 零余额零收益完整返回所有字段，不产生第二个余额或空对象', async () => {
  const { subject } = await fixture(0n);
  const s = sources();
  s.readUser.mockResolvedValue({
    estimated_fen: 0n,
    pending_credit_fen: 0n,
    pending_credit_paused_fen: 0n,
    next_credit_period: null,
    credit_overdue: false,
  });
  expect(await readEntry.getWalletSummary(h.reader, subject, s.dependencies)).toEqual(ZERO);
  expect((await snapshot(h.db, subject.appId)).accounts).toHaveLength(1);
});

it('[AC-B2-04y#4] BR-FUND-13/18 按 app 与 user 共同隔离单一余额和所有外部读取', async () => {
  const f = await fixture(17n, 3n);
  const otherUser = await account(h.db, { app_id: f.subject.appId });
  await balance(h.db, otherUser, 700n, 800n);
  const otherApp = await account(h.db, {
    app_id: `${f.subject.appId}-other`,
    owner_id: f.subject.userId,
  });
  await balance(h.db, otherApp, 900n, 1000n);
  const s = sources();
  s.readUser.mockImplementation(async (_db, subject) => ({
    estimated_fen:
      subject.appId !== f.subject.appId ? 33n : subject.userId === f.subject.userId ? 11n : 22n,
    pending_credit_fen: 0n,
    pending_credit_paused_fen: 0n,
    next_credit_period: null,
    credit_overdue: false,
  }));
  s.readPaidTotal.mockImplementation(async (_db, subject) =>
    subject.appId !== f.subject.appId ? 337n : subject.userId === f.subject.userId ? 229n : 271n,
  );
  const result = await readEntry.getWalletSummary(h.reader, f.subject, s.dependencies);
  expect(result).toMatchObject({
    available_fen: 17,
    frozen_fen: 3,
    withdrawn_fen: 229,
    estimated_total_fen: 11,
    estimated_fen: 11,
  });
  for (const port of [s.readUser, s.readPaidTotal, s.readPauseReason]) {
    expect(port).toHaveBeenCalled();
    for (const [, subject] of port.mock.calls) expect(subject).toEqual(f.subject);
  }
  expect(s.readWithdrawEnabled).toHaveBeenCalledWith(f.subject.appId);
  const other = await readEntry.getWalletSummary(
    h.reader,
    { appId: otherApp.app_id, userId: otherApp.owner_id },
    s.dependencies,
  );
  expect(other).toMatchObject({
    available_fen: 900,
    frozen_fen: 1000,
    withdrawn_fen: 337,
    estimated_total_fen: 33,
    estimated_fen: 33,
  });
  expect(
    await readEntry.getWalletSummary(
      h.reader,
      { appId: otherUser.app_id, userId: otherUser.owner_id },
      s.dependencies,
    ),
  ).toMatchObject({
    available_fen: 700,
    frozen_fen: 800,
    withdrawn_fen: 271,
    estimated_total_fen: 22,
    estimated_fen: 22,
  });
});

it('[AC-B2-04y#5] BR-FUND-18 逾期与暂停只影响进度字段，仍计入预估总额', async () => {
  const { subject } = await fixture(29n, 41n);
  const s = sources();
  s.readUser.mockResolvedValue({
    estimated_fen: 11n,
    pending_credit_fen: 89n,
    pending_credit_paused_fen: 67n,
    next_credit_period: null,
    credit_overdue: true,
  });
  s.readPaidTotal.mockResolvedValue(257n);
  expect(await readEntry.getWalletSummary(h.reader, subject, s.dependencies)).toEqual({
    ...ZERO,
    available_fen: 29,
    withdrawable_fen: 29,
    frozen_fen: 41,
    estimated_total_fen: 100,
    estimated_fen: 11,
    pending_credit_fen: 89,
    pending_credit_paused_fen: 67,
    credit_overdue: true,
    withdrawn_fen: 257,
  });
});

it.each([null, 'account_frozen'])(
  '[AC-B2-04y#6] BR-FUND-18 风险提示 %s 与关闭提现不清零金额',
  async (reason) => {
    const { subject } = await fixture(901n, 37n);
    const s = sources();
    s.readPauseReason.mockResolvedValue(reason);
    s.readWithdrawEnabled.mockResolvedValue(false);
    s.readPaidTotal.mockResolvedValue(227n);
    expect(await readEntry.getWalletSummary(h.reader, subject, s.dependencies)).toEqual({
      ...ZERO,
      available_fen: 901,
      withdrawable_fen: 901,
      frozen_fen: 37,
      estimated_total_fen: 1048,
      estimated_fen: 123,
      pending_credit_fen: 925,
      pending_credit_paused_fen: 617,
      next_credit_period: '2026-11',
      withdrawn_fen: 227,
      risk_paused_reason: reason,
      withdraw_enabled: false,
    });
  },
);

it('[AC-B2-04y#7] BR-FUND-18 余额实时读取，预估值最多缓存 60 秒且读不写库', async () => {
  const { user, subject } = await fixture(-40n, 12n);
  const s = sources();
  expect((await readEntry.getWalletSummary(h.reader, subject, s.dependencies)).negative_fen).toBe(
    40,
  );
  // Test fixture mutation models a separately committed ledger posting; no business writer is replaced.
  await h.db
    .withSchema('app')
    .updateTable('account_balances')
    .set({ available_fen: 73n, frozen_fen: 28n })
    .where('app_id', '=', subject.appId)
    .where('account_id', '=', user.id)
    .execute();
  expect(await readEntry.getWalletSummary(h.reader, subject, s.dependencies)).toMatchObject({
    available_fen: 73,
    withdrawable_fen: 73,
    negative_fen: 0,
    frozen_fen: 28,
  });
  s.readUser.mockResolvedValue({
    estimated_fen: 3n,
    pending_credit_fen: 5n,
    pending_credit_paused_fen: 0n,
    next_credit_period: '2027-01',
    credit_overdue: true,
  });
  s.clock.advanceMs(60_001);
  const before = await snapshot(h.db, subject.appId);
  expect(await readEntry.getWalletSummary(h.reader, subject, s.dependencies)).toMatchObject({
    estimated_total_fen: 8,
    estimated_fen: 3,
    pending_credit_fen: 5,
    pending_credit_paused_fen: 0,
    next_credit_period: '2027-01',
    credit_overdue: true,
  });
  expect(await snapshot(h.db, subject.appId)).toEqual(before);
});

it.each([
  'available',
  'negative',
  'frozen',
  'estimated',
  'pending',
  'paused',
  'total',
  'withdrawn',
] as const)(
  '[AC-B2-04y#8] ADR-0001 金额 %s 超过 JSON 安全整数边界时拒绝而非舍入或字符串化',
  async (field) => {
    const { subject } = await fixture(
      field === 'available' ? 9007199254740992n : field === 'negative' ? -9007199254740992n : 0n,
      field === 'frozen' ? 9007199254740992n : 0n,
    );
    const s = sources();
    s.readUser.mockResolvedValue({
      estimated_fen:
        field === 'estimated' ? 9007199254740992n : field === 'total' ? 9007199254740991n : 0n,
      pending_credit_fen:
        field === 'pending' || field === 'paused' ? 9007199254740992n : field === 'total' ? 1n : 0n,
      pending_credit_paused_fen: field === 'paused' ? 9007199254740992n : 0n,
      next_credit_period: null,
      credit_overdue: false,
    });
    if (field === 'withdrawn') s.readPaidTotal.mockResolvedValue(9007199254740992n);
    await expect(
      readEntry.getWalletSummary(h.reader, subject, s.dependencies),
    ).rejects.toBeInstanceOf(InvalidAmount);
  },
);

it.each(['pending', 'withdrawals', 'risk', 'config'] as const)(
  '[AC-B2-04y#9] BR-FUND-18 外部 %s 读取失败不得伪装为零收益或安全状态',
  async (kind) => {
    const { subject } = await fixture();
    const s = sources();
    const failure = new Error(`source unavailable: ${kind}`);
    ({
      pending: s.readUser,
      withdrawals: s.readPaidTotal,
      risk: s.readPauseReason,
      config: s.readWithdrawEnabled,
    })[kind].mockRejectedValue(failure);
    await expect(readEntry.getWalletSummary(h.reader, subject, s.dependencies)).rejects.toBe(
      failure,
    );
  },
);

it('[AC-B2-04y#10] AC-S2-33 控制器真实查询响应 data 与同一只读函数 13 字段一致', async () => {
  const { subject } = await fixture(-400n, 19n);
  const s = sources();
  s.readPaidTotal.mockResolvedValue(113n);
  const query = (who: typeof subject) => readEntry.getWalletSummary(h.reader, who, s.dependencies);
  const expected = await query(subject);
  const controller = new WalletSummaryController(query);
  const body = await controller.summary({
    id: 'wallet-roundtrip',
    principal: {
      app_id: subject.appId,
      uid: subject.userId,
      sid: randomUUID(),
      device_id: randomUUID(),
      scp: 'full',
    },
  });
  expect(body).toEqual({ code: 0, msg: '', trace_id: 'wallet-roundtrip', data: expected });
  await validateSummary(body, true);
});
