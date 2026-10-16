// F1-02f rule-test kit: GET /v1/articles and GET /v1/articles/{article_id}, observed only through
// HTTP (Fastify inject on the real api entry), contract validation and direct writes to articles.
// Fixture writes use couli_app (SELECT/INSERT/UPDATE on articles, no DELETE): every test seeds
// under its own app_id instead of cleaning up. Requests are anonymous: only X-App-Id, X-Platform
// and X-App-Version, no Authorization, X-Device-Id or signature headers (BR-ID-11).
//
// Rulings followed (couli-runs/F1-02f/decision-orchestrator.md): published = status 'published'
// exactly, published_at not null and <= injected now; current version = highest published version
// per (app_id, id); keyset (published_at DESC, id DESC) with a category-bound cursor; NoticeItem
// fields from the row (content_version = notice_content_version, text = title, target Help);
// notice window [published_at, notice_end_at); malformed article ids → 30701; no caching.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';

const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

export const NOW = '2031-03-04T05:06:07.000Z';
export const LIST = '/v1/articles';
export const DETAIL = '/v1/articles/{article_id}';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Category = 'help' | 'rule' | 'notice' | 'agreement';

export interface Response {
  statusCode: number;
  json<T = { code: number; msg: string; data?: unknown; trace_id: string }>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

export interface NoticeItem {
  item_id: string;
  content_version: number;
  text: string;
  target: { route: string; params?: Record<string, unknown> } | null;
  closable: boolean;
  start_at: string;
  end_at: string | null;
}
export interface Summary {
  article_id: string;
  category: Category;
  title: string;
  version: number;
  published_at: string;
  notice?: NoticeItem;
}
export interface Page {
  items: Summary[];
  next_cursor: string | null;
}
export interface Article {
  article_id: string;
  category: Category;
  title: string;
  version: number;
  published_at: string;
  body: string;
}

export interface Harness {
  readonly db: Kysely<DB>;
  readonly clock: FixedClock;
  get(appId: string, url: string): Promise<Response>;
}

// The kit never imports the testcontainers entry (depcruise testcontainers-only-in-int-tests):
// each *.int.test.ts passes `() => import(<db testing entry>)`, seen here only structurally.
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<unknown>;
}
interface TestRedis {
  readonly url: string;
  stop(): Promise<unknown>;
}
export interface TestingEntry {
  createTestDatabase(): Promise<TestDatabase>;
  acquireTestRedis(): Promise<TestRedis>;
}

