import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import { sql, type Selectable } from 'kysely';
import { expect } from 'vitest';
import type {
  InviteRewardOrder,
  InviteRewardPayoutDeps,
  InviteRewardGrantInput,
  InviteRewardQualificationInput,
} from '../../../../apps/api/src/modules/growth/application/invite-reward.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const QUALIFIED = '2026-10-20T02:00:00.000Z';
export const EXPIRES = '2026-11-19T02:00:00.000Z';
export const PAID = '2026-11-25T02:00:00.000Z';
export const IP = '2001:db8::1';
export type Reward = Selectable<DB['invite_rewards']>;
type Growth = typeof import('../../../../apps/api/src/modules/growth/application/invite-reward.ts');
type Platform = typeof import('../../../../apps/api/src/modules/platform/index.ts');
type Crypto = typeof import('../../../../apps/api/src/modules/platform/crypto/index.ts');
export async function api<T>(path: string): Promise<T> {
  return import(new URL(`apps/api/src/modules/${path}`, ROOT).href) as Promise<T>;
}
export async function growth() {
  return api<Growth>('growth/application/invite-reward.ts');
}
export async function openDatabase() {
  const testing = (await import(new URL('packages/db/src/testing/index.ts', ROOT).href)) as {
    createTestDatabase(): Promise<{ urlFor(role: string): string; drop(): Promise<void> }>;
  };
  const database = await testing.createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  return {
    db,
    async close() {
      await destroyDb(db);
      await database.drop();
    },
  };
}
export type Database = Awaited<ReturnType<typeof openDatabase>>;

