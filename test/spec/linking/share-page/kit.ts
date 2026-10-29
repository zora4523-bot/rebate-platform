// B1-15u rule-test kit: the real api entry (createHttpApp + inject) over a throwaway PostgreSQL and
// Redis, an injected FixedClock, and one replaced port only — SharePageMaterials, the sharer's
// converted short link and token of a share link (where they are stored is not fixed by the
// contract yet). Links, bindings, union accounts, configuration, tickets and rate limits are real.
// Every case seeds its own App (tenant), so configuration caches and rate-limit buckets of one case
// never reach another. Requests carry no Authorization, no X-Device-Id and no signature.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import type { LandingLink } from '../../../../apps/api/src/modules/linking/application/link-landing.ts';
import {
  SharePageMaterials,
  type SharePageMaterial,
} from '../../../../apps/api/src/modules/linking/application/share-page.ts';
import { LinkingModule } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';

export const NOW = '2026-10-30T02:00:00.000Z';
export const QUOTED = '2026-10-30T01:58:30.000Z';
/** W_link of the seeded share links: far after every instant the cases move the clock to. */
const LINK_EXPIRES = '2026-11-29T02:00:00.000Z';
export const TRACE = '0199a3b4-5c6d-7000-8000-0000000015a1';
export const MISSING = '0199a3b4-5c6d-7000-8000-0000000015a2';
/** BR-ATTR-10 细则: a ticket is valid 600 seconds and exchanges at most 3 times. */
export const TICKET_TTL_MS = 600_000;
export const TICKET_USES = 3;
/** BR-ATTR-10 细则: share.tpwd_rate_per_min defaults to 5 per IP × link_id and minute. */
export const DEFAULT_RATE = 5;
export const RATE_KEY = 'share.tpwd_rate_per_min';
export const OPEN_IN_APP_KEY = 'share.open_in_app.enabled';

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

/** Real-world User-Agent samples; only the two WeChat ones carry MicroMessenger. */
export const UA = {
  wechatIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003137) NetType/WIFI Language/zh_CN',
  wechatAndroid:
    'Mozilla/5.0 (Linux; Android 14; V2309A Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.120 Mobile Safari/537.36 XWEB/1220099 MMWEBSDK/20240404 MMWEBID/2586 MicroMessenger/8.0.49.2600(0x28003133) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  desktop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
} as const;
export const BROWSER_UAS: readonly string[] = [UA.safariIos, UA.chromeAndroid, UA.desktop];
export const WECHAT_UAS: readonly string[] = [UA.wechatIos, UA.wechatAndroid];
/** Requests judged as WeChat: the WeChat browsers, no User-Agent header (null) and an empty one. */
export const WECHAT_LIKE: readonly (string | null)[] = [...WECHAT_UAS, null, ''];

export type SharePlatform = 'taobao' | 'jd' | 'pdd';
export type SharerPlatform = 'taobao' | 'pdd';
export type BindingStatus =
  'absent' | 'unbound' | 'pending_auth' | 'active' | 'invalid' | 'blocked' | 'released';
export type SharePageData = components['schemas']['SharePageData'];
type SharePageResponse = components['schemas']['SharePageResponse'];
type ShareTpwdResponse = components['schemas']['ShareTpwdResponse'];

export interface InjectResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  readonly payload: string;
  json(): unknown;
}

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

export interface RequestOptions {
  /** Omitted: an iOS Safari User-Agent. null: no User-Agent header at all. */
  readonly ua?: string | null;
  readonly ip?: string;
}

/** One seeded share link and the material the replaced port hands out for it. */
export interface ShareLink {
  readonly linkId: string;
  readonly jumpUrl: string;
  /** The token of the link; null when it has none. */
  readonly tpwd: string | null;
  /** The ASCII part of the token, searched for in raw payloads and headers; '' without token. */
  readonly tpwdCore: string;
}

export interface LinkChanges {
  readonly scene?: string;
  readonly pidScene?: string | null;
  /** Omitted: a token for taobao links, none for jd and pdd. */
  readonly tpwd?: string | null;
}

