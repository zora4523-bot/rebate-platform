import { randomUUID } from 'node:crypto';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import * as orders from '../../../../apps/api/src/modules/orders/index.ts';
import type { ContentReader, ConfigValue } from '../../../../apps/api/src/modules/content/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { RedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { fixture as baseFixture } from '../list-detail/kit.ts';

export const NOW = '2028-01-15T04:00:00.000Z';
export const ATTR = '2028-01-14T16:10:00.000Z';
export const PAID = '2028-01-15';
export const at = (iso: string) => new FixedClock(iso).now();
export async function capture<T>(run: () => T | Promise<T>) {
  try {
    return { ok: true as const, value: await run() };
  } catch (error) {
    return { ok: false as const, error };
  }
}
export async function value<T>(run: () => T | Promise<T>): Promise<T> {
  const result = await capture(run);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  return result.value;
}
export function success<T>(result: orders.ClaimResult<T>): T {
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('Expected successful claim result');
  return result.data;
}
export function failure(result: unknown, code: number, data?: object) {
  expect(result).toEqual(data === undefined ? { code } : { code, data });
}

export async function fixture(db: Kysely<DB>, redis: RedisHandle) {
  const base = await baseFixture(db);
  const { subject, clock } = base;
  const settings = new Map<string, ConfigValue>();
  const config: ContentReader = {
    appVersion: async () => null,
    minSupportedVersion: async () => null,
    configValue: vi.fn(async (_app, key) =>
      settings.has(key) ? { value: settings.get(key)!, version: 1 } : null,
    ),
  };
  const { logger, lines } = memoryLogger();
  const deps: orders.OrderClaimDeps = { db, redis, clock, config, logger };
  async function seed(patch: Partial<Insertable<DB['orders']>> = {}) {
    return base.seed({
      user_id: null,
      buy_type: null,
      rebate_status: 'UNATTRIBUTED',
      locked: false,
      attr_at: at(ATTR),
      paid_at: at(ATTR),
      created_at: at(ATTR),
      updated_at: at(ATTR),
      ...patch,
    });
  }
  async function submit(
    order_no: string,
    patch: Partial<Schema<'CreateOrderClaimRequest'>> = {},
    actor = subject,
    overrides: Partial<orders.OrderClaimDeps> = {},
  ) {
    return value(() =>
      orders.createOrderClaim({ ...deps, ...overrides }, actor, {
        platform: 'jd',
        paid_date: PAID,
        order_no,
        ...patch,
      }),
    );
  }
  async function list(input: orders.ClaimListInput = {}, actor = subject) {
    return value(() => orders.listOrderClaims(deps, actor, input));
  }
  const counterKey = (actor = subject, day = '20280115') =>
    `${actor.app_id}:${actor.user_id}:${day}`;
  const count = (actor = subject, day = '20280115') =>
    redis.namespace('claim').get(counterKey(actor, day));
  const setCount = (n: number, actor = subject, day = '20280115') =>
    redis.namespace('claim').set(counterKey(actor, day), String(n), 86400);
  const claims = () =>
    db
      .selectFrom('claims')
      .selectAll()
      .where('app_id', '=', subject.app_id)
      .where('user_id', '=', subject.user_id)
      .orderBy('id')
      .execute();
  const items = () =>
    db
      .selectFrom('claim_items')
      .selectAll()
      .where('app_id', '=', subject.app_id)
      .where('applicant_user_id', '=', subject.user_id)
      .orderBy('sub_order_id')
      .execute();
  async function history(
    row: Awaited<ReturnType<typeof seed>>,
    patch: Partial<Insertable<DB['claims']>> = {},
    itemPatch: Partial<Insertable<DB['claim_items']>> = {},
  ) {
    const claim = {
      id: randomUUID(),
      ...subject,
      platform: row.platform,
      order_no: row.sub_order_id,
      order_no_type: 'sub',
      paid_date: PAID,
      status: 'submitted',
      created_at: clock.now(),
      updated_at: clock.now(),
      ...patch,
    } satisfies Insertable<DB['claims']>;
    await db.insertInto('claims').values(claim).execute();
    await db
      .insertInto('claim_items')
      .values({
        id: randomUUID(),
        app_id: claim.app_id,
        claim_id: claim.id,
        applicant_user_id: claim.user_id,
        platform: row.platform,
        sub_order_id: row.sub_order_id,
        order_id: row.order_id,
        created_at: claim.created_at,
        updated_at: claim.updated_at,
        ...itemPatch,
      })
      .execute();
    return claim;
  }
  async function accepted(
    order_no: string,
    children: Awaited<ReturnType<typeof seed>>[],
    patch: Partial<Schema<'CreateOrderClaimRequest'>> = {},
    kind = 'sub',
  ) {
    const answer = success(await submit(order_no, patch));
    const sorted = [...children].sort((a, b) => (a.sub_order_id < b.sub_order_id ? -1 : 1));
    expect(answer).toEqual({
      claim_id: expect.any(String),
      platform: patch.platform ?? 'jd',
      order_no: order_no.replaceAll(' ', ''),
      paid_date: patch.paid_date ?? PAID,
      status: expect.stringMatching(/^(submitted|auto_matched|manual_review)$/),
      created_at: clock.now().toISOString(),
      items: sorted.map((r) => ({
        sub_order_id: r.sub_order_id,
        decision: null,
        reject_reason: null,
      })),
    });
    const saved = (await claims()).find((r) => r.id === answer.claim_id);
    expect(saved).toMatchObject({
      status: answer.status,
      user_id: subject.user_id,
      app_id: subject.app_id,
      order_no: answer.order_no,
      order_no_type: kind,
      created_at: clock.now(),
    });
    const savedItems = (await items()).filter((r) => r.claim_id === answer.claim_id);
    expect(savedItems).toHaveLength(sorted.length);
    expect(
      savedItems.map((r) => ({
        order_id: r.order_id,
        sub_order_id: r.sub_order_id,
        applicant_user_id: r.applicant_user_id,
        app_id: r.app_id,
        platform: r.platform,
      })),
    ).toEqual(
      sorted.map((r) => ({
        order_id: r.order_id,
        sub_order_id: r.sub_order_id,
        applicant_user_id: subject.user_id,
        app_id: subject.app_id,
        platform: r.platform,
      })),
    );
    return answer;
  }
  return {
    ...base,
    settings,
    config,
    deps,
    seed,
    submit,
    list,
    counterKey,
    count,
    setCount,
    claims,
    items,
    history,
    accepted,
    lines,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
