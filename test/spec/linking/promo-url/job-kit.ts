// B1-06zd rule-test kit: one prefetch job on a real database, with the handler's own options. The
// union is a stub (no recorded platform payload exists): each conversion first goes through
// privilegeLinkParameters, the real adapter's parameter check, then answers what the case chose.
// Links, users and bindings are real rows of a fresh App per case; the job is handed to the handler
// as the queue's executor would (ReceivedJob.attempt from 1). Only *.int.test.ts import
// @couli/db/testing and hand the database in.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createPromoPrefetchHandler,
  type PromoPrefetchHandlerOptions,
} from '../../../../apps/api/src/modules/linking/application/promo-prefetch.ts';
import {
  FixedClock,
  type JobHandler,
  type JobPayload,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { ConvertResult } from '../../../../apps/api/src/modules/union/index.ts';
import { privilegeLinkParameters } from '../../../../apps/api/src/modules/union/infra/taobao/privilege-link.ts';
import { hex } from '../shares/kit.ts';
import {
  JOB_NAME,
  QUEUE_NAME,
  promotion,
  relationId,
  type ConversionCall,
  type ConversionParameters,
} from './kit.ts';

export const NOW = '2026-10-30T02:00:00.000Z';
/** W_link of a self-buy or Agent link registered at NOW. */
const EXPIRES = '2026-10-30T02:15:00.000Z';
const QUOTED = '2026-10-30T01:59:30.000Z';
/** retryLimit 5 of the queue's catalog entry: six attempts without the handler's own limit. */
const QUEUE_ATTEMPTS = 6;

export const RAW_ITEM = 'synthetic-goods-0702';

export interface LinkOptions {
  readonly userId: string;
  readonly relationId?: string;
  readonly pid?: string;
  readonly pidScene?: 'self_buy' | 'agent';
  readonly expireAt?: string;
  readonly promoUrl?: string;
  /** Merged over the snapshot as stored; a key set to undefined is left out of the JSON. */
  readonly snapshot?: Readonly<Record<string, unknown>>;
  readonly platform?: 'taobao' | 'jd';
}

export type LinkRow = Awaited<ReturnType<JobFixture['row']>>;

export interface JobFixture {
  readonly appId: string;
  readonly clock: FixedClock;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly account: string;
  conversions(): readonly ConversionCall[];
  /** What the conversion answers; `before` runs while the call is "on the wire". */
  answer(
    result: (parameters: ConversionParameters) => ConvertResult,
    before?: () => Promise<void>,
  ): void;
  failConversion(error: Error): void;
  user(): Promise<string>;
  /** A row of union_bindings for the user; default an active one. */
  bind(userId: string, relation: string | null, status?: string): Promise<void>;
  /** A user with an active binding, as `{ userId, relation }`. */
  bound(): Promise<{ readonly userId: string; readonly relation: string }>;
  link(options: LinkOptions): Promise<string>;
  row(linkId: string): ReturnType<typeof selectLink>;
  /** A new handler over this fixture: the skeleton throws here. */
  handler(): JobHandler;
  /** One delivery of the job, attempt 1 by default; its rejection is the test's. */
  run(linkId: string, attempt?: number): Promise<void>;
}

function selectLink(db: Kysely<DB>, linkId: string) {
  return db.selectFrom('links').selectAll().where('link_id', '=', linkId).executeTakeFirstOrThrow();
}

/** The job of a link in an App. */
export function jobOf(appId: string, linkId: string): JobPayload {
  return { app_id: appId, link_id: linkId };
}

/**
 * Delivers a job as the queue would: a rejection is a failed attempt and comes back with the next
 * attempt number, until the queue's own limit. Answers how many attempts were made.
 */
export async function deliver(handler: JobHandler, payload: JobPayload): Promise<number> {
  for (let attempt = 1; attempt <= QUEUE_ATTEMPTS; attempt += 1) {
    try {
      await handler({ id: randomUUID(), queue: QUEUE_NAME, name: JOB_NAME, payload, attempt });
      return attempt;
    } catch {
      // The next attempt, as pg-boss schedules it.
    }
  }
  return QUEUE_ATTEMPTS;
}

export async function jobFixture(db: Kysely<DB>, appId = `pjob_${hex(20)}`): Promise<JobFixture> {
  const clock = new FixedClock(NOW);
  const warn = vi.fn();
  const conversions: ConversionCall[] = [];
  let answer: (parameters: ConversionParameters) => ConvertResult = () => promotion();
  let before: (() => Promise<void>) | undefined;
  let failure: Error | null = null;
  const account = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: account,
      app_id: appId,
      platform: 'taobao',
      account_name: 'synthetic-promo-job',
      status: 'active',
      auth_status: 'active',
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();

  const registry = {
    get: () => ({
      platform: 'taobao',
      async convert(
        request: Parameters<typeof privilegeLinkParameters>[0],
        identity: Parameters<typeof privilegeLinkParameters>[1],
        context: { readonly appId: string; readonly purpose: string },
      ): Promise<ConvertResult> {
        const parameters = privilegeLinkParameters(request, identity);
        conversions.push({ parameters, appId: context.appId, purpose: context.purpose });
        await before?.();
        if (failure !== null) throw failure;
        return answer(parameters);
      },
    }),
  } as unknown as PromoPrefetchHandlerOptions['registry'];

  const user = async (): Promise<string> => {
    const id = randomUUID();
    await db
      .insertInto('users')
      .values({
        id,
        app_id: appId,
        nickname: '合成用户',
        avatar: 'https://example.test/avatar',
        invite_code: `J${hex(5).toUpperCase()}`,
        attr_code: hex(8),
        level: 'L1',
        register_method: 'sms',
        status: 'normal',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    return id;
  };

  const bind = async (userId: string, relation: string | null, status = 'active') => {
    await db
      .insertInto('union_bindings')
      .values({
        id: randomUUID(),
        app_id: appId,
        user_id: userId,
        platform: 'taobao',
        union_account_id: account,
        relation_id: relation,
        status,
        bound_at: status === 'active' ? NOW : null,
        blocked_reason: status === 'blocked' ? 'admin_disable' : null,
        released_at: status === 'released' ? NOW : null,
        cooldown_until: status === 'released' ? NOW : null,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
  };

  const handler = (): JobHandler =>
    createPromoPrefetchHandler({ db, clock, registry, logger: { warn } });

  return {
    appId,
    clock,
    warn,
    account,
    conversions: () => [...conversions],
    answer: (result, hook) => {
      answer = result;
      before = hook;
    },
    failConversion: (error) => {
      failure = error;
    },
    user,
    bind,
    bound: async () => {
      const userId = await user();
      const relation = relationId();
      await bind(userId, relation);
      return { userId, relation };
    },
    link: async (options) => {
      const linkId = randomUUID();
      const pidScene = options.pidScene ?? 'self_buy';
      const platform = options.platform ?? 'taobao';
      const pid = options.pid ?? 'mm_1001_2002_3003';
      const promoUrl = options.promoUrl ?? null;
      await db
        .insertInto('links')
        .values({
          link_id: linkId,
          lk: null,
          app_id: appId,
          user_id: options.userId,
          device_id: null,
          platform,
          product_key: `tb:synthetic-${hex(10)}`,
          raw_item_id: RAW_ITEM,
          raw_fetched_at: QUOTED,
          scene: pidScene === 'agent' ? 'agent' : 'detail',
          sub_scene: null,
          pid_scene: pidScene,
          pid,
          entry_source: 'detail',
          identity_snapshot: JSON.stringify({
            user_id: options.userId,
            platform,
            pid,
            pid_scene: pidScene,
            attr_code: 'demo0001',
            agent_session_id: null,
            relation_id: options.relationId ?? null,
            ...options.snapshot,
          }),
          convert_result: null,
          cache_hit: false,
          quoted_final_price_fen: 10000n,
          quoted_coupon_fen: 2000n,
          quoted_coupon_id: null,
          quoted_at: QUOTED,
          expire_at: options.expireAt ?? EXPIRES,
          agent_session_id: null,
          agent_card_id: null,
          row_version: 0,
          created_at: QUOTED,
          updated_at: QUOTED,
          promo_url: promoUrl,
          promo_url_fetched_at: promoUrl === null ? null : QUOTED,
        })
        .execute();
      return linkId;
    },
    row: (linkId) => selectLink(db, linkId),
    handler,
    run: (linkId, attempt = 1) =>
      handler()({
        id: randomUUID(),
        queue: QUEUE_NAME,
        name: JOB_NAME,
        payload: jobOf(appId, linkId),
        attempt,
      }),
  };
}

/** The row changed in promo_url and promo_url_fetched_at at most: nothing else moved. */
export function expectOnlyPromoChanged(before: LinkRow, after: LinkRow): void {
  expect({
    ...after,
    promo_url: before.promo_url,
    promo_url_fetched_at: before.promo_url_fetched_at,
  }).toEqual(before);
}
