import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { close, fixture, open, state, TIMEOUT, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each([
  ['disabled', 30306],
  ['step-up', 10003],
  ['banned', 10006],
  ['blocklist', 44001],
  ['realname', 30304],
  ['payee', 30305],
  ['name', 30307],
  ['agreement', 10004],
] as const)(
  '[AC-B2-05d#60] 建单入口复用锁外校验，%s 优先于后续故障，code=%s 且不加业务锁',
  async (stage, code) => {
    const f = await fixture(h);
    // All later prerequisites also fail: accepting or checking in a different order is observable.
    await f.set('withdraw.enabled', stage !== 'disabled');
    f.options.rules.risk = {
      read: async () =>
        new Map([
          [
            f.actor.userId,
            {
              state: ['disabled', 'step-up', 'banned'].includes(stage) ? 'banned' : 'normal',
              frozen_until: null,
            },
          ],
        ]),
    };
    f.options.rules.blocklist = {
      read: async () => (stage === 'blocklist' ? { risk_msg_code: 'SYNTHETIC' } : null),
    };
    if (['disabled', 'step-up', 'banned', 'blocklist', 'realname'].includes(stage)) {
      f.options.rules.realname.read = async () => 'none';
      f.options.rules.realname.verified = async () => null;
    }
    if (stage !== 'name' && stage !== 'agreement') f.options.rules.subject.read = async () => null;
    if (stage === 'name')
      f.options.rules.subject.read = async () => ({
        payout_method: 'alipay',
        payee_hmac: f.hmac,
        payee_name: '另一个合成姓名',
      });
    f.options.rules.laborAgreementSigned = async () => false;
    let locks = 0;
    const lock = f.options.lockUsersForUpdate;
    f.options.lockUsersForUpdate = async (trx, input) => {
      locks += 1;
      return lock(trx, input);
    };
    const useCase = f.service();
    const before = await state(f);
    const result = await h.db.transaction().execute((trx) =>
      useCase.apply(trx, {
        ...f.actor,
        amountFen: 1000n,
        stepUpValid: stage !== 'step-up' && stage !== 'disabled',
      }),
    );
    expect(result.code).toBe(code);
    if (stage === 'agreement') expect(result.data).toEqual({ consent_type: 'labor_agreement' });
    if (stage === 'blocklist') expect(result.data).toEqual({ risk_msg_code: 'SYNTHETIC' });
    expect(locks).toBe(0);
    expect(await state(f)).toEqual(before);
  },
);

it.each([
  [50n, 'below_min'],
  [125n, 'not_multiple'],
  [500100n, 'above_max'],
] as const)(
  '[AC-B2-05d#61] 金额 %s 的业务限制 %s 优先于余额不足且不建单',
  async (amountFen, reason) => {
    const f = await fixture(h, { balance: 0n });
    const useCase = f.service();
    const before = await state(f);
    expect(
      await h.db
        .transaction()
        .execute((trx) => useCase.apply(trx, { ...f.actor, amountFen, stepUpValid: true })),
    ).toEqual({ code: 30303, data: { reason } });
    expect(await state(f)).toEqual(before);
  },
);

it('[AC-B2-05d#62] 净额不足一分 → 30303 net_too_small，不先建单或冻结', async () => {
  const f = await fixture(h);
  f.options.rules.feeTax = {
    calculate: async () => ({ fee_fen: 0n, tax_fen: 1000n, net_fen: 0n }),
  };
  const useCase = f.service();
  const before = await state(f);
  expect(
    await h.db
      .transaction()
      .execute((trx) => useCase.apply(trx, { ...f.actor, amountFen: 1000n, stepUpValid: true })),
  ).toEqual({ code: 30303, data: { reason: 'net_too_small' } });
  expect(await state(f)).toEqual(before);
});