export interface Tenant {
  readonly appId: string;
  /** A user of this App with the given bindings (no row for a platform not named or 'absent'). */
  sharer(bindings?: Partial<Readonly<Record<SharerPlatform, BindingStatus>>>): Promise<string>;
  /** A link registered by the sharer; a share link unless the changes say otherwise. */
  link(sharerId: string, platform: SharePlatform, changes?: LinkChanges): Promise<ShareLink>;
  /** BR-ID-24: the site authorization of this App's union account is expired. */
  expireSiteAuth(platform: SharerPlatform): Promise<void>;
  /** Inserts one config_items row (a tenant writes each key at most once). */
  setConfig(key: string, value: unknown): Promise<void>;
}

export interface ShareHarness {
  readonly clock: FixedClock;
  db(): Kysely<DB>;
  tenant(config?: Readonly<Record<string, unknown>>): Promise<Tenant>;
  get(appId: string, linkId: string, options?: RequestOptions): Promise<InjectResponse>;
  tpwd(
    appId: string,
    linkId: string,
    ticket: string,
    options?: RequestOptions,
  ): Promise<InjectResponse>;
  /** Calls of the union adapters' convert since the last clearConvert(). */
  convertCalls(): number;
  clearConvert(): void;
}

function hex(length: number): string {
  return randomUUID().replaceAll('-', '').slice(0, length);
}

function headersFor(
  appId: string,
  ua: string | null | undefined,
): Record<string, string | undefined> {
  const agent = ua === undefined ? UA.safariIos : ua;
  return {
    'x-app-id': appId,
    'x-platform': 'h5',
    'x-app-version': '1.0.0',
    'x-trace-id': TRACE,
    // undefined removes the header from the injected request (no User-Agent at all).
    'user-agent': agent ?? undefined,
  };
}

/**
 * Registers the file's hooks: one api entry for the whole file, built with the real default
 * wiring except the SharePageMaterials provider of LinkingModule.
 */
