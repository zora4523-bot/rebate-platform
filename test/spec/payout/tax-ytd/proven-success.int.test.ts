// B2-08b W11 (规划/08 BR-WDR-20; state machine W11 CHANNEL_SUCCESS_PROVEN → PAID_API; task §9.2 3,
// §9.3): payout's W11 port (B2-07e, application/withdrawal-proven-success.ts) with identity's
// realname-identity-key port adds the proven withdrawal to tax_ytd on the write-off's transaction,
// after the voucher — the same row rule as W5: (member, +08:00 year of created_at, SERVICE_FEE,
// verified real name's hmac), cum_income_fen += amount_fen, cum_withheld_fen += tax_fen; a second
// proven withdrawal of the member in the year adds to the same row. A refusal (switch off, amount
// not net_fen) adds nothing. No verified real name → W11 throws and the write-off's transaction
// rolls back entirely (still APPROVED with its hold, no voucher, no event, no row).
// W11 runs on a real PostgreSQL (proven-success/kit.ts); the job queue records its sends.
// Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { createRealnameIdentityKeyReader } from '../../../../apps/api/src/modules/identity/ports/realname-identity-key.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import { createWithdrawalProvenSuccess } from '../../../../apps/api/src/modules/payout/application/withdrawal-proven-success.ts';
import {
  PAYEE_NAME,
  SWITCH,
  close,
  configPort,
  open,
  setup,
  withdrawalRow,
  type Fixture,
  type Harness,
} from '../proven-success/kit.ts';
import {
  TIMEOUT,
  expected,
  invariantMismatches,
  logText,
  randomHmac,
  seedRealname,
  taxRows,
  totals,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/**
 * W11's port on the fixture's ledger, users lock, config and recording queue, with identity's
 * realname-identity-key port (built first: red is the skeleton's NotImplemented).
 */
function wiredPort(f: Fixture) {
  const logger = { warn: vi.fn() };
  const port = createWithdrawalProvenSuccess({
    ledger: f.ledger,
    lockUsersForUpdate,
    config: configPort(),
    queue: f.queue,
    eventBus: createEventBus({ clock: f.clock, queue: f.queue, subscriptions: [] }),
    identityKey: createRealnameIdentityKeyReader(),
    logger,
  });
  return { port, logger };
}

it('[AC-B2-08b#W11] 凭账单核销成 PAID_API（¥100，税 2000 分）→ 同一事务里 tax_ytd 恰一行：created_at 的 +08:00 年、SERVICE_FEE、当前实名 hmac，cum_income 10000、cum_withheld 2000；日志不含 hmac', async () => {
  const f = await setup(h);
  const { port, logger } = wiredPort(f);
  const hmac = randomHmac();
  await seedRealname(h.db, f.appId, f.userId, { status: 'verified', hmac });
  const w = await f.seed({ net: 8_000n, tax: 2_000n });

  const result = await f.prove(f.input(w), port);

  expect(result).toMatchObject({ kind: 'proven', status: 'PAID_API' });
  expect((await taxRows(h.observer, f.appId)).map(totals)).toEqual([
    expected(f.appId, f.userId, 2026, hmac, 10_000n, 2_000n),
  ]);
  expect(await invariantMismatches(h.observer, f.appId)).toEqual([]);
  const logs = logText(logger);
  expect(logs).not.toContain(hmac);
  expect(logs).not.toContain(PAYEE_NAME);
});

it('[AC-B2-08b#W11] 同一会员同一年两笔核销（¥100、¥200，税 0）→ 累加到同一行 30000 / 0', async () => {
  const f = await setup(h);
  const { port } = wiredPort(f);
  const hmac = randomHmac();
  await seedRealname(h.db, f.appId, f.userId, { status: 'verified', hmac });
  const first = await f.seed({ net: 10_000n });
  const second = await f.seed({ net: 20_000n });

  expect(await f.prove(f.input(first), port)).toMatchObject({ kind: 'proven' });
  expect(await f.prove(f.input(second), port)).toMatchObject({ kind: 'proven' });

  expect((await taxRows(h.observer, f.appId)).map(totals)).toEqual([
    expected(f.appId, f.userId, 2026, hmac, 30_000n, 0n),
  ]);
  expect(await invariantMismatches(h.observer, f.appId)).toEqual([]);
});

it('[AC-B2-08b#W11] 拒绝核销不累加：账单金额 ≠ net_fen（amount_mismatch）、开关关闭（writeoff_disabled）→ 台账无行', async () => {
  const f = await setup(h);
  const { port } = wiredPort(f);
  await seedRealname(h.db, f.appId, f.userId, { status: 'verified', hmac: randomHmac() });
  const w = await f.seed({ net: 1_000n, tax: 100n });

  expect(await f.prove(f.input(w, { expectedFen: w.net + 1n }), port)).toEqual({
    kind: 'refused',
    reason: 'amount_mismatch',
  });
  await f.set(SWITCH, false);
  expect(await f.prove(f.input(w), port)).toEqual({ kind: 'refused', reason: 'writeoff_disabled' });

  expect(await taxRows(h.observer, f.appId)).toEqual([]);
  expect(await withdrawalRow(h.observer, f.appId, w.id)).toMatchObject({ status: 'APPROVED' });
});

it.each(['absent', 'none', 'failed'] as const)(
  '[AC-B2-08b#W11] 未实名就核销（夹具造出的非法状态，realname %s）→ W11 抛错，核销事务整体回滚：仍 APPROVED 带 hold、无 PAID 凭证、无事件、冻结不变、台账无行',
  async (state) => {
    const f = await setup(h);
    const { port } = wiredPort(f);
    if (state !== 'absent') await seedRealname(h.db, f.appId, f.userId, { status: state });
    const w = await f.seed({ net: 1_000n, tax: 50n });
    const before = await f.snapshot();

    await expect(f.prove(f.input(w), port)).rejects.toBeInstanceOf(Error);

    expect(await f.snapshot()).toEqual(before);
    expect(await withdrawalRow(h.observer, f.appId, w.id)).toMatchObject({
      status: 'APPROVED',
      hold_reason: 'payer_side_after_transfer',
    });
    expect(await taxRows(h.observer, f.appId)).toEqual([]);
  },
);
