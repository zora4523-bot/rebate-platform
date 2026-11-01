// B2-05p GET /v1/wallet/summary on the real assembly (BR-FUND-18, BR-WDR-05; production wiring gaps
// 7 and 8): withdrawn_fen sums amount_fen of the user's PAID_API / PAID_MANUAL withdrawals, and
// risk_paused_reason also answers account_frozen for an effective withdraw_holds row. Real AppModule,
// real PG + Redis, HTTP through inject; no owner port is mocked, the wiring itself is under test.
// Rows are written directly before the first GET of each user. Expected amounts are literals.
//
// Red first: before the implementation withdrawn_fen is always 0 and only a frozen risk state gives
// a reason. A case whose answer is 0 or null would already be green, so each such negative shares its
// `it` with a non-zero or account_frozen positive that is asserted first.
//
// users.id is globally unique and withdrawals, withdraw_holds and sessions all have composite
// (app_id, user_id) FKs, so the same uid cannot have rows or a session in a second app. As in
// test/spec/identity/deletion-guard (AC-B1-15e#8), that uid is queried under the other app instead:
// an omitted app_id predicate would find its rows. Without a possible session, that read calls the
// real controller taken from the same app with that principal (see readAs). A banned user reads the
// same way: GET /v1/wallet/summary is outside the BR-ID-31 whitelist, so over HTTP the global check
// answers 10006 before the summary is computed.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WalletSummaryController } from '../../../../apps/api/src/modules/ledger/http/public/wallet-summary.controller.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  closeKit,
  config,
  consentAll,
  fixture,
  HOUR,
  instant,
  openKit,
  riskState,
  type Fixture,
  type Kit,
} from '../../identity/me/http-kit.ts';
import {
  WALLET,
  ledgerBalance,
  order,
  ruleVersion,
  wallet,
} from '../../identity/me-balance/kit.ts';
import { seedWithdrawal } from '../../payout/read-port/kit.ts';

type Summary = Schema<'WalletSummary'>;
type HoldReason = 'manual' | 'recon_diff' | 'ledger_mismatch' | 'manual_failed_watch';

const TIMEOUT = 60_000;
const FROZEN = 'account_frozen';
/** The injected Clock after fixture(): CREATED + 1 h (2031), later than the wall clock. */
const NOW = instant(HOUR);
const LATER = instant((HOUR * 3) / 4);
const EARLIER = instant(HOUR / 2);
const EARLIEST = instant(HOUR / 4);

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 120_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

/** A user with both consents; a new app unless one is named. */
async function member(appId?: string): Promise<Fixture> {
  const f = await fixture(kit, appId === undefined ? {} : { appId });
  await consentAll(kit, f);
  return f;
}

/** GET /v1/wallet/summary over HTTP with this user's session; 200, code 0, contract-valid. */
async function read(f: Fixture): Promise<Summary> {
  return wallet(kit, await (await f.session()).request(WALLET)) as unknown as Summary;
}

/**
 * The summary of a principal that HTTP cannot reach it with (a uid under an app it is not a user of,
 * or a banned user): the real controller of the same app, so the same assembled ports.
 * Contract-valid too.
 */
async function readAs(appId: string, uid: string): Promise<Summary> {
  const app = kit.app as unknown as { get<T>(token: unknown, options: { strict: false }): T };
  const controller = app.get<WalletSummaryController>(WalletSummaryController, { strict: false });
  const body = await controller.summary({
    id: randomUUID(),
    principal: {
      app_id: appId,
      uid,
      sid: randomUUID(),
      device_id: randomUUID(),
      scp: 'full',
    },
  });
  const schema =
    kit.document.paths[WALLET]!['get']!.responses['200']!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body.data;
}

function paid(
  f: Fixture,
  status: 'PAID_API' | 'PAID_MANUAL',
  amount: bigint,
  fee = 0n,
  tax = 0n,
): Promise<unknown> {
  return seedWithdrawal(
    kit.suite.db,
    { appId: f.appId, userId: f.uid },
    { status, amount_fen: amount, fee_fen: fee, tax_fen: tax, paid_at: EARLIER },
  );
}

async function hold(
  f: Fixture,
  seed: {
    readonly reason?: HoldReason;
    readonly hold_until?: Date | null;
    readonly released_at?: Date | null;
    readonly created_at?: Date;
  } = {},
): Promise<void> {
  const released = seed.released_at ?? null;
  await kit.suite.db
    .withSchema('app')
    .insertInto('withdraw_holds')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      user_id: f.uid,
      reason: seed.reason ?? 'manual',
      source_ref: null,
      created_by: 'system',
      created_at: seed.created_at ?? EARLIER,
      hold_until: seed.hold_until ?? null,
      released_at: released,
      released_by: released === null ? null : 'system',
    })
    .execute();
}

