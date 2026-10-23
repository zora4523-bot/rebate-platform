// B1-02zj (D10-255 ①) entry layer: the real stream and api entries built by bootstrap's
// createHttpApp from loadConfig's staging configuration (the assembly of
// test/spec/agent/stream-review/composition-root.int.test.ts, without a database: the kms keyring
// is replaced by null and an in-memory field keyring is provided as FIELD_CRYPTO instead, as that
// test does; nothing listens, HTTP goes through Fastify inject only).
// - stream (verify-only) starts with JWT_PUBLIC_KEY_PEM + JWT_KEY_ID only, verifies tokens the
//   private key signed at stage ② (JWT_VERIFY_KEYS_JSON's previous kids too), answers 10002 for an
//   unknown kid, another key, a changed signature or once the Clock reaches exp, and cannot sign
//   (its token service refuses, its key port holds no private key), also when given the private
//   key of an existing deployment.
// - stream without either key refuses to start, naming JWT_PUBLIC_KEY_PEM.
// - api (signing) given only the public key still refuses to start, naming JWT_PRIVATE_KEY_PEM;
//   the same fixture with the private key starts, so the missing private key is the only cause.
// Keys are generated in the test (node:crypto); no .env file is read.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  type TokenService,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import {
  TOKEN_KEYS,
  TOKEN_SERVICE,
} from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  loadConfig,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  KID,
  OTHER_KID,
  PREVIOUS_KID,
  PRINCIPAL,
  accessToken,
  clock,
  cloudEnv,
  describeError,
  p256,
  pemBodyLine,
  privateKeysIn,
  settle,
  settleSync,
  tamperSignature,
  type Settled,
} from './kit.ts';

// Starting Nest (and loading it the first time) is slow on CI runners.
const NEST_TIMEOUT_MS = 60_000;

interface App {
  init(): Promise<unknown>;
  close(): Promise<void>;
  get(token: unknown, options?: { strict: boolean }): unknown;
  inject(options: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }): Promise<{ statusCode: number; body: string }>;
}

type HttpEntry = 'api' | 'stream';

interface Bootstrap {
  createHttpApp(entry: HttpEntry, overrides: object): Promise<App>;
}

interface PlatformExports {
  readonly FIELD_CRYPTO: symbol;
  readonly PlatformModule: {
    forRoot(options: object): { providers?: unknown[]; exports?: unknown[] };
  };
}

/** An apps/api/src module by URL (Nest sources use api's decorator-enabled compilation). */
function apiSource(path: string): string {
  return new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;
}

/** Loaded by URL (as the stream module tests do): bootstrap pulls in the Nest controllers. */
async function bootstrap(): Promise<Bootstrap> {
  return (await import(apiSource('bootstrap.ts'))) as Bootstrap;
}

/**
 * Every entry started here gets an in-memory field keyring as FIELD_CRYPTO (the kms keyring of
 * the staging configuration is replaced by null and never opened). Staging refuses to build
 * item_ref, search cursors and SMS codes without one, so with it a refusal to start can only come
 * from the JWT_* keys. Same seam as test/spec/agent/stream-review/composition-root.int.test.ts.
 */
beforeEach(async () => {
  const platform = (await import(apiSource('modules/platform/index.ts'))) as PlatformExports;
  const provider = new LocalKeyProvider(randomBytes(32), 'synthetic-jwt-verify-only');
  const fieldCrypto = await openFieldCrypto(await createWrappedKeyring(provider), provider);
  const original = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []),
        { provide: platform.FIELD_CRYPTO, useValue: fieldCrypto },
      ],
      exports: [...(module.exports ?? []), platform.FIELD_CRYPTO],
    };
  });
}, NEST_TIMEOUT_MS);

const opened: App[] = [];
afterEach(async () => {
  try {
    await Promise.all(opened.splice(0).map((app) => app.close()));
  } finally {
    vi.restoreAllMocks();
  }
});

function memoryLogger(entry: HttpEntry): { logger: RootLogger; lines: string[] } {
  const lines: string[] = [];
  const destination = {
    write(line: string): void {
      lines.push(line);
    },
  };
  const logger = createRootLogger({ level: 'info', entry, appEnv: 'staging' }, destination);
  return { logger, lines };
}

/** loadConfig's staging configuration (keyring replaced by null: no file, no KMS is touched). */
function stagingConfig(jwt: Readonly<Record<string, string>>): Settled<AppConfig> {
  return settleSync(() => ({ ...loadConfig(cloudEnv('staging', jwt)), keyring: null }));
}

/** createHttpApp as entry.ts calls it (no database handles, nothing listens). */
async function start(
  entry: HttpEntry,
  config: AppConfig,
  logger: RootLogger,
  at: FixedClock = clock(),
): Promise<Settled<App>> {
  const boot = await bootstrap();
  const overrides = { config, clock: at, logger };
  const outcome = await settle(() => boot.createHttpApp(entry, overrides));
  if ('value' in outcome) opened.push(outcome.value);
  return outcome;
}

