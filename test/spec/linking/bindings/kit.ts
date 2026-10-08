import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { LinkingModule } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  UnionBindingExchanger,
  type UnionBindingExchangeInput,
  type UnionBindingExchangeResult,
} from '../../../../apps/api/src/modules/linking/application/union-binding-exchanger.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { buildApp, type Response } from '../../identity/sms-codes/http-kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const NOW = '2026-10-08T04:05:06.789Z';
export const RELATION = 'synthetic-relation-from-exchanger';
export const ACCOUNT_NAME = 'synthetic-private-account-name';
export interface WireResponse extends Response {
  readonly payload: string;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(key: symbol): T;
  inject(request: {
    method: 'POST' | 'GET';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<WireResponse>;
}
interface Database {
  urlFor(role: string): string;
  drop(): Promise<void>;
}
interface Redis {
  url: string;
  stop(): Promise<void>;
}
const originalLinking = LinkingModule.forRoot;

async function open(database: Database, redis: Redis) {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  const clock = new FixedClock(NOW);
  const { logger, lines } = memoryLogger();
  const exchange =
    vi.fn<(input: UnionBindingExchangeInput) => Promise<UnionBindingExchangeResult>>();
  exchange.mockResolvedValue({ kind: 'bound', relationId: RELATION });
  const spy = vi.spyOn(LinkingModule, 'forRoot').mockImplementation((...args) => {
    const module = originalLinking(...args);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []),
        { provide: UnionBindingExchanger, useValue: { exchange } },
      ],
    };
  });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'bindings-'));
  let app: HttpApp | undefined;
  try {
    app = (await buildApp(db, dir, redis.url, clock, logger)) as HttpApp;
    await app.init();
    return {
      db,
      clock,
      lines,
      exchange,
      app,
      async close() {
        try {
          await app?.close();
        } finally {
          spy.mockRestore();
          await destroyDb(db);
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await app?.close();
    spy.mockRestore();
    await destroyDb(db);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
export type Fixture = Awaited<ReturnType<typeof open>>;

// Only *.int.test.ts import the database testing package and pass its factories here.
export function suite(createDatabase: () => Promise<Database>, acquireRedis: () => Promise<Redis>) {
  let database: Database | undefined;
  let redis: Redis | undefined;
  let fixture: Fixture;
  beforeAll(async () => {
    database = await createDatabase();
    redis = await acquireRedis();
    fixture = await open(database, redis);
  }, 180_000);
  beforeEach(() => {
    fixture.clock.set(NOW);
    fixture.exchange.mockReset().mockResolvedValue({ kind: 'bound', relationId: RELATION });
    fixture.lines.length = 0;
  });
  afterAll(async () => {
    try {
      await fixture?.close();
    } finally {
      try {
        await database?.drop();
      } finally {
        await redis?.stop();
      }
    }
  }, 30_000);
  return () => fixture;
}
