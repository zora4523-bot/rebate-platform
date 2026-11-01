// B1-06zd rule-test kit: the Taobao promotion link through the real api entry (createHttpApp +
// inject) over a throwaway PostgreSQL and Redis, an injected FixedClock and a local field keyring.
// Nothing in AppModule or LinkingModule is replaced and the entry's JOB_QUEUE really runs, so a
// prefetch job is a row of pgboss.job. The Taobao union is a stub (no recorded platform payload
// exists): only DemoUnionAdapter.prototype.convert of the taobao adapter answers a ConvertResult the
// case chose; the request and the identity first go through privilegeLinkParameters, the real
// adapter's parameter check, so a request the real conversion would refuse is refused here too.
// jd / pdd and every other adapter method are the entry's own.
// Every case seeds its own App, so caches, rate-limit buckets and jobs never cross cases.
// Only *.int.test.ts import @couli/db/testing and hand its factories in.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi, type MockInstance } from 'vitest';
import type {
  PromoPrefetchJobName,
  PromoPrefetchQueueName,
} from '../../../../apps/api/src/modules/linking/application/promo-prefetch.ts';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import {
  FixedClock,
  JOB_QUEUE,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbHandles,
  type QueueRuntime,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  DemoUnionAdapter,
  type ConvertResult,
} from '../../../../apps/api/src/modules/union/index.ts';
import { privilegeLinkParameters } from '../../../../apps/api/src/modules/union/infra/taobao/privilege-link.ts';
import {
  UA,
  hex,
  type BindingStatus,
  type InjectResponse,
  type ProductCard,
  type Provisioning,
  type ShareOptions,
  type SharePlatform,
} from '../shares/kit.ts';

/** Beijing 10:00 on 10-30: a whole minute, so a one-minute window starts here. */
export const NOW = '2026-10-30T02:00:00.000Z';
const ROOT = new URL('../../../../', import.meta.url);
const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;
const SCENES = ['query', 'self_buy', 'share', 'agent'] as const;
const SHARES = '/v1/shares';

export const SHARE_SWITCH = 'share.taobao_enabled';
export const PREFETCH_SWITCH = 'convert.taobao_prefetch.enabled';
export const PREFETCH_RATE = 'convert.taobao_prefetch.rate_per_min';
export const JOB_NAME: PromoPrefetchJobName = 'linking.promo_prefetch';
export const QUEUE_NAME: PromoPrefetchQueueName = 'pool-refresh';
/** A demo rule that leaves the rebate at 0: every card of the App is no_rebate (BR-PRICE-08). */
export const NO_REBATE_RULE = { reserve_bp: 0, self_share_bp: 0 };

const REBATE_RULE = { reserve_bp: 0, self_share_bp: 10000 };

export const SHORT_URL = 'https://s.click.example.test/t?e=short';
export const COUPON_CLICK_URL = 'https://uland.example.test/coupon/edetail?e=coupon';
export const TPWD = '￥SynthPromo01￥';

type UrlResult = Extract<ConvertResult, { kind: 'url' }>;

/** A 大淘客 price the conversion answers with: never written to a links snapshot. */
export function otherPrice(): NonNullable<UrlResult['requote']> {
  return { price_fen: 1n, final_price_fen: 1n, quoted_at: '2026-10-29T00:00:00.000Z' };
}

/**
 * A conversion's result as the adapter maps it: url = short_url, else coupon_click_url. null
 * leaves a field out. Defaults: all three present, plus a requote of another price.
 */
export function promotion(
  parts: {
    readonly short?: string | null;
    readonly coupon?: string | null;
    readonly tpwd?: string | null;
  } = {},
): ConvertResult {
  const short = parts.short === undefined ? SHORT_URL : parts.short;
  const coupon = parts.coupon === undefined ? COUPON_CLICK_URL : parts.coupon;
  const tpwd = parts.tpwd === undefined ? TPWD : parts.tpwd;
  return {
    kind: 'url',
    url: short ?? coupon ?? '',
    ...(short === null ? {} : { short_url: short }),
    ...(coupon === null ? {} : { coupon_click_url: coupon }),
    ...(tpwd === null ? {} : { tpwd }),
    requote: otherPrice(),
  };
}

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  readonly url: string;
  stop(): Promise<void>;
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

/** The parameters the real adapter would send, from the request and identity it was given. */
export type ConversionParameters = ReturnType<typeof privilegeLinkParameters>;

/** One conversion of the taobao adapter. */
export interface ConversionCall {
  readonly parameters: ConversionParameters;
  readonly appId: string;
  readonly purpose: string;
}