/** `loaded` / `started`, or what the error says. */
function reached(outcome: Settled<unknown>, word: string): string {
  return 'value' in outcome ? word : describeError(outcome.error);
}

/** What the error says, or `started` when the entry started. */
function refusal(outcome: Settled<unknown>): string {
  return 'error' in outcome ? describeError(outcome.error) : 'started';
}

interface SigningAbility {
  readonly tokenService: string;
  readonly tokenKeys: string;
}

/** What the entry could sign with: its token service and its key port (either may be absent). */
async function signingAbility(app: App): Promise<SigningAbility> {
  const service = settleSync(() => app.get(TOKEN_SERVICE, { strict: false }));
  let tokenService = 'absent';
  if ('value' in service && service.value !== null && service.value !== undefined) {
    const tokens = service.value as TokenService;
    const issued = await settle(() => tokens.issueAccess(PRINCIPAL));
    tokenService = 'error' in issued ? 'refuses to sign' : 'signs';
  }
  const keys = settleSync(() => app.get(TOKEN_KEYS, { strict: false }));
  let tokenKeys = 'absent';
  if ('value' in keys && keys.value !== null && keys.value !== undefined) {
    tokenKeys = `${String(privateKeysIn(keys.value))} private keys`;
  }
  return { tokenService, tokenKeys };
}

function expectCannotSign(ability: SigningAbility): void {
  const why = JSON.stringify(ability);
  expect(['absent', 'refuses to sign'], why).toContain(ability.tokenService);
  expect(['absent', '0 private keys'], why).toContain(ability.tokenKeys);
}

const CLIENT_HEADERS = {
  'x-app-id': PRINCIPAL.app_id,
  'x-device-id': PRINCIPAL.device_id,
  'x-platform': 'ios',
  'x-channel': 'appstore',
  'x-app-version': '2.0.0',
};

/** Stage ②'s verdict on a token at an x-auth optional Agent route of the stream entry. */
async function stageTwo(app: App, token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/agent/sessions',
    headers: { ...CLIENT_HEADERS, authorization: `Bearer ${token}` },
  });
  let code: unknown;
  try {
    code = (JSON.parse(response.body) as { code?: unknown }).code;
  } catch {
    code = undefined;
  }
  if (code === 10002 || code === 10001) return `refused ${String(code)}`;
  // Past ②: without a database the session read fails closed afterwards (not a token answer).
  return 'passed ②';
}

it(
  '[D10-255][BR-ID-07] staging：stream 入口只给 JWT_PUBLIC_KEY_PEM + JWT_KEY_ID 能完成组装，且不能签发',
  async () => {
    const pair = p256();
    const loaded = stagingConfig({ JWT_KEY_ID: KID, JWT_PUBLIC_KEY_PEM: pair.publicPem });
    expect(reached(loaded, 'loaded')).toBe('loaded');
    if (!('value' in loaded)) return;
    const started = await start('stream', loaded.value, memoryLogger('stream').logger);
    expect(reached(started, 'started')).toBe('started');
    if (!('value' in started)) return;
    expectCannotSign(await signingAbility(started.value));
  },
  NEST_TIMEOUT_MS,
);

it(
  '[D10-255][BR-ID-01][BR-ID-07] staging：只配公钥的 stream 入口在 ② 验过私钥签发的令牌（含 JWT_VERIFY_KEYS_JSON 旧 kid），未知 kid、换钥、改签名、Clock 到 exp 后回 10002',
  async () => {
    const pair = p256();
    const previous = p256();
    const loaded = stagingConfig({
      JWT_KEY_ID: KID,
      JWT_PUBLIC_KEY_PEM: pair.publicPem,
      JWT_VERIFY_KEYS_JSON: JSON.stringify({ [PREVIOUS_KID]: previous.publicPem }),
    });
    expect(reached(loaded, 'loaded')).toBe('loaded');
    if (!('value' in loaded)) return;
    const at = clock();
    const started = await start('stream', loaded.value, memoryLogger('stream').logger, at);
    expect(reached(started, 'started')).toBe('started');
    if (!('value' in started)) return;
    const app = started.value;
    await app.init();

    const genuine = await accessToken(KID, pair);
    const tokens = {
      genuine,
      'previous kid': await accessToken(PREVIOUS_KID, previous),
      'unknown kid': await accessToken(OTHER_KID, pair),
      'other key': await accessToken(KID, p256()),
      'signature changed': tamperSignature(genuine),
    };
    const seen: Record<string, string> = {};
    for (const [label, token] of Object.entries(tokens)) {
      seen[label] = await stageTwo(app, token);
    }
    expect(seen).toEqual({
      genuine: 'passed ②',
      'previous kid': 'passed ②',
      'unknown kid': 'refused 10002',
      'other key': 'refused 10002',
      'signature changed': 'refused 10002',
    });

    // The entry's Clock moves on: one second before exp the token passes, from exp it is 10002
    // (zero tolerance, as the api's verifier answers an App sending an access token after 2 h).
    at.advanceMs((ACCESS_TOKEN_TTL_SECONDS - 1) * 1000);
    const beforeExp = await stageTwo(app, genuine);
    at.advanceMs(1000);
    const atExp = await stageTwo(app, genuine);
    at.advanceMs(60 * 60 * 1000);
    const hourLater = await stageTwo(app, genuine);
    expect({ beforeExp, atExp, hourLater }).toEqual({
      beforeExp: 'passed ②',
      atExp: 'refused 10002',
      hourLater: 'refused 10002',
    });
  },
  NEST_TIMEOUT_MS,
);