export async function fixture(database: Database) {
  const p = await api<Platform>('platform/index.ts');
  const c = await api<Crypto>('platform/crypto/index.ts');
  const db = database.db.withSchema('app');
  const appId = `reward_${randomUUID()}`;
  const clock = new p.FixedClock(QUALIFIED);
  const provider = new c.LocalKeyProvider(randomBytes(32));
  const crypto = await c.openFieldCrypto(await c.createWrappedKeyring(provider), provider);
  const lines: string[] = [];
  const logger = p.createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const settings = new Map<string, unknown>([
    ['enabled', true],
    ['amount_fen', 1000],
    ['eligibility_days', 30],
    ['total_budget_fen', 100000],
    ['daily_budget_fen', 20000],
    ['min_paid_fen', 0],
    ['ip_window_hours', 24],
    ['payout_paused', false],
  ]);
  async function user(parent: string | null = null) {
    const id = randomUUID();
    await db
      .insertInto('users')
      .values({
        id,
        app_id: appId,
        nickname: 'reward fixture',
        avatar: 'fixture',
        invite_code: randomBytes(8).toString('hex'),
        attr_code: randomBytes(4).toString('hex'),
        register_method: 'sms',
        level: 'L1',
        status: 'normal',
        phone_hmac: randomBytes(32).toString('hex'),
        parent_id: parent,
        created_at: new Date(QUALIFIED),
        updated_at: new Date(QUALIFIED),
      })
      .execute();
    return id;
  }
  const inviter = await user();
  const invitee = await user(inviter);
  const facts = new Map<string, InviteRewardOrder>();
  const grants: InviteRewardGrantInput[] = [];
  const deviceSets = new Map<string, string[]>();
  const ips = new Map<string, string[]>();
  const retained = new Set<string>();
  const deleting = new Map<string, 'none' | 'processing' | 'done'>();
  const risks = new Map<string, 'normal' | 'banned' | 'appealing' | 'frozen'>();
  const birthdays = new Map<string, string>();
  const marked = new Set<string>();
  const judgements: { user: string; id: string; party: string }[] = [];
  const reads: { kind: string; input: unknown; transactional: boolean }[] = [];
  const deps: InviteRewardPayoutDeps = {
    db,
    clock,
    crypto,
    logger,
    config: {
      configValue: async (app, key, trx) => {
        expect(app).toBe(appId);
        expect(trx.isTransaction).toBe(true);
        const name = key.replace('growth.invite_reward.', '');
        return settings.has(name) ? { value: settings.get(name), version: 1 } : null;
      },
    },
    orders: {
      async read(trx, input) {
        reads.push({ kind: 'order', input, transactional: trx.isTransaction });
        const fact = facts.get(input.order_id);
        return fact?.app_id === input.app_id ? { ...fact } : null;
      },
      async listSelfOrdersInWindow(trx, input) {
        reads.push({ kind: 'window', input, transactional: trx.isTransaction });
        return [...facts.values()]
          .filter(
            (o) =>
              o.app_id === input.app_id &&
              o.user_id === input.user_id &&
              o.buy_type === 'self' &&
              o.attr_at >= input.from &&
              o.attr_at < input.to,
          )
          .map((o) => ({ ...o }));
      },
    },
    loginDevices: { read: async (_trx, input) => deviceSets.get(input.user_id) ?? [] },
    loginIps: {
      read: async (trx, input) => {
        reads.push({ kind: 'ip', input, transactional: trx.isTransaction });
        return ips.get(input.user_id) ?? [];
      },
    },
    deletedPhone: { retained: async (_trx, input) => retained.has(input.user_id) },
    deletionStatus: {
      read: async (_trx, input) =>
        new Map(input.user_ids.map((id) => [id, deleting.get(id) ?? 'none'])),
    },
    readRisk: async (_trx, input) => ({
      state: risks.get(input.user_id) ?? 'normal',
      reason_category: null,
      frozen_until: null,
    }),
    verifiedBirthDate: async (_trx, input) => birthdays.get(input.user_id) ?? null,
    multiAccount: {
      judge: async (trx, input) => {
        expect(trx.isTransaction).toBe(true);
        expect(input.app_id).toBe(appId);
        expect(input.ref.type).toBe('invite_reward');
        if (input.ref.type === 'invite_reward') {
          judgements.push({ user: input.user_id, id: input.ref.id, party: input.ref.party });
        }
        return { marked: marked.has(input.user_id), devices: [] };
      },
    },
    grantWriter: {
      grant: async (trx, input) => {
        expect(trx.isTransaction).toBe(true);
        expect(input.app_id).toBe(appId);
        expect(input.amount_fen).toBeGreaterThan(0n);
        grants.push({ ...input });
        const id = randomUUID();
        await trx
          .withSchema('app')
          .insertInto('ledger_vouchers')
          .values({
            id,
            app_id: appId,
            biz_type: 'REWARD',
            biz_id: `${input.invitee_id}:${input.party}`,
            uniq_key: `invite:${input.invitee_id}:${input.party}`,
            accounting_date: accountingDate(input.at),
            operator: 'B1-35 fixture',
            beneficiary_user_id: input.user_id,
            voucher_kind: 'REWARD',
            memo: 'invite',
            created_at: input.at,
          })
          .execute();
        return { voucher_id: id };
      },
    },
  };
  async function order(patch: Partial<InviteRewardOrder> = {}) {
    const fact: InviteRewardOrder = {
      app_id: appId,
      order_id: randomUUID(),
      user_id: invitee,
      buy_type: 'self',
      base_fen: 320n,
      pay_amount_fen: 4990n,
      attr_at: new Date('2026-10-22T02:00:00Z'),
      credited_at: new Date(PAID),
      rebate_status: 'CREDITED',
      refunded_quantity: 0,
      refunded_quantity_at_credit: 0,
      rights_pending: false,
      has_rights: false,
      ...patch,
    };
    await db
      .insertInto('order_keys')
      .values({
        app_id: fact.app_id,
        order_id: fact.order_id,
        platform: 'taobao',
        sub_order_id: randomUUID(),
        attr_at: fact.attr_at,
      })
      .execute();
    facts.set(fact.order_id, fact);
    return fact;
  }
  async function seedReward(patch: Partial<Reward> = {}) {
    const reward: Reward = {
      app_id: appId,
      invitee_id: invitee,
      inviter_id: inviter,
      amount_fen: 1000n,
      eligibility_days: 30,
      qualified_at: new Date(QUALIFIED),
      bind_source: 'register',
      bind_ip_hmac: crypto.blindIndex(IP, 'invite_rewards.bind_ip'),
      status: 'qualified',
      trigger_order_id: null,
      triggered_at: null,
      granted_at: null,
      inviter_result: null,
      invitee_result: null,
      inviter_skip_reason: null,
      invitee_skip_reason: null,
      void_reason: null,
      inviter_voucher_id: null,
      invitee_voucher_id: null,
      row_version: 0,
      ...patch,
    };
    await db.insertInto('invite_rewards').values(reward).execute();
    await db
      .insertInto('invite_reward_budgets')
      .values({
        app_id: appId,
        period: 'total',
        reserved_fen: reward.amount_fen * 2n,
        granted_fen: 0n,
        updated_at: clock.now(),
      })
      .onConflict((oc) =>
        oc.columns(['app_id', 'period']).doUpdateSet({
          reserved_fen: sql<bigint>`invite_reward_budgets.reserved_fen + ${reward.amount_fen * 2n}`,
        }),
      )
      .execute();
    return reward;
  }
  const row = (uid = invitee) =>
    db
      .selectFrom('invite_rewards')
      .selectAll()
      .where('app_id', '=', appId)
      .where('invitee_id', '=', uid)
      .executeTakeFirst();
  const budget = (period = 'total') =>
    db
      .selectFrom('invite_reward_budgets')
      .selectAll()
      .where('app_id', '=', appId)
      .where('period', '=', period)
      .executeTakeFirst();
  const vouchers = () =>
    db.selectFrom('ledger_vouchers').selectAll().where('app_id', '=', appId).execute();
  const qualifyInput: InviteRewardQualificationInput = {
    app_id: appId,
    invitee_id: invitee,
    inviter_id: inviter,
    bind_source: 'register',
    client_ip: IP,
    at: new Date(QUALIFIED),
  };
  return {
    db,
    appId,
    clock,
    crypto,
    lines,
    settings,
    inviter,
    invitee,
    user,
    deps,
    facts,
    grants,
    deviceSets,
    ips,
    retained,
    deleting,
    risks,
    birthdays,
    marked,
    judgements,
    reads,
    order,
    seedReward,
    row,
    budget,
    vouchers,
    qualifyInput,
    async qualify(patch: Partial<InviteRewardQualificationInput> = {}) {
      const service = (await growth()).createInviteRewardQualifier(deps);
      await db
        .transaction()
        .execute((trx) => service.qualifyInviteReward(trx, { ...qualifyInput, ...patch }));
    },
    async trigger(orderId: string) {
      const service = (await growth()).createInviteRewardTrigger(deps);
      await db
        .transaction()
        .execute((trx) => service.onCredited(trx, { app_id: appId, order_id: orderId }));
    },
    async process(uid = invitee) {
      return (await growth()).createInviteRewardPayout(deps).process(appId, uid);
    },
    async expire(uid = invitee) {
      await (await growth()).createInviteRewardExpiry(deps).expireIfDue(appId, uid);
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function ready(f: Fixture, patch: Partial<InviteRewardOrder> = {}) {
  const order = await f.order(patch);
  await f.seedReward({ trigger_order_id: order.order_id, triggered_at: new Date(PAID) });
  f.clock.set(PAID);
  return order;
}
export function warned(f: Fixture, level = 40) {
  expect(
    f.lines
      .map((line) => JSON.parse(line) as { level: number })
      .some((line) => line.level === level),
  ).toBe(true);
  expect(f.lines.join('')).not.toContain(IP);
}