export function shareHarness(): ShareHarness {
  const clock = new FixedClock(NOW);
  const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
  const materials = new Map<string, SharePageMaterial>();
  async function read(link: LandingLink): Promise<SharePageMaterial | null> {
    return materials.get(link.link_id) ?? null;
  }
  let database: TestDatabase | undefined;
  let redis: TestRedis | undefined;
  let db: Kysely<DB> | undefined;
  let app: HttpApp | undefined;
  let convertCalls = (): number => 0;
  let clearConvert = (): void => undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
    redis = await acquireTestRedis();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
    const forRoot = LinkingModule.forRoot;
    vi.spyOn(LinkingModule, 'forRoot').mockImplementation((...args) => {
      const module = forRoot(...args);
      return {
        ...module,
        providers: [
          ...(module.providers ?? []).filter((provider) => {
            return typeof provider !== 'object' || provider.provide !== SharePageMaterials;
          }),
          { provide: SharePageMaterials, useValue: { read } },
        ],
      };
    });
    const convert = vi.spyOn(DemoUnionAdapter.prototype, 'convert');
    convertCalls = () => convert.mock.calls.length;
    clearConvert = () => {
      convert.mockClear();
    };
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

  async function tenant(config: Readonly<Record<string, unknown>> = {}): Promise<Tenant> {
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

    async function setConfig(key: string, value: unknown): Promise<void> {
      await handle()
        .insertInto('config_items')
        .values({
          app_id: appId,
          key,
          value: JSON.stringify(value),
          updated_by: 'synthetic-share-page',
        })
        .execute();
    }
    for (const [key, value] of Object.entries(config)) await setConfig(key, value);

    async function sharer(
      bindings: Partial<Readonly<Record<SharerPlatform, BindingStatus>>> = {},
    ): Promise<string> {
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
        const status = bindings[platform] ?? 'absent';
        if (status === 'absent') continue;
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
            status,
            bound_at: status === 'active' ? clock.now() : null,
            blocked_reason: status === 'blocked' ? 'admin_disable' : null,
            released_at: status === 'released' ? clock.now() : null,
            cooldown_until: status === 'released' ? clock.now() : null,
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
      changes: LinkChanges = {},
    ): Promise<ShareLink> {
      const linkId = randomUUID();
      const pidScene = changes.pidScene === undefined ? 'share' : changes.pidScene;
      const core = `SynTpwd${hex(12)}`;
      const taobaoTpwd = platform === 'taobao' ? `￥${core}￥` : null;
      const tpwd = changes.tpwd === undefined ? taobaoTpwd : changes.tpwd;
      const jumpUrl = `https://s.click.example.test/t?e=share${hex(16)}`;
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
          scene: changes.scene ?? (pidScene === 'share' ? 'share' : 'detail'),
          sub_scene: null,
          pid_scene: pidScene,
          pid: `synthetic-${pidScene ?? 'none'}`,
          entry_source: 'search',
          identity_snapshot: {
            user_id: sharerId,
            platform,
            pid: `synthetic-${pidScene ?? 'none'}`,
            pid_scene: pidScene,
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
          promo_url: platform === 'taobao' ? jumpUrl : null,
          promo_url_fetched_at: platform === 'taobao' ? QUOTED : null,
        })
        .execute();
      materials.set(linkId, { jumpUrl, tpwd });
      return { linkId, jumpUrl, tpwd, tpwdCore: tpwd === null ? '' : tpwd.replaceAll('￥', '') };
    }

    async function expireSiteAuth(platform: SharerPlatform): Promise<void> {
      await handle()
        .updateTable('union_accounts')
        .set({ auth_status: 'expired' })
        .where('app_id', '=', appId)
        .where('id', '=', accounts[platform])
        .execute();
    }

    return { appId, sharer, link, expireSiteAuth, setConfig };
  }

  return {
    clock,
    db: handle,
    tenant,
    get: (appId, linkId, options = {}) =>
      app!.inject({
        method: 'GET',
        url: `/v1/share-pages/${encodeURIComponent(linkId)}`,
        headers: headersFor(appId, options.ua),
        remoteAddress: options.ip ?? '198.51.100.1',
      }),
    tpwd: (appId, linkId, ticket, options = {}) =>
      app!.inject({
        method: 'POST',
        url: `/v1/share-pages/${encodeURIComponent(linkId)}/tpwd`,
        headers: { ...headersFor(appId, options.ua), 'content-type': 'application/json' },
        payload: JSON.stringify({ ticket }),
        remoteAddress: options.ip ?? '198.51.100.2',
      }),
    convertCalls: () => convertCalls(),
    clearConvert: () => clearConvert(),
  };
}

let schemas: Promise<Record<string, JsonSchema>> | undefined;
export async function validate(
  value: unknown,
  name: 'SharePageResponse' | 'ShareTpwdResponse' | 'ErrorEnvelope',
): Promise<void> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)))
    .then((contract) => contract.components.schemas);
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(value)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

/** BR-ATTR-10 细则「缓存」: every response of both operations is Cache-Control: no-store. */
export function expectNoStore(response: InjectResponse): void {
  expect(response.headers['cache-control']).toBe('no-store');
}

/** The token is nowhere in the raw body nor in any header value. */
export function expectNoToken(response: InjectResponse, core: string): void {
  if (core === '') return;
  expect(response.payload).not.toContain(core);
  expect(JSON.stringify(response.headers)).not.toContain(core);
}

/** A 200 share page that passes the contract; its data. */
export async function pageData(response: InjectResponse): Promise<SharePageData> {
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({ code: 0, trace_id: TRACE });
  expectNoStore(response);
  await validate(body, 'SharePageResponse');
  return (body as SharePageResponse).data;
}

/** A 200 token exchange that passes the contract; the token. */
export async function tpwdOf(response: InjectResponse): Promise<string> {
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({ code: 0, trace_id: TRACE });
  expectNoStore(response);
  await validate(body, 'ShareTpwdResponse');
  return (body as ShareTpwdResponse).data.tpwd;
}