/** Registers hooks for one api app over a fresh test database; the clock resets before each test. */
export function useHarness(name: string, load: () => Promise<TestingEntry>): Harness {
  let database: TestDatabase | undefined;
  let redis: TestRedis | undefined;
  let db: Kysely<DB> | undefined;
  let app: HttpApp | undefined;
  let directory: string | undefined;
  const clock = new FixedClock(NOW);

  beforeAll(async () => {
    const testing = await load();
    database = await testing.createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
    redis = await testing.acquireTestRedis();
    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    directory = mkdtempSync(join(base, `f1-02f-${name}-`));
    // Ephemeral synthetic key material only; no real credentials are read.
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(directory, 'synthetic-master.hex');
    const keyringFile = join(directory, 'synthetic-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
    const jwt = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp(
        entry: 'api',
        options: {
          config: ReturnType<typeof loadConfig>;
          clock: FixedClock;
          logger: ReturnType<typeof createRootLogger>;
          dbHandles: DbHandles;
          redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
        },
      ): Promise<HttpApp>;
    };
    app = await createHttpApp('api', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: masterFile,
        FIELD_KEYRING_FILE: keyringFile,
        JWT_KEY_ID: 'f1-02f-p256',
        JWT_PRIVATE_KEY_PEM: jwt.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock,
      logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
      dbHandles: { db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('api', {
        DATABASE_URL: database.urlFor('couli_app'),
        REDIS_URL: redis.url,
      }).redisUrl,
    });
    await app.init();
  }, 180_000);

  beforeEach(() => {
    clock.set(new Date(NOW));
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        if (db !== undefined) await destroyDb(db);
        await database?.drop();
      } finally {
        await redis?.stop();
        if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  return {
    get db() {
      return db!;
    },
    clock,
    get(appId, url) {
      return app!.inject({
        method: 'GET',
        url,
        headers: { 'x-app-id': appId, 'x-platform': 'ios', 'x-app-version': '2.0.0' },
      });
    },
  };
}

let appSequence = 0;
/** A fresh app id per test (X-App-Id pattern ^[a-z0-9_]+$, at most 32 characters). */
export function newAppId(): string {
  appSequence += 1;
  return `f102f_${process.pid.toString(36)}_${appSequence}`;
}

let idSequence = 0;
/**
 * Lowercase canonical UUIDs, strictly increasing in creation order (so id DESC is predictable).
 * The primary key (id, version) is global, so ids never repeat inside one database.
 */
export function newId(): string {
  idSequence += 1;
  return `0199f102-f000-7000-8000-${idSequence.toString(16).padStart(12, '0')}`;
}

/** Instant `ms` milliseconds before (negative) or after NOW, as ISO text with millisecond precision. */
export function at(ms: number): string {
  return new Date(Date.parse(NOW) + ms).toISOString();
}

export interface Row {
  id: string;
  appId: string;
  category: Category;
  version?: number;
  title?: string;
  body?: string;
  status?: string;
  /** ISO text (microseconds allowed, passed to PG as text) or null. */
  publishedAt?: string | null;
  noticeClosable?: boolean;
  noticeContentVersion?: number;
  noticeEndAt?: string | null;
}

/** Inserts one article revision with every column filled. Defaults: published one hour ago, v1. */
export async function seedArticle(db: Kysely<DB>, row: Row): Promise<Required<Row>> {
  const full: Required<Row> = {
    version: 1,
    title: `标题 ${row.id} v${row.version ?? 1}`,
    body: `正文 ${row.id} v${row.version ?? 1}`,
    status: 'published',
    publishedAt: at(-3_600_000),
    noticeClosable: true,
    noticeContentVersion: 1,
    noticeEndAt: null,
    ...row,
  };
  await db
    .insertInto('articles')
    .values({
      id: full.id,
      app_id: full.appId,
      category: full.category,
      title: full.title,
      body: full.body,
      version: full.version,
      status: full.status,
      published_at: full.publishedAt,
      notice_closable: full.noticeClosable,
      notice_content_version: full.noticeContentVersion,
      notice_end_at: full.noticeEndAt,
      row_version: 0,
      created_at: at(-86_400_000),
      updated_at: at(-86_400_000),
    })
    .execute();
  return full;
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
async function responseValidators() {
  validators ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          {
            get: {
              responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
            };
          }
        >;
      }>;
    };
    const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    const compile = createValidatorCompiler();
    const result = new Map<string, Validator>();
    for (const path of [LIST, DETAIL]) {
      for (const status of ['200', '4XX', '5XX']) {
        result.set(
          `${path}:${status}`,
          compile({
            schema: doc.paths[path]!.get.responses[status]!.content['application/json']!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  return validators;
}

/** The body passes the contract schema of its status class (200 / 4XX / 5XX) for that path. */
export async function validate(response: Response, path: string): Promise<void> {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(`${path}:${status}`)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

function query(category: Category, options: { cursor?: string; limit?: number }): string {
  const params = new URLSearchParams({ category });
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  return `${LIST}?${params.toString()}`;
}

export async function listRaw(
  h: Harness,
  appId: string,
  category: Category,
  options: { cursor?: string; limit?: number } = {},
): Promise<Response> {
  return h.get(appId, query(category, options));
}

/** One successful page, contract-checked. */
export async function list(
  h: Harness,
  appId: string,
  category: Category,
  options: { cursor?: string; limit?: number } = {},
): Promise<Page> {
  const response = await listRaw(h, appId, category, options);
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, LIST);
  return response.json<{ data: Page }>().data;
}

/** Follows next_cursor to the end; every page has at most `limit` items. */
export async function listAll(
  h: Harness,
  appId: string,
  category: Category,
  limit: number,
): Promise<{ ids: string[]; pages: Page[] }> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await list(h, appId, category, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages.push(page);
    expect(page.items.length).toBeLessThanOrEqual(limit);
    if (page.next_cursor === null) break;
    expect(page.items).toHaveLength(limit);
    cursor = page.next_cursor;
  }
  expect(pages.at(-1)!.next_cursor).toBeNull();
  return { ids: pages.flatMap((page) => page.items.map((item) => item.article_id)), pages };
}

export async function detailRaw(
  h: Harness,
  appId: string,
  id: string,
  version?: number,
): Promise<Response> {
  const suffix = version === undefined ? '' : `?version=${version}`;
  return h.get(appId, `/v1/articles/${encodeURIComponent(id)}${suffix}`);
}

export async function detail(
  h: Harness,
  appId: string,
  id: string,
  version?: number,
): Promise<Article> {
  const response = await detailRaw(h, appId, id, version);
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, DETAIL);
  return response.json<{ data: Article }>().data;
}

/** 404 / 30701 with a contract-valid error envelope. */
export async function notFound(response: Response): Promise<void> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(404);
  expect(response.json()).toMatchObject({ code: 30701 });
  await validate(response, DETAIL);
}

/** 400 / 20001 on the list path; `fields` checked exactly when given. */
export async function invalid(response: Response, fields?: string[]): Promise<void> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001 });
  if (fields !== undefined) {
    expect(response.json<{ data: { fields: string[] } }>().data.fields).toEqual(fields);
  }
  await validate(response, LIST);
}

export function sameInstant(actual: string | null, expected: string | null): void {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  expect(Date.parse(actual!)).toBe(Date.parse(expected));
}
