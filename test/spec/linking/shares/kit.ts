// B1-15w rule-test kit: POST /v1/shares (contract createShare, CT-15t) through the real api entry
// (createHttpApp + inject) over a throwaway PostgreSQL and Redis, an injected FixedClock and a local
// field keyring. Nothing in AppModule or LinkingModule is replaced: identity's caller and attr_code
// ports, the signature, token and phone-level checks, idempotency, link registration, the governed
// demo union adapters, the demo quoter and the share page are the entry's own. Requests are signed
// with the install secret of a device registered through POST /v1/devices and carry a session
// token of identity's own token service.
// Observed (called through and recorded, never answered by the test unless a case asks):
// - DemoUnionAdapter convert / getItem / queryPddAuthority. A case may make convert fail with a
//   union or governance error (failConvert) or the Pinduoduo filing query answer "not filed"
//   (refusePddFiling): union-module DTOs and errors, never a platform payload;
// - catalog's createDemoRebateQuoter: every call of the process quoter (item, viewer, context,
//   result), to find the buy_type=share quote of BR-PRICE-06.
// Every case seeds its own App (tenant): union accounts, active promotion slots of every scene,
// configuration and users, so caches, rate-limit buckets and links never cross cases.
// Only *.int.test.ts import @couli/db/testing and hand its factories in (depcruise rule
// testcontainers-only-in-int-tests, type-only imports included).
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import {
  FIELD_CRYPTO,
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbHandles,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';

/** Beijing 10:00 on 10-30: the Asia/Shanghai and UTC dates agree. */
export const NOW = '2026-10-30T02:00:00.000Z';
/** W_link of the share links seeded directly (share-page cases). */
const LINK_EXPIRES = '2026-11-29T02:00:00.000Z';
const QUOTED = '2026-10-30T01:58:30.000Z';
const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;
const SCENES = ['query', 'self_buy', 'share'] as const;
const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SHARES = '/v1/shares';

export type SharePlatform = (typeof PLATFORMS)[number];
export type BindingStatus = 'absent' | 'unbound' | 'pending_auth' | 'active' | 'invalid';
export type ShareMaterials = components['schemas']['ShareMaterials'];
export type ProductCard = components['schemas']['ProductCard'];
export type ShareBody = components['schemas']['CreateShareRequest'];
type SharePageData = components['schemas']['SharePageData'];
type ShareTpwdData = components['schemas']['ShareTpwdData'];

/** Real-world User-Agent samples: a system browser and the WeChat in-app browser. */
export const UA = {
  safari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  wechat:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003137) NetType/WIFI Language/zh_CN',
} as const;

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  readonly url: string;
  stop(): Promise<void>;
}
export interface Provisioning {
  createTestDatabase(): Promise<TestDatabase>;
  acquireTestRedis(): Promise<TestRedis>;
}

export interface InjectResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  readonly payload: string;
  json(): unknown;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string | undefined>;
    payload?: string;
    remoteAddress: string;
  }): Promise<InjectResponse>;
}

type Convert = DemoUnionAdapter['convert'];
/** One convert call of a demo adapter; result null when the case made it fail. */
export interface ConvertCall {
  readonly request: Parameters<Convert>[0];
  readonly identity: Parameters<Convert>[1];
  readonly result: Awaited<ReturnType<Convert>> | null;
}
export type UnionItemDetail = Awaited<ReturnType<DemoUnionAdapter['getItem']>>;
type Quote = catalog.CardRebateQuoter['quote'];
/** One quote of the process quoter (catalog's CardRebateQuoter port). */
export interface QuoteCall {
  readonly item: Parameters<Quote>[0];
  readonly viewer: Parameters<Quote>[1];
  readonly context: Parameters<Quote>[2];
  readonly result: catalog.RebateQuote;
}