it(
  '[D10-255][BR-ID-07] staging：stream 只给 JWT_PRIVATE_KEY_PEM + JWT_KEY_ID（现有部署）照常启动、用导出的公钥验签，但不能签发，日志不含私钥',
  async () => {
    const pair = p256();
    const loaded = stagingConfig({ JWT_KEY_ID: KID, JWT_PRIVATE_KEY_PEM: pair.privatePem });
    expect(reached(loaded, 'loaded')).toBe('loaded');
    if (!('value' in loaded)) return;
    const { logger, lines } = memoryLogger('stream');
    const started = await start('stream', loaded.value, logger);
    expect(reached(started, 'started')).toBe('started');
    if (!('value' in started)) return;
    const app = started.value;
    expectCannotSign(await signingAbility(app));

    await app.init();
    const genuine = await stageTwo(app, await accessToken(KID, pair));
    const forged = await stageTwo(app, await accessToken(KID, p256()));
    expect({ genuine, forged }).toEqual({ genuine: 'passed ②', forged: 'refused 10002' });
    expect(lines.join('\n')).not.toContain(pemBodyLine(pair.privatePem));
  },
  NEST_TIMEOUT_MS,
);

it(
  '[D10-255][BR-ID-07] staging：公钥与私钥都缺（含只给 JWT_KEY_ID）时 stream 拒绝启动，报错点名 JWT_PUBLIC_KEY_PEM',
  async () => {
    const cases: Record<string, Record<string, string>> = {
      'no JWT_*': {},
      'JWT_KEY_ID only': { JWT_KEY_ID: KID },
    };
    const seen: Record<string, string> = {};
    for (const [label, jwt] of Object.entries(cases)) {
      const loaded = stagingConfig(jwt);
      if (!('value' in loaded)) {
        // Refused already by loadConfig: that is a refusal to start too.
        seen[label] = describeError(loaded.error);
        continue;
      }
      const started = await start('stream', loaded.value, memoryLogger('stream').logger);
      seen[label] = refusal(started);
    }
    for (const [label, outcome] of Object.entries(seen)) {
      expect(outcome, label).not.toBe('started');
      expect(outcome, label).toMatch(/JWT_PUBLIC_KEY_PEM/);
    }
  },
  NEST_TIMEOUT_MS,
);

it(
  '[D10-255][BR-ID-07] staging：api 入口给私钥照常启动；同一夹具只给 JWT_PUBLIC_KEY_PEM + JWT_KEY_ID 仍拒绝启动并点名 JWT_PRIVATE_KEY_PEM',
  async () => {
    const pair = p256();
    // Control: the api entry of this fixture (field keyring provided, no database) starts in
    // staging with the private key, so the refusal below has no cause but the missing private key.
    const signing = stagingConfig({
      JWT_KEY_ID: KID,
      JWT_PRIVATE_KEY_PEM: pair.privatePem,
      JWT_PUBLIC_KEY_PEM: pair.publicPem,
    });
    expect(reached(signing, 'loaded')).toBe('loaded');
    if (!('value' in signing)) return;
    const started = await start('api', signing.value, memoryLogger('api').logger);
    expect(reached(started, 'started')).toBe('started');
    if (!('value' in started)) return;
    expect((await signingAbility(started.value)).tokenService).toBe('signs');

    // The configuration itself is valid (the stream entry starts from it): the api refuses it.
    const publicOnly = stagingConfig({ JWT_KEY_ID: KID, JWT_PUBLIC_KEY_PEM: pair.publicPem });
    expect(reached(publicOnly, 'loaded')).toBe('loaded');
    if (!('value' in publicOnly)) return;
    const refused = await start('api', publicOnly.value, memoryLogger('api').logger);
    const said = refusal(refused);
    expect(said).not.toBe('started');
    expect(said).toMatch(/JWT_PRIVATE_KEY_PEM/);
  },
  NEST_TIMEOUT_MS,
);
