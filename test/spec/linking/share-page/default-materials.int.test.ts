// B1-15u (D10-424): the production SharePageMaterials provider, wired as the real api entry ships it.
// Unlike kit.ts's shareHarness, nothing in LinkingModule is replaced: the material is read from the
// existing data only (POST /v1/shares is not planned yet), so no short link and no token is made up.
// - A Taobao share link with links.promo_url → 200, jump_url = promo_url, tpwd_ticket null under any
//   User-Agent, and every token exchange is 20001 data.fields=[ticket].
// - A Taobao share link without promo_url, and JD / PDD share links (no material in the existing
//   data) → 30144: SharePageData.jump_url is not nullable, and no new error code is added.
// The sharer-authorization check runs before the material; page.int.test.ts already covers it.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import {
  BROWSER_UAS,
  MISSING,
  NOW,
  QUOTED,
  TRACE,
  UA,
  WECHAT_LIKE,
  expectLandingDeepLink,
  expectRefused,
  expectSharedSubset,
  expectTicketRefused,
  pageData,
  persisted,
  type InjectResponse,
  type SharePlatform,
} from './kit.ts';

const LINK_EXPIRES = '2026-11-29T02:00:00.000Z';
const ROOT = new URL('../../../../', import.meta.url);
/** Every field of SharePageData: none of them may appear in a 30144 envelope. */
const PAGE_FIELDS = [
  'product_card',
  'quoted_at',
  'jump_url',
  'tpwd_ticket',
  'open_in_app_url',
] as const;

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string | undefined>;
    payload?: string;
    remoteAddress: string;
  }): Promise<InjectResponse>;
}

const clock = new FixedClock(NOW);
const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB> | undefined;
let app: HttpApp | undefined;
let convertCalls = (): number => 0;
let address = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
  // Observed only, not replaced: the default provider must never convert to make up a material.
  const convert = vi.spyOn(DemoUnionAdapter.prototype, 'convert');
  convertCalls = () => convert.mock.calls.length;
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: typeof logger;
        dbHandles: DbHandles;
        redisUrl: ConnectionConfig['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const connection = loadConnectionConfig('api', {
    DATABASE_URL: database.urlFor('couli_app'),
    REDIS_URL: redis.url,
  });
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: connection.redisUrl,
  });
  await app.init();
}, 180_000);

beforeEach(() => {
  clock.set(NOW);
});

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    vi.restoreAllMocks();
    try {
      if (db !== undefined) await destroyDb(db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await redis?.stop();
      }
    }
  }
}, 60_000);

const handle = (): Kysely<DB> => db!;

function hex(length: number): string {
  return randomUUID().replaceAll('-', '').slice(0, length);
}

function headersFor(appId: string, ua: string | null): Record<string, string | undefined> {
  return {
    'x-app-id': appId,
    'x-platform': 'h5',
    'x-app-version': '1.0.0',
    'x-trace-id': TRACE,
    // undefined removes the header from the injected request (no User-Agent at all).
    'user-agent': ua ?? undefined,
  };
}

function get(appId: string, linkId: string, ua: string | null = UA.safariIos) {
  return app!.inject({
    method: 'GET',
    url: `/v1/share-pages/${encodeURIComponent(linkId)}`,
    headers: headersFor(appId, ua),
    remoteAddress: '198.51.100.31',
  });
}

/** Each exchange from its own address: the IP × link_id rate limit never decides here. */
function tpwd(appId: string, linkId: string, ticket: string, ua: string | null = UA.safariIos) {
  address++;
  return app!.inject({
    method: 'POST',
    url: `/v1/share-pages/${encodeURIComponent(linkId)}/tpwd`,
    headers: { ...headersFor(appId, ua), 'content-type': 'application/json' },
    payload: JSON.stringify({ ticket }),
    remoteAddress: `10.15.${Math.floor(address / 250)}.${(address % 250) + 1}`,
  });
}

interface Seeded {
  readonly appId: string;
  /** A user whose Taobao and PDD bindings are active (JD is never checked). */
  sharer(): Promise<string>;
  /** A share link as the existing data holds it: promo_url as given, nothing else of the share. */
  link(sharerId: string, platform: SharePlatform, promoUrl: string | null): Promise<string>;
}