export interface UserOptions {
  /** false: no bound phone (users.phone_hmac null). Default true. */
  readonly phone?: boolean;
  /** The Taobao binding; default active. */
  readonly taobao?: BindingStatus;
  /** The Pinduoduo filing (union_bindings platform pdd); default active. */
  readonly pdd?: BindingStatus;
  /** A verified real name with this birth date (YYYY-MM-DD); default none. */
  readonly birthDate?: string;
}

export interface ShareOptions {
  /** Idempotency-Key; default a fresh one. */
  readonly key?: string;
  /** The access token; null sends no Authorization. Default the user's session. */
  readonly token?: string | null;
}

/** A signed-in app user of one tenant: the sharer. */
export interface Sharer {
  readonly uid: string;
  readonly attrCode: string;
  /** One search page (q=演示商品, limit 10) as this user: cards with their registered links. */
  search(platform: SharePlatform): Promise<ProductCard[]>;
  share(body: object, options?: ShareOptions): Promise<InjectResponse>;
}

export interface SeedOptions {
  /** links.promo_url of the seeded share link; default none. */
  readonly promoUrl?: string | null;
  /** A share_materials row of the link; default none. */
  readonly material?: { readonly shareUrl: string; readonly tpwd: string | null };
}

export interface Tenant {
  readonly appId: string;
  /** The active promotion slot (pid) of the platform's union account for the scene. */
  pid(platform: SharePlatform, scene: (typeof SCENES)[number]): string;
  user(options?: UserOptions): Promise<Sharer>;
  /** A share link written directly (scene and pid_scene share), as B1-15u seeds it. */
  seedShareLink(sharerId: string, platform: SharePlatform, options?: SeedOptions): Promise<string>;
}

export interface SharesHarness {
  readonly clock: FixedClock;
  db(): Kysely<DB>;
  tenant(): Promise<Tenant>;
  /** links and share_materials of the App, whole rows: catches updates as well as inserts. */
  persisted(appId: string): Promise<{
    links: Awaited<ReturnType<typeof linksOf>>;
    materials: Awaited<ReturnType<typeof materialsOf>>;
  }>;
  converts(): readonly ConvertCall[];
  items(): readonly UnionItemDetail[];
  quotes(): readonly QuoteCall[];
  /** Forgets the recorded union calls and quotes. */
  clearObservations(): void;
  /** Every convert of the rest of the case rejects with this error. */
  failConvert(error: Error): void;
  /** Every Pinduoduo filing query of the rest of the case answers "not filed". */
  refusePddFiling(): void;
  /** GET /v1/share-pages/{link_id}, anonymous, as the page outside the app requests it. */
  page(appId: string, linkId: string, ua?: string): Promise<InjectResponse>;
  /** POST /v1/share-pages/{link_id}/tpwd, each exchange from its own address. */
  exchange(appId: string, linkId: string, ticket: string, ua?: string): Promise<InjectResponse>;
}

function hex(length: number): string {
  return randomUUID().replaceAll('-', '').slice(0, length);
}

function linksOf(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('links')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('link_id')
    .execute();
}

function materialsOf(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('share_materials')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('link_id')
    .execute();
}

let address = 0;
/** A fresh client address: per-IP limits of one user never meet another's. */
function nextAddress(): string {
  address++;
  return `10.15.${Math.floor(address / 250) % 250}.${(address % 250) + 1}`;
}

const originalConvert = DemoUnionAdapter.prototype.convert;
const originalGetItem = DemoUnionAdapter.prototype.getItem;
const originalAuthority = DemoUnionAdapter.prototype.queryPddAuthority;
const originalQuoter = catalog.createDemoRebateQuoter;