/** A user of the app with an effective hold: the positive asserted before a negative. */
async function expectHeldFrozen(appId?: string): Promise<Fixture> {
  const f = await member(appId);
  await hold(f);
  expect((await read(f)).risk_paused_reason).toBe(FROZEN);
  return f;
}

it(
  '[AC-B2-05p#1] BR-FUND-18 withdrawn_fen = PAID_API + PAID_MANUAL 的 amount_fen 合计；PENDING_REVIEW、APPROVED、REJECTED、PAYING、FAILED 不计',
  async () => {
    const f = await member();
    await paid(f, 'PAID_API', 10_000n);
    await paid(f, 'PAID_MANUAL', 2_345n);
    const who = { appId: f.appId, userId: f.uid };
    await seedWithdrawal(kit.suite.db, who, { status: 'PENDING_REVIEW', amount_fen: 100_000n });
    await seedWithdrawal(kit.suite.db, who, { status: 'APPROVED', amount_fen: 200_000n });
    await seedWithdrawal(kit.suite.db, who, { status: 'REJECTED', amount_fen: 400_000n });
    await seedWithdrawal(kit.suite.db, who, { status: 'PAYING', amount_fen: 800_000n });
    await seedWithdrawal(kit.suite.db, who, { status: 'FAILED', amount_fen: 1_600_000n });

    expect((await read(f)).withdrawn_fen).toBe(12_345);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05p#2] BR-FUND-18 有手续费、代扣税时取 amount_fen，不取 net_fen（实到为 0 的单也按申请额计）',
  async () => {
    const f = await member();
    // net_fen: 8000 − 1000 − 1500 = 5500; 500 − 200 − 300 = 0.
    await paid(f, 'PAID_API', 8_000n, 1_000n, 1_500n);
    await paid(f, 'PAID_MANUAL', 500n, 200n, 300n);

    expect((await read(f)).withdrawn_fen).toBe(8_500);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05p#3] BR-FUND-18 withdrawn_fen 不串：同 app 别的用户、别的 app 的已打款单不计，本人的 user_id 放到别的 app 下查不到本人的单',
  async () => {
    const f = await member();
    await paid(f, 'PAID_API', 700n);
    const neighbour = await member(f.appId);
    await paid(neighbour, 'PAID_MANUAL', 9_000n);
    const stranger = await member();
    await paid(stranger, 'PAID_API', 50_000n);

    expect((await read(f)).withdrawn_fen).toBe(700);
    expect((await read(neighbour)).withdrawn_fen).toBe(9_000);
    expect((await read(stranger)).withdrawn_fen).toBe(50_000);
    expect((await readAs(stranger.appId, f.uid)).withdrawn_fen).toBe(0);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05p#4] BR-FUND-18 累加超过 int4 上限（2147483647 分）不溢出，按整数原样返回',
  async () => {
    const f = await member();
    await paid(f, 'PAID_API', 1_500_000_000n);
    await paid(f, 'PAID_MANUAL', 1_200_000_000n);

    expect((await read(f)).withdrawn_fen).toBe(2_700_000_000);
  },
  TIMEOUT,
);

for (const reason of ['manual', 'recon_diff', 'ledger_mismatch', 'manual_failed_watch'] as const) {
  it(
    `[AC-B2-05p#5] BR-FUND-18 BR-WDR-05 生效的 withdraw_holds reason=${reason} 给 account_frozen，不透露来源`,
    async () => {
      const f = await member();
      await hold(f, { reason });

      expect((await read(f)).risk_paused_reason).toBe(FROZEN);
    },
    TIMEOUT,
  );
}

it(
  '[AC-B2-05p#6] BR-WDR-05 hold_until 晚于注入时钟的 now（差 1 毫秒）→ 生效',
  async () => {
    const f = await member();
    await hold(f, { hold_until: new Date(NOW.getTime() + 1) });

    expect((await read(f)).risk_paused_reason).toBe(FROZEN);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05p#7] BR-WDR-05 released_at 有值 → 不生效（hold_until 为空或还没到都一样）',
  async () => {
    const active = await expectHeldFrozen();

    const released = await member(active.appId);
    await hold(released, { released_at: EARLIER });
    expect((await read(released)).risk_paused_reason).toBeNull();

    const releasedEarly = await member(active.appId);
    await hold(releasedEarly, {
      released_at: EARLIER,
      hold_until: new Date(NOW.getTime() + HOUR),
    });
    expect((await read(releasedEarly)).risk_paused_reason).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-05p#8] BR-WDR-05 hold_until 按注入时钟已过（差 1 毫秒）→ 不生效；不看数据库或机器的当前时间',
  async () => {
    const active = await expectHeldFrozen();

    // The Clock is in 2031: this instant is still ahead of the wall clock and of SQL now().
    const expired = await member(active.appId);
    await hold(expired, { hold_until: new Date(NOW.getTime() - 1) });
    expect((await read(expired)).risk_paused_reason).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-05p#9] BR-WDR-05 hold_until 正好等于 now → 不生效（> now 才生效）',
  async () => {
    const active = await expectHeldFrozen();

    const boundary = await member(active.appId);
    await hold(boundary, { hold_until: NOW });
    expect((await read(boundary)).risk_paused_reason).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-05p#10] BR-WDR-05 多条叠加逐条判定：已解除、已过期的记录之外还有一条生效 → account_frozen',
  async () => {
    const f = await member();
    // The effective row is last both by insertion and by created_at: judging the first row fails.
    await hold(f, { reason: 'recon_diff', created_at: EARLIEST, released_at: EARLIER });
    await hold(f, { reason: 'ledger_mismatch', created_at: EARLIEST, hold_until: EARLIER });
    await hold(f, { reason: 'manual', created_at: EARLIER });

    // The effective row is first both ways, as a manual hold followed by a recon_diff that was
    // already released: judging the latest row fails.
    const g = await member(f.appId);
    await hold(g, { reason: 'manual', created_at: EARLIEST });
    await hold(g, { reason: 'recon_diff', created_at: EARLIER, released_at: LATER });
    await hold(g, { reason: 'ledger_mismatch', created_at: EARLIER, hold_until: LATER });

    expect((await read(f)).risk_paused_reason).toBe(FROZEN);
    expect((await read(g)).risk_paused_reason).toBe(FROZEN);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05p#11] BR-FUND-18 hold 不串：同 app 别的用户、别的 app 的 hold 不算，有 hold 的 user_id 放到别的 app 下也不算',
  async () => {
    const holder = await expectHeldFrozen();

    const neighbour = await member(holder.appId);
    expect((await read(neighbour)).risk_paused_reason).toBeNull();

    const stranger = await member();
    await hold(stranger);
    const clean = await member();
    expect((await read(stranger)).risk_paused_reason).toBe(FROZEN);
    expect((await read(clean)).risk_paused_reason).toBeNull();
    expect((await readAs(stranger.appId, holder.uid)).risk_paused_reason).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-05p#12] BR-FUND-18 只有 hold、只有 risk_state=frozen、两者都有 → 都只一个 account_frozen 键；risk_state=banned 且无 hold → null',
  async () => {
    const holdOnly = await expectHeldFrozen();

    const frozenOnly = await member(holdOnly.appId);
    await riskState(kit, frozenOnly, 'frozen', 'other');
    expect((await read(frozenOnly)).risk_paused_reason).toBe(FROZEN);

    const both = await member(holdOnly.appId);
    await riskState(kit, both, 'frozen', 'other');
    await hold(both, { reason: 'recon_diff' });
    expect((await read(both)).risk_paused_reason).toBe(FROZEN);

    const banned = await member(holdOnly.appId);
    await riskState(kit, banned, 'banned', 'other');
    expect((await readAs(banned.appId, banned.uid)).risk_paused_reason).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-05p#13] BR-FUND-18 生效的 hold 不影响各金额：与同样数据、没有 hold 的用户逐字段相同，只差 risk_paused_reason',
  async () => {
    const plain = await member();
    const held = await member(plain.appId);
    await config(kit, plain.appId, 'withdraw.enabled', true);
    const rule = await ruleVersion(kit, plain.appId);
    for (const f of [plain, held]) {
      await ledgerBalance(kit, { appId: f.appId, userId: f.uid, available: 5_000n, frozen: 19n });
      // N 1000, 15 % reserve → base 850, the user alone at 50 % → 425 fen.
      await order(kit, { appId: f.appId, owner: f.uid, ruleVersionId: rule, kind: 'estimated' });
      await paid(f, 'PAID_API', 3_000n, 100n, 50n);
      await paid(f, 'PAID_MANUAL', 400n);
    }
    await hold(held, { reason: 'recon_diff' });

    const expected = {
      available_fen: 5_000,
      withdrawable_fen: 5_000,
      negative_fen: 0,
      frozen_fen: 19,
      estimated_total_fen: 425,
      estimated_fen: 425,
      pending_credit_fen: 0,
      pending_credit_paused_fen: 0,
      next_credit_period: null,
      credit_overdue: false,
      withdrawn_fen: 3_400,
      withdraw_enabled: true,
    };
    expect(await read(plain)).toEqual({ ...expected, risk_paused_reason: null });
    expect(await read(held)).toEqual({ ...expected, risk_paused_reason: FROZEN });
  },
  TIMEOUT,
);
