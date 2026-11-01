// B1-06zd unit tests: the parts of the promotion link that need no database or Redis — what a
// conversion gives, the route check, the limiter's window, the registration's side of the prefetch
// for an Agent link (the rule tests reach it through the detail route only) and the job's retry cap
// on a failing database step. The job and the detail route on a real database are the rule tests'
// (test/spec/linking/promo-url/**).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { FixedClock, type RedisHandle } from '../../platform/index.ts';
import {
  createPromoPrefetch,
  createPromoPrefetchHandler,
  createPromoPrefetchLimiter,
  isProductDetailRoute,
  taobaoPromotionOf,
  type PromoPrefetchLimiter,
  type PromoPrefetchOptions,
} from './promo-prefetch.ts';

const APP = 'synthetic_app';
const USER = '0199a3b4-5c6d-7000-8000-0000000000a1';
const LINK = '0199a3b4-5c6d-7000-8000-0000000000b1';
const ACCOUNT = '0199a3b4-5c6d-7000-8000-0000000000c1';
const SLOT = 'mm_1_2_3';
const NOW = '2026-10-30T02:00:30.000Z';
const SHORT = 'https://s.example.test/t';
const COUPON = 'https://u.example.test/c';
const AGENT_CARD = {
  platform: 'taobao',
  entrySource: 'detail',
  userId: USER,
  rebateBasis: 'normal',
} as const;

/** union_bindings as one row: the only table the registration's side reads. */
function bindingDb(row: object | undefined): Kysely<DB> {
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: () => Promise.resolve(row),
  };
  return { selectFrom: () => query } as unknown as Kysely<DB>;
}

function harness(overrides: Partial<PromoPrefetchOptions> = {}) {
  const send = vi.fn<PromoPrefetchOptions['queue']['send']>(() => Promise.resolve('job'));
  const warn = vi.fn();
  const take = vi.fn<PromoPrefetchLimiter['take']>(() => Promise.resolve(true));
  const getActivePid = vi.fn(() => Promise.resolve({ pid: SLOT }));
  const prefetch = createPromoPrefetch({
    db: bindingDb({ relation_id: '912345678', union_account_id: ACCOUNT }),
    clock: new FixedClock(NOW),
    config: { configValue: () => Promise.resolve({ value: true, version: 1 }) },
    pids: { getActivePid } as unknown as PromoPrefetchOptions['pids'],
    queue: { send },
    limiter: { take },
    logger: { warn },
    ...overrides,
  });
  return { prefetch, send, warn, take, getActivePid };
}

describe('taobaoPromotionOf (B1-06zd)', () => {
  const url = (parts: object) => ({
    kind: 'url' as const,
    url: 'https://item.example.test',
    ...parts,
  });

  it('[AC-B1-06zd] share link short first, promotion link coupon first, each falling back', () => {
    expect(
      taobaoPromotionOf(url({ short_url: SHORT, coupon_click_url: COUPON, tpwd: 'x' })),
    ).toEqual({
      shareUrl: SHORT,
      promoUrl: COUPON,
      tpwd: 'x',
    });
    expect(taobaoPromotionOf(url({ short_url: SHORT }))).toEqual({
      shareUrl: SHORT,
      promoUrl: SHORT,
      tpwd: null,
    });
  });

  it('[AC-B1-06zd] the plain url is never a promotion link; an unusable field counts as absent', () => {
    expect(taobaoPromotionOf(url({}))).toBeNull();
    expect(taobaoPromotionOf(url({ short_url: 'http://s.example.test/t' }))).toBeNull();
    expect(
      taobaoPromotionOf(
        url({ short_url: `${SHORT}${'a'.repeat(2048)}`, coupon_click_url: COUPON }),
      ),
    ).toMatchObject({ shareUrl: COUPON, promoUrl: COUPON });
  });
});