/** An error envelope of the given code and HTTP status that passes the contract. */
export async function expectRefused(
  response: InjectResponse,
  status: number,
  code: number,
): Promise<{ readonly code: number; readonly data?: Readonly<Record<string, unknown>> }> {
  const body = response.json();
  expect(body).toMatchObject({ code, trace_id: TRACE });
  expect(response.statusCode).toBe(status);
  expectNoStore(response);
  await validate(body, 'ErrorEnvelope');
  return body as { code: number; data?: Record<string, unknown> };
}

/** 20001 data.fields=[ticket], no token (BR-ATTR-10 细则「票据与限频」). */
export async function expectTicketRefused(
  response: InjectResponse,
  ...cores: readonly string[]
): Promise<void> {
  const body = await expectRefused(response, 400, 20001);
  expect(body).toMatchObject({ data: { fields: ['ticket'] } });
  expect(body).not.toHaveProperty('data.tpwd');
  for (const core of cores) expectNoToken(response, core);
}

/** 42901 with a Retry-After of whole seconds within the minute window, no token. */
export async function expectRateLimited(
  response: InjectResponse,
  ...cores: readonly string[]
): Promise<void> {
  await expectRefused(response, 429, 42901);
  const retryAfter = String(response.headers['retry-after']);
  expect(retryAfter).toMatch(/^[1-9][0-9]*$/);
  expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  for (const core of cores) expectNoToken(response, core);
}

/** A ticket as the contract bounds it (1..256 characters). */
export function ticketOf(data: SharePageData): string {
  expect(data.tpwd_ticket).toEqual(expect.any(String));
  const ticket = String(data.tpwd_ticket);
  expect(ticket.length).toBeGreaterThan(0);
  expect(ticket.length).toBeLessThanOrEqual(256);
  return ticket;
}

/** BR-ATTR-05 细则「App 内打开链接的入口」: https://<链接子域>/r/LinkLanding?link_id=…, only link_id. */
export function expectLandingDeepLink(value: string | null, linkId: string): void {
  expect(value).toEqual(expect.any(String));
  const url = new URL(String(value));
  expect(url.protocol).toBe('https:');
  expect(url.pathname).toBe('/r/LinkLanding');
  expect([...url.searchParams.keys()]).toEqual(['link_id']);
  expect(url.searchParams.get('link_id')).toBe(linkId);
}

/** The shared card subset: no rebate amount, no Agent or open-only field (BR-PRICE-06). */
export function expectSharedSubset(card: object): void {
  expect(Object.keys(card).filter((key) => key.startsWith('rebate_'))).toEqual([]);
  for (const key of [
    'est_net_price_fen',
    'no_rebate_cause',
    'cta',
    'card_id',
    'match_tag',
    'spec_text',
    'quoted_at',
    'identity_snapshot',
    'user_id',
    'pid',
    'jump',
    'tpwd',
  ]) {
    expect(card).not.toHaveProperty(key);
  }
}

/** Whole tables, row values included: catches updates as well as inserts and deletes. */
export async function persisted(db: Kysely<DB>) {
  return {
    links: await db.selectFrom('links').selectAll().orderBy('link_id').execute(),
    logs: await db.selectFrom('link_logs').selectAll().orderBy('id').execute(),
    attempts: await db.selectFrom('link_open_attempts').selectAll().orderBy('attempt_id').execute(),
    sessions: await db.selectFrom('union_auth_sessions').selectAll().orderBy('state').execute(),
    bindings: await db.selectFrom('union_bindings').selectAll().orderBy('id').execute(),
  };
}

/**
 * The same ticket with its first character changed: same length, not issued (the first character
 * of any encoding carries significant bits, unlike the padding bits of a base64 tail).
 */
export function tampered(ticket: string): string {
  const first = ticket.startsWith('A') ? 'B' : 'A';
  return `${first}${ticket.slice(1)}`;
}
