// B1-06i unit tests: the convert entry of the open core with in-memory ports (no database): what
// the convert log and attempt carry, and the HTTP mapping of the convert's own codes. The
// database behaviour (one transaction, rollback, replay) is the rule tests' (test/spec/linking/
// convert/**).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { AssembleCardInput, CatalogCardEntry } from '../../catalog/index.ts';
import { FixedClock, GovernanceError, type Idempotency } from '../../platform/index.ts';
import type { UnionItem, UnionPidRow } from '../../union/index.ts';
import { detailFailure, parseFailure } from './link-convert.ts';
import { openHttpResult } from './link-open.ts';
import {
  createLinkOpenRequote,
  type LinkConvertRequoteInput,
  type LinkConvertResolution,
  type LinkOpenJump,
} from './link-open-requote.ts';

const APP = 'synthetic_app';
const USER = '0199a3b4-5c6d-7000-8000-0000000000a1';
const DEVICE = '0199a3b4-5c6d-7000-8000-0000000000a2';
const NOW = '2031-05-06T07:08:09.000Z';
const JUMP: LinkOpenJump = {
  primary: { type: 'h5', value: 'https://example.test/synthetic-converted' },
  fallbacks: [],
  expire_at: '2031-05-06T07:23:09.000Z',
};

interface Write {
  readonly table: string;
  readonly values: Record<string, unknown>;
}