/** Registers the file's hooks: one api entry for the whole file. */
export function sharesHarness({
  createTestDatabase,
  acquireTestRedis,
}: Provisioning): SharesHarness {
  const clock = new FixedClock(NOW);
  const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
  const converts: ConvertCall[] = [];
  const items: UnionItemDetail[] = [];
  const quotes: QuoteCall[] = [];
  let convertFailure: Error | null = null;
  let filingRefused = false;
  let ruleKey: string | undefined;
  let database: TestDatabase | undefined;
  let redis: TestRedis | undefined;
  let db: Kysely<DB> | undefined;
  let app: HttpApp | undefined;
  let directory: string | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
    redis = await acquireTestRedis();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
    await db
      .updateTable('platforms')
      .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: clock.now() })
      .where('code', 'in', [...PLATFORMS])
      .execute();

    vi.spyOn(DemoUnionAdapter.prototype, 'convert').mockImplementation(async function (
      this: DemoUnionAdapter,
      request,
      identity,
      context,
    ) {
      if (convertFailure !== null) {
        converts.push({ request, identity, result: null });
        throw convertFailure;
      }
      const result = await originalConvert.call(this, request, identity, context);
      converts.push({ request, identity, result });
      return result;
    });
    vi.spyOn(DemoUnionAdapter.prototype, 'getItem').mockImplementation(async function (
      this: DemoUnionAdapter,
      ref,
      context,
    ) {
      const item = await originalGetItem.call(this, ref, context);
      items.push(item);
      return item;
    });
    vi.spyOn(DemoUnionAdapter.prototype, 'queryPddAuthority').mockImplementation(async function (
      this: DemoUnionAdapter,
      identity,
      context,
    ) {
      if (filingRefused) return { authorized: false };
      return originalAuthority.call(this, identity, context);
    });
    vi.spyOn(catalog, 'createDemoRebateQuoter').mockImplementation((options) => {
      ruleKey = options.ruleConfigKey;
      const quoter = originalQuoter(options);
      return {
        async quote(item, viewer, context) {
          const result = await quoter.quote(item, viewer, context);
          quotes.push({ item, viewer, context, result });
          return result;
        },
      };
    });

    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    directory = mkdtempSync(join(base, 'b1-15w-'));
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(directory, 'master.hex');
    const keyringFile = join(directory, 'keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
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
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: masterFile,
        FIELD_KEYRING_FILE: keyringFile,
      }),
      clock,
      logger,
      dbHandles: { db, dbRead: null, close: async () => undefined },
      redisUrl: connection.redisUrl,
    });
    await app.init();
    // The entry's own quoter reads its synthetic rule from this key; every tenant seeds it.
    expect(ruleKey).toEqual(expect.any(String));
  }, 180_000);

  beforeEach(() => {
    clock.set(NOW);
  });

  afterEach(() => {
    convertFailure = null;
    filingRefused = false;
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
          try {
            await redis?.stop();
          } finally {
            if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
          }
        }
      }
    }
  }, 60_000);

  const handle = (): Kysely<DB> => db!;
  const server = (): HttpApp => app!;

  async function setConfig(appId: string, key: string, value: unknown): Promise<void> {
    await handle()
      .insertInto('config_items')
      .values({ app_id: appId, key, value: JSON.stringify(value), updated_by: 'synthetic-b1-15w' })
      .execute();
  }

  async function tenant(): Promise<Tenant> {
    const appId = `shares_${hex(20)}`;
    const accounts: Record<SharePlatform, string> = {
      taobao: randomUUID(),
      jd: randomUUID(),
      pdd: randomUUID(),
    };
    const pids = new Map<string, string>();
    for (const platform of PLATFORMS) {
      await handle()
        .insertInto('union_accounts')
        .values({
          id: accounts[platform],
          app_id: appId,
          platform,
          account_name: `synthetic-shares-${platform}`,
          status: 'active',
          auth_status: 'active',
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      for (const scene of SCENES) {
        const pid = `synthetic-${platform}-${scene}-${hex(10)}`;
        pids.set(`${platform}:${scene}`, pid);
        await handle()
          .insertInto('union_pids')
          .values({
            id: randomUUID(),
            app_id: appId,
            platform,
            union_account_id: accounts[platform],
            site_id: platform === 'taobao' ? `synthetic-${scene}-site` : null,
            pid,
            pid_scene: scene,
            status: 'active',
            hjy_ignore_confirmed_at: clock.now(),
            hjy_ignore_evidence_path: 'https://example.test/synthetic-evidence',
            created_at: clock.now(),
            updated_at: clock.now(),
          })
          .execute();
      }
    }
    const settings: [string, unknown][] = [
      ['tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 }],
      ['link.open.requote_after_sec', 0],
      ['attr.click_code.jd', false],
      ['attr.click_code.pdd', false],
      [String(ruleKey), { reserve_bp: 0, self_share_bp: 10000 }],
    ];
    for (const platform of PLATFORMS) {
      settings.push(
        [`search.enabled.${platform}`, true],
        [`convert.enabled.${platform}`, true],
        [`rebate.${platform}.compare_rate_ratio_bp`, 5000],
      );
    }
    for (const [key, value] of settings) await setConfig(appId, key, value);

    function pid(platform: SharePlatform, scene: (typeof SCENES)[number]): string {
      return String(pids.get(`${platform}:${scene}`));
    }

    async function user(options: UserOptions = {}): Promise<Sharer> {
      const ip = nextAddress();
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-app-id': appId,
        'x-platform': 'ios',
        'x-app-version': '2.0.0',
        'x-channel': 'official',
      };
      const registered = await server().inject({
        method: 'POST',
        url: '/v1/devices',
        headers: { ...headers, 'x-trace-id': randomUUID() },
        payload: JSON.stringify({
          device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
          id_source: 'idfv',
        }),
        remoteAddress: ip,
      });
      expect(registered.statusCode, registered.payload).toBe(200);
      const device = (registered.json() as { data: { device_id: string; install_secret: string } })
        .data;

      const uid = randomUUID();
      const attrCode = hex(8);
      await handle()
        .insertInto('users')
        .values({
          id: uid,
          app_id: appId,
          nickname: '合成分享者',
          avatar: 'https://example.test/avatar',
          invite_code: Array.from(
            randomBytes(6),
            (n) => INVITE_ALPHABET[n % INVITE_ALPHABET.length],
          ).join(''),
          attr_code: attrCode,
          level: 'L1',
          register_method: 'sms',
          status: 'normal',
          phone_hmac: options.phone === false ? null : randomBytes(32).toString('hex'),
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      await handle()
        .insertInto('user_risk_state')
        .values({
          app_id: appId,
          user_id: uid,
          state: 'normal',
          changed_by: 'synthetic',
          changed_at: clock.now(),
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      for (const platform of ['taobao', 'pdd'] as const) {
        const status = options[platform] ?? 'active';
        if (status === 'absent') continue;
        await handle()
          .insertInto('union_bindings')
          .values({
            id: randomUUID(),
            app_id: appId,
            user_id: uid,
            platform,
            union_account_id: accounts[platform],
            relation_id: platform === 'taobao' ? `9${hex(8).replace(/[a-f]/g, '7')}` : null,
            pdd_custom: platform === 'pdd' ? JSON.stringify({ synthetic: uid }) : null,
            status,
            bound_at: status === 'active' ? clock.now() : null,
            blocked_reason: null,
            released_at: null,
            cooldown_until: null,
            created_at: clock.now(),
            updated_at: clock.now(),
          })
          .execute();
      }
      if (options.birthDate !== undefined) {
        const crypto = server().get<FieldCrypto>(FIELD_CRYPTO);
        const idNo = `fixture-${uid}`;
        const sealed = (value: string, context: string) =>
          Buffer.from(crypto.encrypt(value, context));
        await sql`INSERT INTO app.realname
          (id, app_id, user_id, status, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, provider, verified_at)
          VALUES (${randomUUID()}, ${appId}, ${uid}, 'verified',
            ${sealed('分享实名测试姓名', 'realname.name')}, ${sealed(idNo, 'realname.id_no')},
            ${crypto.blindIndex(idNo, 'realname.id_no')},
            ${sealed(options.birthDate, 'realname.birth_date')},
            'test-two-elements', ${clock.now()})`.execute(handle());
      }
      const session = await handle()
        .transaction()
        .execute((trx) =>
          createSession(
            trx,
            { uid, app_id: appId, device_id: device.device_id, scp: 'full' },
            { clock, tokens: server().get<TokenService>(TOKEN_SERVICE) },
          ),
        );
      const signedIn = { ...headers, 'x-device-id': device.device_id };

      async function search(platform: SharePlatform): Promise<ProductCard[]> {
        const query = new URLSearchParams({ platform, q: '演示商品', limit: '10' });
        const response = await server().inject({
          method: 'GET',
          url: `/v1/products/search?${query}`,
          headers: {
            ...signedIn,
            'x-trace-id': randomUUID(),
            authorization: `Bearer ${session.access_token}`,
          },
          remoteAddress: ip,
        });
        expect(response.statusCode, response.payload).toBe(200);
        const body = response.json() as { code: number; data: { items: ProductCard[] } };
        expect(body.code).toBe(0);
        expect(body.data.items.length).toBeGreaterThan(0);
        return body.data.items;
      }

      function share(body: object, shareOptions: ShareOptions = {}): Promise<InjectResponse> {
        const payload = JSON.stringify(body);
        const timestamp = String(Math.floor(clock.now().getTime() / 1000));
        const nonce = randomBytes(16).toString('hex');
        const digest = createHash('sha256').update(payload).digest('hex');
        const sign = createHmac('sha256', device.install_secret)
          .update(['POST', SHARES, timestamp, nonce, digest].join('\n'))
          .digest('hex');
        const token = shareOptions.token === undefined ? session.access_token : shareOptions.token;
        return server().inject({
          method: 'POST',
          url: SHARES,
          payload,
          headers: {
            ...signedIn,
            'x-timestamp': timestamp,
            'x-nonce': nonce,
            'x-sign': sign,
            'x-trace-id': randomUUID(),
            'idempotency-key': shareOptions.key ?? randomUUID(),
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
          remoteAddress: ip,
        });
      }

      return { uid, attrCode, search, share };
    }

    async function seedShareLink(
      sharerId: string,
      platform: SharePlatform,
      options: SeedOptions = {},
    ): Promise<string> {
      const linkId = randomUUID();
      const promoUrl = options.promoUrl ?? null;
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
          pid: pid(platform, 'share'),
          entry_source: 'search',
          identity_snapshot: {
            user_id: sharerId,
            platform,
            pid: pid(platform, 'share'),
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
      if (options.material !== undefined) {
        await handle()
          .insertInto('share_materials')
          .values({
            app_id: appId,
            link_id: linkId,
            share_url: options.material.shareUrl,
            tpwd: options.material.tpwd,
          })
          .execute();
      }
      return linkId;
    }

    return { appId, pid, user, seedShareLink };
  }

  function pageHeaders(appId: string, ua: string): Record<string, string> {
    return {
      'x-app-id': appId,
      'x-platform': 'h5',
      'x-app-version': '1.0.0',
      'x-trace-id': randomUUID(),
      'user-agent': ua,
    };
  }

  return {
    clock,
    db: handle,
    tenant,
    persisted: async (appId) => ({
      links: await linksOf(handle(), appId),
      materials: await materialsOf(handle(), appId),
    }),
    converts: () => [...converts],
    items: () => [...items],
    quotes: () => [...quotes],
    clearObservations: () => {
      converts.length = 0;
      items.length = 0;
      quotes.length = 0;
    },
    failConvert: (error) => {
      convertFailure = error;
    },
    refusePddFiling: () => {
      filingRefused = true;
    },
    page: (appId, linkId, ua = UA.safari) =>
      server().inject({
        method: 'GET',
        url: `/v1/share-pages/${encodeURIComponent(linkId)}`,
        headers: pageHeaders(appId, ua),
        remoteAddress: nextAddress(),
      }),
    exchange: (appId, linkId, ticket, ua = UA.safari) =>
      server().inject({
        method: 'POST',
        url: `/v1/share-pages/${encodeURIComponent(linkId)}/tpwd`,
        headers: { ...pageHeaders(appId, ua), 'content-type': 'application/json' },
        payload: JSON.stringify({ ticket }),
        remoteAddress: nextAddress(),
      }),
  };
}

let schemas: Promise<Record<string, JsonSchema>> | undefined;
export async function validate(
  value: unknown,
  name: 'CreateShareResponse' | 'ErrorEnvelope' | 'SharePageResponse' | 'ShareTpwdResponse',
): Promise<void> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)))
    .then((contract) => contract.components.schemas);
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}

/** A 200 createShare that passes the contract; its data. */
export async function expectShared(response: InjectResponse): Promise<ShareMaterials> {
  expect(response.statusCode, response.payload).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({ code: 0 });
  await validate(body, 'CreateShareResponse');
  return (body as { data: ShareMaterials }).data;
}

/** An error envelope of the given HTTP status and code that passes the contract. */
export async function expectRefused(
  response: InjectResponse,
  status: number,
  code: number,
): Promise<{ readonly code: number; readonly data?: Readonly<Record<string, unknown>> }> {
  expect(response.statusCode, response.payload).toBe(status);
  const body = response.json();
  expect(body).toMatchObject({ code });
  await validate(body, 'ErrorEnvelope');
  return body as { code: number; data?: Record<string, unknown> };
}

/** A 200 share page that passes the contract; its data. */
export async function pageData(response: InjectResponse): Promise<SharePageData> {
  expect(response.statusCode, response.payload).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({ code: 0 });
  await validate(body, 'SharePageResponse');
  return (body as { data: SharePageData }).data;
}

/** A 200 token exchange that passes the contract; the token. */
export async function tpwdOf(response: InjectResponse): Promise<string> {
  expect(response.statusCode, response.payload).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({ code: 0 });
  await validate(body, 'ShareTpwdResponse');
  return (body as { data: ShareTpwdData }).data.tpwd;
}

/** The request body the share page sends for a card (platform, product_key, item_ref, source). */
export function bodyOf(card: ProductCard, withSource = true): ShareBody {
  expect(card.product_key).toEqual(expect.any(String));
  return {
    platform: card.platform,
    product_key: String(card.product_key),
    ...(card.item_ref === null ? {} : { item_ref: card.item_ref }),
    ...(withSource ? { source_link_id: card.link_id } : {}),
  };
}

/** A card of the page with (coupon_fen > 0) or without (coupon_fen = 0) a coupon. */
export function cardWith(cards: readonly ProductCard[], coupon: boolean): ProductCard {
  const found = cards.find(
    (card) =>
      card.product_key !== null && (coupon ? (card.coupon_fen ?? 0) > 0 : card.coupon_fen === 0),
  );
  expect(found, coupon ? 'a card with a coupon' : 'a card without a coupon').toBeDefined();
  return found!;
}

/** Rows of `after` whose link_id is not in `before`. */
export function added<T extends { readonly link_id: string }>(
  before: readonly T[],
  after: readonly T[],
): T[] {
  const known = new Set(before.map((row) => row.link_id));
  return after.filter((row) => !known.has(row.link_id));
}

/** The web addresses a convert result carries (the converted link and any short forms of it). */
export function webUrlsOf(result: unknown): string[] {
  if (result === null || typeof result !== 'object') return [];
  return Object.values(result).filter(
    (value): value is string => typeof value === 'string' && /^https?:\/\//.test(value),
  );
}

/** NullableFen → bigint | null. */
export function fen(value: number | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

/** JSON of any value, bigint as text: for searching addresses in rows and DTOs. */
export function textOf(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'bigint' ? inner.toString() : inner,
  );
}

export { hex };