describe('createPromoPrefetchHandler retry cap (B1-06zd)', () => {
  const SECRET = 'synthetic database detail';
  const LINK_ROW = {
    user_id: USER,
    platform: 'taobao',
    pid: SLOT,
    pid_scene: 'self',
    raw_item_id: '1',
    identity_snapshot: {
      platform: 'taobao',
      pid_scene: 'self',
      user_id: USER,
      pid: SLOT,
      relation_id: '912345678',
      attr_code: 'code',
    },
    promo_url: null,
    expire_at: new Date('2026-10-30T02:10:00.000Z'),
  };
  const BINDING = { relation_id: '912345678', union_account_id: ACCOUNT };

  /** The handler's three database steps, each answering or failing. */
  function jobHarness(reads: {
    links?: () => Promise<unknown>;
    bindings?: () => Promise<unknown>;
    write?: () => Promise<unknown>;
  }) {
    const answer = {
      links: reads.links ?? (() => Promise.resolve(LINK_ROW)),
      union_bindings: reads.bindings ?? (() => Promise.resolve(BINDING)),
    };
    const update = {
      set: () => update,
      where: () => update,
      execute: reads.write ?? (() => Promise.resolve([])),
    };
    const db = {
      selectFrom: (table: keyof typeof answer) => {
        const query = {
          select: () => query,
          where: () => query,
          executeTakeFirst: answer[table],
        };
        return query;
      },
      updateTable: () => update,
    } as unknown as Kysely<DB>;
    const convert = vi.fn(() =>
      Promise.resolve({ kind: 'url', url: COUPON, coupon_click_url: COUPON }),
    );
    const warn = vi.fn();
    const handler = createPromoPrefetchHandler({
      db,
      clock: new FixedClock(NOW),
      registry: { get: () => ({ convert }) } as never,
      logger: { warn },
    });
    const run = (attempt: number) =>
      handler({
        id: 'job',
        queue: 'pool-refresh',
        name: 'linking.promo_prefetch',
        payload: { app_id: APP, link_id: LINK },
        attempt,
      });
    return { run, convert, warn };
  }

  const failing = () => Promise.reject(new Error(SECRET));

  it.each([
    { label: 'the links read', reads: { links: failing }, conversions: 0 },
    { label: 'the bindings read', reads: { bindings: failing }, conversions: 0 },
    { label: 'the promo_url write', reads: { write: failing }, conversions: 1 },
  ])(
    '[AC-B1-06zd] $label failing: one retry, without the original error',
    async ({ reads, conversions }) => {
      const { run, convert } = jobHarness(reads);

      const rejected = await run(1).catch((error: unknown) => error);

      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).message).not.toContain(SECRET);
      expect(convert).toHaveBeenCalledTimes(conversions);
    },
  );

  it.each([
    { label: 'the links read', reads: { links: failing } },
    { label: 'the bindings read', reads: { bindings: failing } },
    { label: 'the promo_url write', reads: { write: failing } },
  ])('[AC-B1-06zd] $label failing again: logged, the job ends normally', async ({ reads }) => {
    const { run, warn } = jobHarness(reads);

    await expect(run(2)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'linking.promo_prefetch.failed', attempt: 2 }),
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it('[AC-B1-06zd] a conversion without a token still fills the link: only a share needs it', async () => {
    const write = vi.fn(() => Promise.resolve([]));
    const { run, warn } = jobHarness({ write });

    await expect(run(1)).resolves.toBeUndefined();

    expect(write).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('isProductDetailRoute (B1-06zd)', () => {
  it('[AC-B1-06zd] only the product detail route offers a prefetch', () => {
    const route = (url: string) => ({ routeOptions: { url } });
    expect(isProductDetailRoute(route('/v1/products/:product_key'))).toBe(true);
    expect(isProductDetailRoute(route('/v1/favorites'))).toBe(false);
    expect(isProductDetailRoute(route('/v1/products/search'))).toBe(false);
    expect(isProductDetailRoute(undefined)).toBe(false);
  });
});

describe('createPromoPrefetchLimiter (B1-06zd)', () => {
  it('[AC-B1-06zd] one counter per App and minute, up to the limit; no Redis gives no budget', async () => {
    const evaluate = vi.fn<(script: string, options: object) => Promise<unknown>>();
    const redis = { namespace: () => ({ eval: evaluate }) } as unknown as RedisHandle;
    const limiter = createPromoPrefetchLimiter(redis);

    evaluate.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    expect(await limiter.take(APP, 7, 2)).toBe(true);
    expect(await limiter.take(APP, 7, 2)).toBe(false);
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({ keys: [`${APP}:7`] });
    expect(await createPromoPrefetchLimiter(undefined).take(APP, 7, 2)).toBe(false);
  });
});

describe('createPromoPrefetch for an Agent link (B1-06zd)', () => {
  const slot = { pid: SLOT, pidScene: 'agent' } as const;

  it('[AC-B1-06zd] an Agent detail link freezes the relation_id, read for the agent slot of the binding account', async () => {
    const { prefetch, getActivePid } = harness();

    expect(await prefetch.relationOf(APP, AGENT_CARD, slot)).toBe('912345678');
    expect(getActivePid).toHaveBeenCalledWith({
      appId: APP,
      platform: 'taobao',
      pidScene: 'agent',
      purpose: 'convert',
      unionAccountId: ACCOUNT,
    });
  });

  it('[AC-B1-06zd] an Agent search card reads nothing and gets no job', async () => {
    const configValue = vi.fn(() => Promise.resolve(null));
    const { prefetch } = harness({ config: { configValue } });

    const card = { ...AGENT_CARD, entrySource: 'search' };
    expect(await prefetch.relationOf(APP, card, slot)).toBeNull();
    expect(configValue).not.toHaveBeenCalled();
  });

  it('[AC-B1-06zd] BR-ATTR-07: a snapshot slot outside the binding account gets no job', async () => {
    const { prefetch, getActivePid } = harness();
    getActivePid.mockResolvedValueOnce({ pid: 'mm_9_9_9' });

    expect(await prefetch.relationOf(APP, AGENT_CARD, slot)).toBeNull();
  });

  it('[AC-B1-06zd] switch off, or a failed read, offers nothing and does not fail the card', async () => {
    const off = harness({ config: { configValue: () => Promise.resolve(null) } });
    expect(await off.prefetch.relationOf(APP, AGENT_CARD, slot)).toBeNull();

    const broken = harness({ db: bindingDb(undefined) });
    expect(await broken.prefetch.relationOf(APP, AGENT_CARD, slot)).toBeNull();

    const failing = harness({
      config: { configValue: () => Promise.reject(new Error('synthetic')) },
    });
    expect(await failing.prefetch.relationOf(APP, AGENT_CARD, slot)).toBeNull();
    expect(failing.warn).toHaveBeenCalledOnce();
  });

  it('[AC-B1-06zd] enqueue sends one job outside any transaction, in the minute it was called', async () => {
    const { prefetch, send, take } = harness();

    prefetch.enqueue(APP, LINK);

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(take.mock.calls[0]?.[1]).toBe(Math.floor(Date.parse(NOW) / 60_000));
    expect(send).toHaveBeenCalledWith(
      'pool-refresh',
      'linking.promo_prefetch',
      { app_id: APP, link_id: LINK },
      { trx: null, id: LINK },
    );
  });

  it('[AC-B1-06zd] over the limit nothing is sent; a failed send is only logged', async () => {
    const over = harness({ limiter: { take: () => Promise.resolve(false) } });
    over.prefetch.enqueue(APP, LINK);
    await new Promise((resolve) => setImmediate(resolve));
    expect(over.send).not.toHaveBeenCalled();

    const broken = harness({
      queue: { send: () => Promise.reject(new Error('synthetic')) },
    });
    broken.prefetch.enqueue(APP, LINK);
    await vi.waitFor(() => expect(broken.warn).toHaveBeenCalledOnce());
  });
});