async function tenant(): Promise<Seeded> {
  const appId = `share_${hex(20)}`;
  const accounts: Record<SharePlatform, string> = {
    taobao: randomUUID(),
    jd: randomUUID(),
    pdd: randomUUID(),
  };
  for (const platform of ['taobao', 'jd', 'pdd'] as const) {
    await handle()
      .insertInto('union_accounts')
      .values({
        id: accounts[platform],
        app_id: appId,
        platform,
        account_name: `synthetic-share-${platform}`,
        status: 'active',
        auth_status: 'active',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  }

  async function sharer(): Promise<string> {
    const userId = randomUUID();
    await handle()
      .insertInto('users')
      .values({
        id: userId,
        app_id: appId,
        nickname: '合成分享者',
        avatar: 'https://example.test/avatar',
        invite_code: hex(8),
        attr_code: hex(8),
        level: 'T1',
        register_method: 'synthetic',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    for (const platform of ['taobao', 'pdd'] as const) {
      await handle()
        .insertInto('union_bindings')
        .values({
          id: randomUUID(),
          app_id: appId,
          user_id: userId,
          platform,
          union_account_id: accounts[platform],
          relation_id: platform === 'taobao' ? `9${hex(8).replace(/[a-f]/g, '7')}` : null,
          pdd_custom: platform === 'pdd' ? JSON.stringify({ synthetic: userId }) : null,
          status: 'active',
          bound_at: clock.now(),
          blocked_reason: null,
          released_at: null,
          cooldown_until: null,
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
    }
    return userId;
  }

  async function link(
    sharerId: string,
    platform: SharePlatform,
    promoUrl: string | null,
  ): Promise<string> {
    const linkId = randomUUID();
    await handle()
      .insertInto('links')
      .values({
        link_id: linkId,
        lk: null,
        app_id: appId,
        user_id: sharerId,
        device_id: null,
        platform,
        product_key: `${platform}:synthetic-share-${hex(6)}`,
        raw_item_id: `synthetic-${hex(10)}`,
        raw_fetched_at: QUOTED,
        scene: 'share',
        sub_scene: null,
        pid_scene: 'share',
        pid: 'synthetic-share',
        entry_source: 'search',
        identity_snapshot: {
          user_id: sharerId,
          platform,
          pid: 'synthetic-share',
          pid_scene: 'share',
          attr_code: 'demo0001',
          agent_session_id: null,
        },
        convert_result: null,
        cache_hit: false,
        quoted_final_price_fen: 10000n,
        quoted_coupon_fen: 2000n,
        quoted_coupon_id: null,
        quoted_at: QUOTED,
        expire_at: LINK_EXPIRES,
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
  }

  return { appId, sharer, link };
}

it('[AC-B1-15u#9] 缺省物料提供者：淘宝分享 link 有 promo_url → 200，jump_url 即 promo_url，任何 UA（含系统浏览器）下 tpwd_ticket 都为 null；GET 只读、不转链', async () => {
  const t = await tenant();
  const promoUrl = `https://s.click.example.test/t?e=promo${hex(16)}`;
  const linkId = await t.link(await t.sharer(), 'taobao', promoUrl);
  const before = await persisted(handle());
  const calls = convertCalls();
  for (const ua of [...BROWSER_UAS, ...WECHAT_LIKE]) {
    const data = await pageData(await get(t.appId, linkId, ua));
    expect(data).toMatchObject({
      quoted_at: QUOTED,
      jump_url: promoUrl,
      // The existing data holds no token: nothing to exchange, not even outside WeChat.
      tpwd_ticket: null,
      product_card: { link_id: linkId, platform: 'taobao' },
    });
    expectSharedSubset(data.product_card);
    expectLandingDeepLink(data.open_in_app_url, linkId);
  }
  expect(await persisted(handle())).toEqual(before);
  expect(convertCalls()).toBe(calls);
}, 60_000);

it('[AC-B1-15u#9] 缺省物料提供者：取口令一律 20001 data.fields=[ticket]、不返回口令（淘宝有 promo_url、无 promo_url，京东、拼多多分享 link，任何票据，系统浏览器 UA）', async () => {
  const t = await tenant();
  const sharer = await t.sharer();
  const promoUrl = `https://s.click.example.test/t?e=promo${hex(16)}`;
  const links = [
    await t.link(sharer, 'taobao', promoUrl),
    await t.link(sharer, 'taobao', null),
    await t.link(sharer, 'jd', null),
    await t.link(sharer, 'pdd', null),
  ];
  const first = await pageData(await get(t.appId, links[0]!, UA.chromeAndroid));
  expect(first.tpwd_ticket).toBeNull();
  const calls = convertCalls();
  const forgeries = ['forged-ticket', randomUUID(), promoUrl, `￥SynTpwd${hex(12)}￥`];
  for (const linkId of links) {
    for (const forged of [...forgeries, linkId]) {
      for (const ua of BROWSER_UAS) {
        await expectTicketRefused(await tpwd(t.appId, linkId, forged, ua));
      }
    }
  }
  expect(convertCalls()).toBe(calls);
}, 60_000);

it('[AC-B1-15u#10] 缺省物料提供者：淘宝分享 link 无 promo_url（null 或空串）、京东或拼多多分享 link（现有数据里无物料）→ 30144，与不存在的 link 同一个响应，不带任何卡片字段', async () => {
  const t = await tenant();
  const sharer = await t.sharer();
  const linkIds = [
    await t.link(sharer, 'taobao', null),
    await t.link(sharer, 'taobao', ''),
    await t.link(sharer, 'jd', null),
    await t.link(sharer, 'pdd', null),
  ];
  const missing = await expectRefused(await get(t.appId, MISSING), 404, 30144);
  const before = await persisted(handle());
  const calls = convertCalls();
  for (const linkId of linkIds) {
    for (const ua of [UA.safariIos, UA.desktop, UA.wechatIos, null]) {
      const response = await get(t.appId, linkId, ua);
      const body = await expectRefused(response, 404, 30144);
      for (const field of PAGE_FIELDS) {
        expect(body).not.toHaveProperty(field);
        expect(body.data ?? {}).not.toHaveProperty(field);
      }
      expect(response.payload).not.toContain(linkId);
      expect(response.json()).toEqual(missing);
    }
  }
  expect(await persisted(handle())).toEqual(before);
  // No made-up short link: the provider never converts to fill the gap.
  expect(convertCalls()).toBe(calls);
}, 60_000);