/** A recording stand-in for Kysely: inserts are kept, the links row is read back. */
function fakeDb() {
  const writes: Write[] = [];
  let link: Record<string, unknown> | undefined;
  function chain(table: string, op: 'insert' | 'select'): unknown {
    let values: Record<string, unknown> = {};
    const run = () => {
      if (op === 'insert') {
        writes.push({ table, values });
        if (table === 'links') {
          link = {
            ...values,
            identity_snapshot: {
              user_id: USER,
              platform: 'jd',
              pid: 'mm_1_2_3',
              pid_scene: 'self_buy',
              attr_code: 'demo0001',
              agent_session_id: null,
            },
            quoted_at: new Date(String(values['quoted_at'])),
            expire_at: new Date('2031-05-06T07:23:09.000Z'),
            promo_url: null,
            promo_url_fetched_at: null,
          };
          return link;
        }
        return undefined;
      }
      return table === 'links' ? link : undefined;
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'values') {
            return (value: Record<string, unknown>) => {
              values = value;
              return proxy;
            };
          }
          if (prop === 'execute') return () => Promise.resolve(run() === undefined ? [] : [link]);
          if (prop === 'executeTakeFirst' || prop === 'executeTakeFirstOrThrow') {
            return () => Promise.resolve(run());
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  }
  const db = {
    insertInto: (table: string) => chain(table, 'insert'),
    selectFrom: (table: string) => chain(table, 'select'),
  } as unknown as Kysely<DB>;
  return { db, writes };
}

const item = {
  platform: 'jd',
  item_id: 'jd_12345',
  title: '合成商品',
  price_fen: 2990n,
  coupon_fen: 0n,
  final_price_fen: 2990n,
  coupon_ids: '',
  quoted_at: NOW,
} as unknown as UnionItem;

function harness(userId: string | null = USER) {
  const { db, writes } = fakeDb();
  const clock = new FixedClock(NOW);
  const idempotency: Pick<Idempotency, 'executeInTransaction'> = {
    async executeInTransaction(_request, handler) {
      const result = await handler(db as Transaction<DB>);
      return { status: result.status, body: JSON.stringify(result.envelope), source: 'handler' };
    },
  };
  const catalog: CatalogCardEntry = {
    assemble: () =>
      Promise.resolve({
        kind: 'card',
        card: { link_id: 'synthetic-card-link', rebate_min_fen: 229, rebate_max_fen: 229 },
      } as unknown as Awaited<ReturnType<CatalogCardEntry['assemble']>>),
  };
  const input: AssembleCardInput = {
    item,
    ref: {
      appId: APP,
      platform: 'jd',
      productKey: 'jd:i_12345',
      rawItemId: 'jd_12345',
      rawFetchedAt: NOW,
      receivedAt: NOW,
      canonicalUrl: null,
      title: '合成商品',
      shopId: null,
      shopType: null,
      source: 'detail',
    },
    entrySource: 'detail',
    stale: false,
  };
  const core = createLinkOpenRequote({
    db,
    clock,
    callerContext: {
      current: () => Promise.resolve({ appId: APP, userId, deviceId: DEVICE }),
    },
    attrCodes: { attrCode: () => Promise.resolve('demo0001') },
    config: { configValue: () => Promise.resolve(null) },
    pids: {
      getActivePid: (query) =>
        Promise.resolve({
          app_id: APP,
          platform: query.platform,
          pid_scene: query.pidScene,
          pid: 'mm_1_2_3',
          status: 'active',
        } as unknown as UnionPidRow),
    },
    catalog,
    prices: { fetch: () => Promise.resolve({ kind: 'available', input }) },
    conversion: { convert: () => Promise.resolve(JUMP) },
    cache: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    idempotency,
  });
  const request = (resolution: LinkConvertResolution): LinkConvertRequoteInput => ({
    platform: 'jd',
    idempotencyKey: 'synthetic-convert-key',
    traceId: 'synthetic-trace',
    client: 'ios',
    installed: 'unknown',
    spm: 'h5.synthetic.entry',
    body: { platform: 'jd', product_key: 'jd:i_12345', scene: 'h5', installed: 'unknown' },
    resolve: () => Promise.resolve(resolution),
  });
  return { core, writes, request };
}

const target: LinkConvertResolution = {
  kind: 'target',
  target: {
    platform: 'jd',
    productKey: 'jd:i_12345',
    rawItemId: 'jd_12345',
    rawFetchedAt: NOW,
    item,
    shopId: null,
    entrySource: 'detail',
  },
};

describe('linking convert core (B1-06i)', () => {
  it('[AC-B1-06i] success registers an h5 self_buy link, logs event=convert with product and raw id, and one attempt', async () => {
    const { core, writes, request } = harness();
    const outcome = await core.convert(request(target));
    expect(outcome.code).toBe(0);
    const links = writes.filter((write) => write.table === 'links');
    expect(links).toHaveLength(1);
    expect(links[0]!.values).toMatchObject({
      app_id: APP,
      user_id: USER,
      device_id: DEVICE,
      scene: 'h5',
      pid_scene: 'self_buy',
      product_key: 'jd:i_12345',
      raw_item_id: 'jd_12345',
      entry_source: 'detail',
    });
    const linkId = links[0]!.values['link_id'];
    const logs = writes.filter((write) => write.table === 'link_logs');
    expect(logs.map((write) => write.values)).toEqual([
      expect.objectContaining({
        event: 'convert',
        link_id: linkId,
        result_code: 0,
        product_key: 'jd:i_12345',
        raw_item_id: 'jd_12345',
        spm: 'h5.synthetic.entry',
        scene: 'h5',
        pid_scene: 'self_buy',
        user_id: USER,
        opener_user_id: USER,
      }),
    ]);
    const attempts = writes.filter((write) => write.table === 'link_open_attempts');
    expect(attempts).toHaveLength(1);
    expect(outcome.data).toMatchObject({
      link_id: linkId,
      attempt_id: attempts[0]!.values['attempt_id'],
      jump: JUMP,
      requote_failed: false,
    });
  });

  it('[AC-B1-06i] a refusal before registration logs event=convert without a link and keeps its fields', async () => {
    const { core, writes, request } = harness();
    const outcome = await core.convert(
      request({
        kind: 'refused',
        code: 20001,
        productKey: 'jd:i_12345',
        data: { fields: ['item_ref'] },
      }),
    );
    expect(outcome).toEqual({
      code: 20001,
      data: null,
      error: { fields: ['item_ref'] },
      traceId: 'synthetic-trace',
    });
    expect(writes.filter((write) => write.table !== 'link_logs')).toEqual([]);
    expect(writes.map((write) => write.values)).toEqual([
      expect.objectContaining({
        event: 'convert',
        link_id: null,
        result_code: 20001,
        product_key: 'jd:i_12345',
      }),
    ]);
    expect(JSON.stringify(writes)).not.toContain('item_ref"');
    expect(openHttpResult(outcome, 'synthetic-trace').envelope.data).toEqual({
      fields: ['item_ref'],
    });
  });

  it('[AC-B1-06i] a guest is asked to log in before anything is resolved or written', async () => {
    const { core, writes, request } = harness(null);
    let resolved = false;
    const outcome = await core.convert({
      ...request(target),
      resolve: () => {
        resolved = true;
        return Promise.resolve(target);
      },
    });
    expect(outcome).toEqual({ code: 10001, data: null });
    expect(resolved).toBe(false);
    expect(writes).toEqual([]);
  });

  it.each([
    [30131, 422],
    [30143, 422],
    [30141, 422],
  ])('[AC-B1-06i] convert code %i keeps HTTP %i', (code, status) => {
    expect(openHttpResult({ code, data: null }, 'synthetic-trace').status).toBe(status);
  });
});

describe('linking convert upstream governance failures (B1-06i)', () => {
  const dependencyDown = ['timeout', 'quota_exceeded', 'circuit_open'] as const;

  it.each(dependencyDown)(
    '[AC-B1-06i#10] a governed catalog / union call failing with %s is 50303, not a fault',
    (code) => {
      const error = new GovernanceError(code, 'union.jd', 'synthetic governance failure');
      const result = detailFailure(error, 'jd:i_12345');
      expect(result).toEqual({ kind: 'refused', code: 50303, productKey: 'jd:i_12345' });
    },
  );

  it.each(dependencyDown)(
    '[AC-B1-06i#10] a governed parse call failing with %s is 50303, not a fault',
    (code) => {
      const error = new GovernanceError(code, 'union.jd', 'synthetic governance failure');
      expect(parseFailure(error)).toEqual({ kind: 'refused', code: 50303, productKey: null });
    },
  );

  it("[AC-B1-06i#10] parsing's dependency-down 50301 is the convert's 50303", () => {
    const error = Object.assign(new Error('synthetic parse failure'), { code: 50301 });
    expect(parseFailure(error)).toEqual({ kind: 'refused', code: 50303, productKey: null });
  });

  it('[AC-B1-06i] invalid_policy is a configuration fault on both paths', () => {
    const error = new GovernanceError('invalid_policy', 'union.jd', 'synthetic bad policy');
    expect(detailFailure(error, 'jd:i_12345').kind).toBe('fault');
    expect(parseFailure(error).kind).toBe('fault');
  });

  it('[AC-B1-06i] a governed refusal before registration is logged as a convert failure', async () => {
    const { core, writes, request } = harness();
    const refusal = detailFailure(
      new GovernanceError('timeout', 'union.jd', 'synthetic governance failure'),
      'jd:i_12345',
    );
    const outcome = await core.convert(request(refusal));
    expect(openHttpResult(outcome, 'synthetic-trace').status).toBe(503);
    expect(outcome.code).toBe(50303);
    const logs = writes.filter((write) => write.table === 'link_logs');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.values).toMatchObject({ event: 'convert', result_code: 50303 });
    expect(writes.some((write) => write.table === 'link_open_attempts')).toBe(false);
    expect(writes.some((write) => write.table === 'links')).toBe(false);
  });
});
