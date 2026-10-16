// B1-17c (round 2, review r1 S1 on wiring.test.ts): the quote hook writes through the same kind
// of capped recorder, and the cap holds across parse requests: several requests, each handing off
// several observations, keep at most 2 price_snapshot write transactions in flight together
// (B1-17b followup F; BR-WATCH-19 (1) 不得影响接口).
import { afterEach, expect, it, vi } from 'vitest';
import {
  ParsingModule,
  type ParsingOptions,
  type createParsing,
} from '../../../../apps/api/src/modules/parsing/index.ts';
import { DB, type RequestCheck } from '../../../../apps/api/src/modules/platform/index.ts';
import { observation } from '../price-history/kit.ts';
import { URL_A } from '../../parsing/core/kit.ts';
import { HEADERS, PATH, buildApp, type HttpApp } from '../../parsing/http/kit.ts';
import { fakeDb, settle } from './kit.ts';

// Global signing is owned by the risk tasks; same in-memory boundary as the parse route tests.
vi.mock(
  '../../../../apps/api/src/modules/risk/application/signature-check.ts',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../apps/api/src/modules/risk/application/signature-check.ts')
      >();
    const checks = new WeakSet<RequestCheck>();
    return {
      ...actual,
      createSignatureCheck() {
        const check: RequestCheck = async (request) => {
          request.verifiedDevice = { appId: 'couli', deviceId: 'synthetic-device' };
        };
        checks.add(check);
        return check;
      },
      isSignatureCheck: (check: RequestCheck) => checks.has(check),
    };
  },
);

const originalModule = ParsingModule.forRoot;
afterEach(() => vi.restoreAllMocks());

/** Spies the route's parsing factory; the module also gets the DB stand-in. */
function parsingModuleWith(db: unknown) {
  const handed: ParsingOptions[] = [];
  const factory = vi.fn((options: ParsingOptions) => {
    handed.push(options);
    return { parseInput: async () => [] };
  }) as unknown as typeof createParsing;
  vi.spyOn(ParsingModule, 'forRoot').mockImplementation((config, options) => {
    const module = originalModule(config, { ...options, createParsing: factory });
    return {
      ...module,
      providers: [...(module.providers ?? []), { provide: DB, useValue: db }],
    };
  });
  return handed;
}

async function post(app: HttpApp) {
  return app.inject({
    method: 'POST',
    url: PATH,
    headers: HEADERS,
    payload: JSON.stringify({ text: URL_A, scene: 'clipboard' }),
  });
}

it('[AC-B1-17c#21] ParsingModule：三个解析请求各交出三条可写观测，写事务合计最多 2 个在途（上限按进程而非按请求），其余随释放补上', async () => {
  const database = fakeDb(true);
  const handed = parsingModuleWith(database.db);
  const app = await buildApp([]);
  try {
    await Promise.all([post(app), post(app), post(app)]);
    expect(handed).toHaveLength(3);
    expect(handed.map((options) => typeof options.priceHistory?.record)).toEqual([
      'function',
      'function',
      'function',
    ]);
    for (const [request, options] of handed.entries()) {
      for (const n of ['1', '2', '3']) {
        options.priceHistory!.record(
          observation({ appId: 'couli', productKey: `tb:q${request}${n}`, sourceKind: 'quote' }),
        );
      }
    }
    await vi.waitFor(() => expect(database.execute).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    await settle(30);
    expect(database.execute).toHaveBeenCalledTimes(2);
    expect(database.inFlight()).toBe(2);

    const peaks: number[] = [];
    for (let step = 0; step < 20 && database.execute.mock.calls.length < 9; step += 1) {
      database.releaseOne();
      await settle(10);
      peaks.push(database.inFlight());
    }
    expect(database.execute).toHaveBeenCalledTimes(9);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(2);
  } finally {
    database.releaseAll();
    await app.close();
  }
}, 10000);
