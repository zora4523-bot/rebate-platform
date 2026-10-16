// B1-17c: ParsingModule wiring of the quote hook (orchestrator semantics B.6): with a DB handle
// the route hands createParsing a recorder built by createPriceHistoryRecorder over that handle;
// without one it hands none (the hook is off and parsing is unchanged).
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
import { fakeDb } from './kit.ts';

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

/** Spies the route's parsing factory; with `db`, the module also gets that DB handle. */
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
      providers: [
        ...(module.providers ?? []),
        ...(db === undefined ? [] : [{ provide: DB, useValue: db }]),
      ],
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

it('[AC-B1-17c#17] ParsingModule：有 DB 句柄时路由把模块装配的记录器交给 createParsing，可写观测经它写库；无 DB 时不交', async () => {
  const database = fakeDb(false);
  const handed = parsingModuleWith(database.db);
  const app = await buildApp([]);
  try {
    await post(app);
    expect(handed).toHaveLength(1);
    const recorder = handed[0]!.priceHistory;
    expect(typeof recorder?.record).toBe('function');
    recorder!.record(observation({ appId: 'couli', productKey: 'tb:a', sourceKind: 'quote' }));
    await recorder!.drain();
    expect(database.execute).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }

  vi.restoreAllMocks();
  const plain = parsingModuleWith(undefined);
  const bare = await buildApp([]);
  try {
    await post(bare);
    expect(plain).toHaveLength(1);
    expect(plain[0]!.priceHistory).toBeUndefined();
  } finally {
    await bare.close();
  }
}, 10000);
