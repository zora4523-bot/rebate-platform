// B1-02zn GET /v1/me balance (BR-FUND-18, 拍板第二批 §8 ADD-06; brief §9.2, §9.3): the three
// MeBalance fields read ledger's wallet summary, the same query and owner ports as
// GET /v1/wallet/summary, read only, by the token's app_id + user_id. Both routes are called over
// HTTP on the same api app at the same FixedClock instant. Before the implementation the
// assembled balanceOf answers three zeros, so every case is red on an assertion.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as walletQuery from '../../../../apps/api/src/modules/ledger/application/wallet-summary.ts';
import {
  closeKit,
  config,
  consentAll,
  fixture,
  me,
  openKit,
  serverError,
  type Kit,
} from '../me/http-kit.ts';
import {
  WALLET,
  ZERO,
  accountsOf,
  ledgerBalance,
  order,
  ruleVersion,
  same,
  wallet,
  walletServerError,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 120_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const TIMEOUT = 60_000;

it(
  '[AC-B1-02zn#1] BR-FUND-18 无任何流水的用户：/v1/me 三项为 0，经 ledger 钱包摘要查询按 token 的 app_id + user_id 读取，不开账户',
  async () => {
    const f = await fixture(kit);
    await consentAll(kit, f);
    const query = vi.spyOn(walletQuery, 'getWalletSummary');
    try {
      const data = me(kit, await f.get());
      expect(data.balance).toEqual(ZERO);
      // brief §9.2 ①: the same query as GET /v1/wallet/summary, for this user in this app only.
      expect(query).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ appId: f.appId, userId: f.uid }),
        expect.anything(),
      );
      for (const call of query.mock.calls) {
        expect(call[1]).toMatchObject({ appId: f.appId, userId: f.uid });
      }
    } finally {
      query.mockRestore();
    }
    const summary = wallet(kit, await (await f.session()).request(WALLET));
    expect(same(summary)).toEqual(ZERO);
    // Read only: no ledger account is opened by either read (BR-FUND-13).
    expect(await accountsOf(kit, f.appId, f.uid)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zn#2] BR-FUND-18 有可用分录（REBATE_CREDIT）与待结算预估：/v1/me 三项与 /v1/wallet/summary 同名字段逐一相等且非 0',
  async () => {
    const f = await fixture(kit);
    await consentAll(kit, f);
    await ledgerBalance(kit, {
      appId: f.appId,
      userId: f.uid,
      available: 1234n,
      frozen: 56n,
      credit: 1234n,
    });
    const rule = await ruleVersion(kit, f.appId);
    // Each order: N 1000, 15 % reserve → base 850, the user alone at 50 % → 425 fen.
    await order(kit, { appId: f.appId, owner: f.uid, ruleVersionId: rule, kind: 'estimated' });
    await order(kit, { appId: f.appId, owner: f.uid, ruleVersionId: rule, kind: 'waiting_hold' });

    const data = me(kit, await f.get());
    const summary = wallet(kit, await (await f.session()).request(WALLET));
    // estimated_total_fen = estimated 425 + pending credit 425 (the held one still counts).
    const expected = { available_fen: 1234, withdrawable_fen: 1234, estimated_total_fen: 850 };
    expect(same(summary)).toEqual(expected);
    expect(data.balance).toEqual(same(summary));
    expect(data.balance).toEqual(expected);
    for (const value of Object.values(data.balance)) expect(value).not.toBe(0);
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zn#3] BR-FUND-18 可用为负时 withdrawable_fen = 0（同 wallet 口径），available_fen 照负值返回',
  async () => {
    const f = await fixture(kit);
    await consentAll(kit, f);
    await ledgerBalance(kit, { appId: f.appId, userId: f.uid, available: -400n, frozen: 19n });
    const rule = await ruleVersion(kit, f.appId);
    await order(kit, { appId: f.appId, owner: f.uid, ruleVersionId: rule, kind: 'estimated' });

    const data = me(kit, await f.get());
    const summary = wallet(kit, await (await f.session()).request(WALLET));
    const expected = { available_fen: -400, withdrawable_fen: 0, estimated_total_fen: 425 };
    expect(same(summary)).toEqual(expected);
    expect(data.balance).toEqual(expected);
    expect(data.balance).toEqual(same(summary));
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zn#4] BR-FUND-18 别的用户、别的 app 的余额与预估不计入：只按 token 的 app_id + user_id',
  async () => {
    const f = await fixture(kit);
    await consentAll(kit, f);
    const rule = await ruleVersion(kit, f.appId);
    // Own: 300 fen credited, one estimated order (425).
    await ledgerBalance(kit, { appId: f.appId, userId: f.uid, available: 300n, credit: 300n });
    await order(kit, { appId: f.appId, owner: f.uid, ruleVersionId: rule, kind: 'estimated' });

    // Another user of the same app: own balance and own estimated / pending orders.
    const neighbour = randomUUID();
    await ledgerBalance(kit, {
      appId: f.appId,
      userId: neighbour,
      available: 9000n,
      credit: 9000n,
    });
    await order(kit, { appId: f.appId, owner: neighbour, ruleVersionId: rule, kind: 'estimated' });
    await order(kit, {
      appId: f.appId,
      owner: neighbour,
      ruleVersionId: rule,
      kind: 'waiting_hold',
    });

    // Another app: an account of the same user_id with a balance, and an order there that names
    // the same user_id as a beneficiary.
    const otherApp = `meb_${randomUUID()}`;
    const otherRule = await ruleVersion(kit, otherApp);
    await ledgerBalance(kit, { appId: otherApp, userId: f.uid, available: 7777n });
    const buyer = randomUUID();
    await order(kit, {
      appId: otherApp,
      owner: buyer,
      ruleVersionId: otherRule,
      kind: 'estimated',
      people: [
        { userId: buyer, role: 'self', ratioBp: 5000 },
        { userId: f.uid, role: 'direct', ratioBp: 1000 },
      ],
    });

    const data = me(kit, await f.get());
    const summary = wallet(kit, await (await f.session()).request(WALLET));
    const expected = { available_fen: 300, withdrawable_fen: 300, estimated_total_fen: 425 };
    expect(same(summary)).toEqual(expected);
    expect(data.balance).toEqual(expected);
    expect(data.balance).toEqual(same(summary));
  },
  TIMEOUT,
);

it(
  '[AC-B1-02zn#5] BR-FUND-18 钱包摘要读取失败时 /v1/me 照现有错误处理答 50001，不吞成 0',
  async () => {
    const f = await fixture(kit);
    await consentAll(kit, f);
    await ledgerBalance(kit, { appId: f.appId, userId: f.uid, available: 500n, credit: 500n });
    const rule = await ruleVersion(kit, f.appId);
    // A pending credit that is not held reads settle.bill_day; a non-integer value is a broken
    // setting and the estimate read throws (never a default).
    await config(kit, f.appId, 'credit.enabled.taobao', true);
    await config(kit, f.appId, 'settle.bill_day', 'not-an-integer');
    await order(kit, { appId: f.appId, owner: f.uid, ruleVersionId: rule, kind: 'waiting' });

    walletServerError(kit, await (await f.session()).request(WALLET));
    serverError(kit, await f.get());
  },
  TIMEOUT,
);