/** One row of pgboss.job with this kit's job name. */
export interface PrefetchJob {
  readonly queue: string;
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface JobRow {
  readonly queue: string;
  readonly id: string;
  readonly data: { readonly payload: Readonly<Record<string, unknown>> };
}

/** One item of GET /v1/me/favorites. */
export interface FavoriteItem {
  readonly product_key: string;
  readonly invalid: boolean;
  readonly product_card: ProductCard;
}

export interface UserOptions {
  /** The Taobao binding; default active. */
  readonly taobao?: BindingStatus;
  /** relation_id of the binding; default a fresh one, null for an active binding without one. */
  readonly relationId?: string | null;
}

/** An app client: a signed-in user, or a guest device (token null). */
export interface Client {
  /** One search page (q=演示商品, limit 10) of cards with their registered links. */
  search(platform: SharePlatform): Promise<ProductCard[]>;
  /** GET /v1/products/{product_key} of a card, with the card's item_ref. */
  detail(card: ProductCard): Promise<InjectResponse>;
  /** POST /v1/links/{link_id}/open, signed. */
  open(linkId: string): Promise<InjectResponse>;
  /** GET /v1/me/favorites: the items of the first page. */
  favorites(): Promise<FavoriteItem[]>;
}

export interface Member extends Client {
  readonly uid: string;
  /** The binding's relation_id; null without one. */
  readonly relationId: string | null;
  share(body: object, options?: ShareOptions): Promise<InjectResponse>;
}

export interface PromoTenant {
  readonly appId: string;
  /** The active promotion slot of the platform's union account for the scene. */
  pid(platform: SharePlatform, scene: (typeof SCENES)[number]): string;
  user(options?: UserOptions): Promise<Member>;
  guest(): Promise<Client>;
  /** Replaces the demo rule; the entry reads it once its 60-second cache has passed. */
  setRule(rule: object): Promise<void>;
}

export interface PromoHarness {
  readonly clock: FixedClock;
  db(): Kysely<DB>;
  tenant(
    settings?: Readonly<Record<string, unknown>>,
    rule?: Readonly<Record<string, number>>,
  ): Promise<PromoTenant>;
  /** links and share_materials of the App, whole rows: catches updates as well as inserts. */
  persisted(appId: string): Promise<{
    links: Awaited<ReturnType<typeof linksOf>>;
    materials: Awaited<ReturnType<typeof materialsOf>>;
  }>;
  /** The link's row as it stands. */
  link(linkId: string): Promise<Awaited<ReturnType<typeof linksOf>>[number]>;
  conversions(): readonly ConversionCall[];
  clearConversions(): void;
  /** What the taobao conversion answers for the rest of the case. */
  answer(result: (parameters: ConversionParameters) => ConvertResult): void;
  /** Every taobao conversion of the rest of the case rejects with this error. */
  failConversion(error: Error): void;
  /** The prefetch jobs of the App. */
  jobs(appId: string): Promise<PrefetchJob[]>;
  /** Spies on JOB_QUEUE send, answering what `run` answers, until the case ends. */
  interceptSend(run: QueueRuntime['send']): MockInstance<QueueRuntime['send']>;
  /** The log lines of the entry at warning level or above since the case began. */
  warnings(): readonly Record<string, unknown>[];
  /** GET /v1/share-pages/{link_id}, anonymous, as the page outside the app requests it. */
  page(appId: string, linkId: string): Promise<InjectResponse>;
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

/** The App's prefetch jobs: rows of pgboss.job with this kit's job name. */
export async function jobsOf(db: Kysely<DB>, appId: string): Promise<PrefetchJob[]> {
  const query = sql<JobRow>`SELECT name AS queue, id::text AS id, data FROM pgboss.job
    WHERE data->>'name' = ${JOB_NAME} AND data->'payload'->>'app_id' = ${appId}`;
  const { rows } = await query.execute(db);
  return rows.map(({ queue, id, data }) => ({ queue, id, payload: data.payload }));
}

let address = 0;
/** A fresh client address: per-IP limits of one user never meet another's. */
function nextAddress(): string {
  address++;
  return `10.16.${Math.floor(address / 250) % 250}.${(address % 250) + 1}`;
}

/** A promotion slot of the shape the Taobao open and contract accept. */
export function slot(): string {
  const digits = (): string => String(randomBytes(4).readUInt32BE(0));
  return `mm_${digits()}_${digits()}_${digits()}`;
}

/** A relation_id of the shape the bindings hold. */
export function relationId(): string {
  return `9${hex(8).replace(/[a-f]/g, '7')}`;
}

const originalConvert = DemoUnionAdapter.prototype.convert;
const originalQuoter = catalog.createDemoRebateQuoter;

/** Registers the file's hooks: one api entry for the whole file. */
export function promoHarness({ createTestDatabase, acquireTestRedis }: Provisioning): PromoHarness {
  const clock = new FixedClock(NOW);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const defaultAnswer = (): ConvertResult => promotion();
  const conversions: ConversionCall[] = [];
  let answer: (parameters: ConversionParameters) => ConvertResult = defaultAnswer;
  let failure: Error | null = null;
  let sendSpy: MockInstance<QueueRuntime['send']> | undefined;
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
      if (this.platform !== 'taobao') {
        return originalConvert.call(this, request, identity, context);
      }
      const parameters = privilegeLinkParameters(request, identity);
      conversions.push({ parameters, appId: context.appId, purpose: context.purpose });
      if (failure !== null) throw failure;
      return answer(parameters);
    });
    vi.spyOn(catalog, 'createDemoRebateQuoter').mockImplementation((options) => {
      ruleKey = options.ruleConfigKey;
      return originalQuoter(options);
    });

    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    directory = mkdtempSync(join(base, 'b1-06zd-'));
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
          startQueue: boolean;
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
      startQueue: true,
    });
    await app.init();
    expect(ruleKey).toEqual(expect.any(String));
  }, 180_000);

  beforeEach(() => {
    clock.set(NOW);
    lines.length = 0;
  });

  afterEach(() => {
    answer = defaultAnswer;
    failure = null;
    conversions.length = 0;
    sendSpy?.mockRestore();
    sendSpy = undefined;
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
      .values({ app_id: appId, key, value: JSON.stringify(value), updated_by: 'synthetic-b1-06zd' })
      .execute();
  }

  async function tenant(
    configured: Readonly<Record<string, unknown>> = {},
    rule: Readonly<Record<string, number>> = REBATE_RULE,
  ): Promise<PromoTenant> {
    const appId = `promo_${hex(20)}`;
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
          account_name: `synthetic-promo-${platform}`,
          status: 'active',
          auth_status: 'active',
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      for (const scene of SCENES) {
        const pid = platform === 'taobao' ? slot() : `synthetic-${platform}-${scene}-${hex(10)}`;
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
      [String(ruleKey), rule],
      ...Object.entries(configured),
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

    async function device(ip: string) {
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
      const { device_id: deviceId, install_secret: secret } = (
        registered.json() as { data: { device_id: string; install_secret: string } }
      ).data;
      return { deviceId, secret, headers: { ...headers, 'x-device-id': deviceId } };
    }

    /** One client of one device; `token` null is a guest. */
    function client(
      ip: string,
      dev: Awaited<ReturnType<typeof device>>,
      token: string | null,
    ): Client & { signed(path: string, payload: string, key: string): Promise<InjectResponse> } {
      const auth = token === null ? {} : { authorization: `Bearer ${token}` };

      async function search(platform: SharePlatform): Promise<ProductCard[]> {
        const query = new URLSearchParams({ platform, q: '演示商品', limit: '10' });
        const response = await server().inject({
          method: 'GET',
          url: `/v1/products/search?${query}`,
          headers: { ...dev.headers, ...auth, 'x-trace-id': randomUUID() },
          remoteAddress: ip,
        });
        expect(response.statusCode, response.payload).toBe(200);
        const body = response.json() as { data: { items: ProductCard[] } };
        expect(body.data.items.length).toBeGreaterThan(0);
        return body.data.items;
      }

      function detail(card: ProductCard): Promise<InjectResponse> {
        const query = new URLSearchParams();
        if (card.item_ref !== null) query.set('item_ref', card.item_ref);
        return server().inject({
          method: 'GET',
          url: `/v1/products/${encodeURIComponent(String(card.product_key))}?${query}`,
          headers: { ...dev.headers, ...auth, 'x-trace-id': randomUUID() },
          remoteAddress: ip,
        });
      }

      function signed(path: string, payload: string, key: string): Promise<InjectResponse> {
        const timestamp = String(Math.floor(clock.now().getTime() / 1000));
        const nonce = randomBytes(16).toString('hex');
        const digest = createHash('sha256').update(payload).digest('hex');
        const sign = createHmac('sha256', dev.secret)
          .update(['POST', path, timestamp, nonce, digest].join('\n'))
          .digest('hex');
        return server().inject({
          method: 'POST',
          url: path,
          payload,
          headers: {
            ...dev.headers,
            ...auth,
            'x-timestamp': timestamp,
            'x-nonce': nonce,
            'x-sign': sign,
            'x-trace-id': randomUUID(),
            'idempotency-key': key,
          },
          remoteAddress: ip,
        });
      }

      function open(linkId: string): Promise<InjectResponse> {
        const payload = JSON.stringify({ installed: 'true', no_rebate: false });
        return signed(`/v1/links/${linkId}/open`, payload, randomUUID());
      }

      async function favorites(): Promise<FavoriteItem[]> {
        const response = await server().inject({
          method: 'GET',
          url: '/v1/me/favorites',
          headers: { ...dev.headers, ...auth, 'x-trace-id': randomUUID() },
          remoteAddress: ip,
        });
        expect(response.statusCode, response.payload).toBe(200);
        return (response.json() as { data: { items: FavoriteItem[] } }).data.items;
      }

      return { search, detail, open, favorites, signed };
    }

    async function user(options: UserOptions = {}): Promise<Member> {
      const ip = nextAddress();
      const dev = await device(ip);
      const uid = randomUUID();
      await handle()
        .insertInto('users')
        .values({
          id: uid,
          app_id: appId,
          nickname: '合成用户',
          avatar: 'https://example.test/avatar',
          invite_code: `P${hex(5).toUpperCase()}`,
          attr_code: hex(8),
          level: 'L1',
          register_method: 'sms',
          status: 'normal',
          phone_hmac: randomBytes(32).toString('hex'),
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
      const status = options.taobao ?? 'active';
      const relation = options.relationId === undefined ? relationId() : options.relationId;
      if (status !== 'absent') {
        await handle()
          .insertInto('union_bindings')
          .values({
            id: randomUUID(),
            app_id: appId,
            user_id: uid,
            platform: 'taobao',
            union_account_id: accounts.taobao,
            relation_id: relation,
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
      const session = await handle()
        .transaction()
        .execute((trx) =>
          createSession(
            trx,
            { uid, app_id: appId, device_id: dev.deviceId, scp: 'full' },
            { clock, tokens: server().get<TokenService>(TOKEN_SERVICE) },
          ),
        );
      const { signed, ...reads } = client(ip, dev, session.access_token);
      return {
        ...reads,
        uid,
        relationId: status === 'absent' ? null : relation,
        share: (body, shareOptions = {}) =>
          signed(SHARES, JSON.stringify(body), shareOptions.key ?? randomUUID()),
      };
    }

    async function guest(): Promise<Client> {
      const ip = nextAddress();
      return client(ip, await device(ip), null);
    }

    async function setRule(replacement: object): Promise<void> {
      await handle()
        .updateTable('config_items')
        .set({ value: JSON.stringify(replacement) })
        .where('app_id', '=', appId)
        .where('key', '=', String(ruleKey))
        .execute();
    }

    return { appId, pid, user, guest, setRule };
  }

  return {
    clock,
    db: handle,
    tenant,
    persisted: async (appId) => ({
      links: await linksOf(handle(), appId),
      materials: await materialsOf(handle(), appId),
    }),
    link: (linkId) =>
      handle()
        .selectFrom('links')
        .selectAll()
        .where('link_id', '=', linkId)
        .executeTakeFirstOrThrow(),
    conversions: () => [...conversions],
    clearConversions: () => {
      conversions.length = 0;
    },
    answer: (result) => {
      answer = result;
    },
    failConversion: (error) => {
      failure = error;
    },
    jobs: (appId) => jobsOf(handle(), appId),
    interceptSend: (run) => {
      sendSpy = vi.spyOn(server().get<QueueRuntime>(JOB_QUEUE), 'send').mockImplementation(run);
      return sendSpy;
    },
    warnings: () =>
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => Number(line['level']) >= 40),
    page: (appId, linkId) =>
      server().inject({
        method: 'GET',
        url: `/v1/share-pages/${encodeURIComponent(linkId)}`,
        headers: {
          'x-app-id': appId,
          'x-platform': 'h5',
          'x-app-version': '1.0.0',
          'x-trace-id': randomUUID(),
          'user-agent': UA.safari,
        },
        remoteAddress: nextAddress(),
      }),
  };
}

/** The first card of a page that has a product key. */
export function cardOf(cards: readonly ProductCard[]): ProductCard {
  const card = cards.find((entry) => entry.product_key !== null);
  expect(card, 'a card with a product key').toBeDefined();
  return card!;
}

/** A 200 product detail; its card. */
export function detailCard(response: InjectResponse): ProductCard {
  expect(response.statusCode, response.payload).toBe(200);
  return (response.json() as { data: ProductCard }).data;
}

/** The App's prefetch jobs turn out to be exactly these links. */
export async function expectJobsFor(
  h: Pick<PromoHarness, 'jobs'>,
  appId: string,
  linkIds: readonly string[],
): Promise<PrefetchJob[]> {
  const expected = [...linkIds].sort();
  let jobs: PrefetchJob[] = [];
  await vi.waitFor(
    async () => {
      jobs = await h.jobs(appId);
      expect(jobs.map((job) => job.payload['link_id']).sort()).toEqual(expected);
    },
    { timeout: 5_000, interval: 50 },
  );
  return jobs;
}
