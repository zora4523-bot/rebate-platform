import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  WithdrawLimits,
  WithdrawRuleInput,
} from '../../../../apps/api/src/modules/payout/domain/withdraw-rules.ts';
import type { WithdrawRulesOptions } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';

export const actor = {
  appId: 'synthetic_withdraw',
  userId: '01920000-0000-7000-8000-000000000051',
  deviceId: '01920000-0000-7000-8000-000000000052',
};

/** Independent literal oracle, never read implementation defaults to build expectations. */
export function limits(): WithdrawLimits {
  return {
    enabled: true,
    min_amount_fen: 100n,
    amount_step_fen: 100n,
    max_amount_fen: 500000n,
    daily_count_per_user: 1,
    monthly_count_per_user: 10,
    payee_daily_count: 2,
    payee_daily_distinct_users: 1,
    method_max_amount_fen: { alipay: 0n, bank_card: 0n, wechat: 20000n },
    minor_monthly_cap_fen: 20000n,
    self_purchase_enabled: false,
    self_purchase_min_fen: 0n,
    allowed_member_levels: [],
  };
}

export function input(): WithdrawRuleInput {
  return {
    limits: limits(),
    step_up_valid: true,
    risk_state: 'normal',
    prev_risk_state: null,
    blocklist_risk_msg_code: null,
    reverify: null,
    realname_verified: true,
    payout_method: 'alipay',
    names_match: true,
    labor_agreement_signed: true,
    active_hold: false,
    available_fen: 800000n,
    usage: {
      daily_count: 0,
      monthly_count: 0,
      payee_daily_count: 0,
      payee_daily_other_users: 0,
      monthly_amount_fen: 0n,
    },
    minor: false,
    self_purchase_count: 0,
    self_purchase_fen: 0n,
  };
}

export function applicationFixture() {
  const clock = new FixedClock('2026-10-01T16:00:00.000Z');
  // A sentinel handle: tests only invoke fake ports, never open PG or a listener.
  const handle = Object.freeze({ fixture: 'caller-transaction' }) as unknown as Kysely<DB>;
  const values = new Map<string, unknown>();
  const options: WithdrawRulesOptions = {
    clock,
    logger: { warn: vi.fn() },
    config: {
      configValue: vi.fn(async (_app, key, handle) => {
        void handle;
        return values.has(key) ? { value: values.get(key), version: 1 } : null;
      }),
    },
    risk: {
      read: vi.fn(
        async () => new Map([[actor.userId, { state: 'normal' as const, frozen_until: null }]]),
      ),
    },
    appeal: { read: vi.fn(async () => null) },
    blocklist: { read: vi.fn(async () => null) },
    reverify: { check: vi.fn(async () => null) },
    realname: {
      read: vi.fn(async () => 'verified' as const),
      verified: vi.fn(async () => ({
        name: '阿·甲',
        birth_date: '1990-01-01',
        provider: 'synthetic',
        verified_at: clock.now(),
      })),
    },
    subject: {
      read: vi.fn(async () => ({
        payout_method: 'alipay' as const,
        payee_name: '阿·甲',
        payee_hmac: 'a'.repeat(64),
      })),
    },
    laborAgreementSigned: vi.fn(async () => true),
    ledger: {
      getBalances: vi.fn(async () => [
        {
          app_id: actor.appId,
          user_id: actor.userId,
          account_id: actor.userId,
          available_fen: 800000n,
          frozen_fen: 0n,
          version: 1n,
          negative_since: null,
        },
      ]),
    },
    holds: { read: vi.fn(async () => []) },
    usage: { read: vi.fn(async () => input().usage) },
    selfPurchase: { read: vi.fn(async () => ({ count: 0, amount_fen: 0n })) },
    feeTax: {
      calculate: vi.fn(async (_handle, value) => ({
        fee_fen: 0n,
        tax_fen: 0n,
        net_fen: value.amountFen,
      })),
    },
  };
  return { clock, handle, values, options };
}
