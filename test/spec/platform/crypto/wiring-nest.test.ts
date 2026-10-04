// Rule tests that start the process entries (规划/08 BR-ID-33; ADR-0001 §2 鉴权与密钥、配置校验;
// 规划/02 §12.6; 规划/11 §8; §4–§6 of apps/api/src/modules/platform/config/keyring-startup.ts):
// every entry opens the keyring while it starts and hands the opened FieldCrypto to the other
// modules through the token FIELD_CRYPTO; what platform/index.ts exports; a consumer module gets
// FIELD_CRYPTO by injection; nothing the injected cipher handles reaches a log line.
// Entries are started like the entry runner does — createHttpApp for api / stream / admin (never
// app.init(), so a failure must come from creating the providers), createWorkerContext for
// worker / payout — with an in-memory pino logger at level trace whose every line is searched for
// key material, the files' paths and content, and the synthetic personal data.
// All tests that load Nest are in this one file so that Nest is loaded once (a Vitest file is an
// isolated module graph); the entries that open the three test keyrings successfully are started
// once in beforeAll and shared by the tests that only read them. Top-level it() only.
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { clockFromConfig } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { KeyringStartupErrorCode } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import * as crypto from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createDbHandles,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import * as http from '../../../../apps/api/src/modules/platform/http/index.ts';
import {
  BLIND_KEY_LABEL,
  SAMPLES,
  leaksIn,
  parseV1,
  referenceBlindIndex,
  referenceDecrypt,
  referenceEncrypt,
  shapeProblems,
  testKey,
} from './kit.ts';
import {
  CURRENT_VERSION,
  ENTRIES,
  OTHER_MASTER_LABEL,
  PLAINTEXT_SAMPLES,
  PROBLEMS,
  cipherProblems,
  configProblems,
  keyringDoc,
  localEnv,
  makeDir,
  masterText,
  memoryLogger,
  platformIndex,
  removeDir,
  secretsOf,
  settle,
  settleSync,
  startAndClose,
  startEntry,
  startupErrorProblems,
  stubProcessEnv,
  writeFiles,
  type Entry,
  type LocalFiles,
  type StartedApp,
} from './wiring-kit.ts';

// Starting Nest (and loading it the first time) is slow on CI runners, several times slower than
// on a workstation: an explicit timeout keeps the default 5 s from failing a correct entry.
const NEST_TIMEOUT_MS = 30_000;
const SHARED_START_TIMEOUT_MS = 120_000;

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
});

function fresh(label: string, contents: Parameters<typeof writeFiles>[1] = {}): LocalFiles {
  const dir = makeDir(label);
  dirs.push(dir);
  return writeFiles(dir, contents);
}

/** What the entry runner gives createDbHandles; nothing connects until a query runs. */
function dbHandlesFor(entry: Entry, logger: object) {
  return createDbHandles(
    loadConnectionConfig(entry, {
      DATABASE_URL: `postgres://${entry === 'payout' ? 'couli_payout' : 'couli_app'}@127.0.0.1:1/couli`,
      DATABASE_READ_URL: 'postgres://couli_readonly@127.0.0.1:1/couli',
      REDIS_URL: 'redis://127.0.0.1:1/0',
    }),
    { logger: logger as Parameters<typeof createDbHandles>[1]['logger'] },
  );
}

/** process.env pointing somewhere else entirely: an entry that reads it instead of the config fails. */
function misleadingProcessEnv(files: LocalFiles): void {
  stubProcessEnv({
    APP_ENV: 'prod',
    FIELD_KEY_PROVIDER: 'kms',
    FIELD_KEYRING_FILE: `${files.dir}/process-env-keyring.json`,
    FIELD_MASTER_KEY_FILE: `${files.dir}/process-env-master.hex`,
  });
}

async function fieldCryptoToken(): Promise<unknown> {
  return (await platformIndex())['FIELD_CRYPTO'];
}

/** Problems of the value injected for FIELD_CRYPTO: shape, keys 1 and 2 of the test keyring. */
function injectedProblems(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [`not an object: ${String(value)}`];
  const shape = shapeProblems(value, { fieldCrypto: CURRENT_VERSION });
  if (shape.length > 0) return shape;
  const fc = value as FieldCrypto;
  const problems: string[] = [];
  for (const version of [1, 2]) {
    const ciphertext = referenceEncrypt(
      testKey(version),
      version,
      SAMPLES.alipay,
      'payout_accounts.alipay',
    );
    if (fc.decrypt(ciphertext, 'payout_accounts.alipay') !== SAMPLES.alipay) {
      problems.push(`decrypt v${version}`);
    }
  }
  const own = fc.encrypt(SAMPLES.phone, 'users.phone');
  if (referenceDecrypt(testKey(CURRENT_VERSION), own, 'users.phone') !== SAMPLES.phone) {
    problems.push('encrypt');
  }
  if (
    fc.blindIndex(SAMPLES.phone, 'users.phone') !==
    referenceBlindIndex(testKey(BLIND_KEY_LABEL), SAMPLES.phone, 'users.phone')
  ) {
    problems.push('blindIndex');
  }
  return problems;
}

/** The leaks found in the log lines (each line searched as printed). */
function logLeaks(
  lines: readonly string[],
  secrets: Readonly<Record<string, string | Uint8Array>>,
): string[] {
  return [...new Set(lines.flatMap((line) => leaksIn(line, secrets)))];
}

// ---- entries started once and shared ------------------------------------------------------------

/**
 * One started entry: its files, the lines of its logger, and the start's outcome. The three
 * keyrings of every entry:
 *   with-db  versions 1+2, current 2, APP_ENV=test, with database handles; after it started its
 *            master key file is deleted and its keyring file rewritten under another master key
 *   no-db    versions 1+2+3, current 2, APP_ENV=local, without database handles
 *   current1 versions 1+2, current 1, APP_ENV=test, without database handles
 * All three are started while process.env names a kms keyring in prod with other paths.
 */
interface SharedEntry {
  readonly files: LocalFiles;
  readonly lines: string[];
  readonly started: { readonly value: StartedApp } | { readonly error: unknown };
  readonly versions: readonly number[];
  readonly current: number;
}

const SHARED_KINDS = {
  'with-db': { versions: [1, 2], current: 2, appEnv: 'test', db: true },
  'no-db': { versions: [1, 2, 3], current: 2, appEnv: 'local', db: false },
  current1: { versions: [1, 2], current: 1, appEnv: 'test', db: false },
} as const;
type SharedKind = keyof typeof SHARED_KINDS;

const shared = new Map<string, SharedEntry>();

function sharedEntry(entry: Entry, kind: SharedKind): SharedEntry {
  const found = shared.get(`${entry}:${kind}`);
  if (found === undefined) throw new Error(`shared entry ${entry}:${kind} was not started`);
  return found;
}

beforeAll(async () => {
  misleadingProcessEnv(fresh('shared-env'));
  for (const entry of ENTRIES) {
    for (const [kind, spec] of Object.entries(SHARED_KINDS)) {
      const files = fresh(`shared-${kind}-${entry}`, {
        keyring: JSON.stringify(keyringDoc({ versions: spec.versions, current: spec.current })),
      });
      const { logger, lines } = memoryLogger(entry, spec.appEnv);
      const config = loadConfig(localEnv(spec.appEnv, files));
      const started = await settle(
        startEntry(
          entry,
          spec.db ? { config, logger, dbHandles: dbHandlesFor(entry, logger) } : { config, logger },
        ),
      );
      if (kind === 'with-db') {
        // Opened while the entry was created: the files are no longer needed.
        rmSync(files.masterFile);
        writeFileSync(
          files.keyringFile,
          JSON.stringify(keyringDoc({ masterLabel: OTHER_MASTER_LABEL })),
        );
      }
      shared.set(`${entry}:${kind}`, {
        files,
        lines,
        started,
        versions: spec.versions,
        current: spec.current,
      });
    }
  }
  vi.unstubAllEnvs();
}, SHARED_START_TIMEOUT_MS);

afterAll(async () => {
  for (const item of shared.values()) {
    if ('value' in item.started) await item.started.value.close();
  }
  for (const dir of dirs) removeDir(dir);
}, SHARED_START_TIMEOUT_MS);

// ---- wiring per entry ---------------------------------------------------------------------------

it.each(ENTRIES)(
  '[BR-ID-33][ADR-0001 §2] %s 入口带数据库句柄启动：注入的 FIELD_CRYPTO 是已打开的 FieldCrypto，启动后删改文件不影响，日志无密钥与路径',
  async (entry) => {
    const { files, lines, started } = sharedEntry(entry, 'with-db');
    const token = await fieldCryptoToken();
    expect(typeof token).toBe('symbol');
    expect('value' in started ? 'started' : started.error).toBe('started');
    if (!('value' in started)) return;
    const first = settleSync(() => started.value.get(token));
    const second = settleSync(() => started.value.get(token));
    expect('value' in first ? injectedProblems(first.value) : [String(first.error)]).toEqual([]);
    expect('value' in first && 'value' in second && first.value === second.value).toBe(true);
    expect(logLeaks(lines, secretsOf(files))).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);

it.each(ENTRIES)(
  '[BR-ID-33][ADR-0001 §2] %s 入口不带数据库句柄时同样提供 FIELD_CRYPTO（与 dbHandles 无关）',
  async (entry) => {
    const { started } = sharedEntry(entry, 'no-db');
    const token = await fieldCryptoToken();
    expect(typeof token).toBe('symbol');
    expect('value' in started ? 'started' : started.error).toBe('started');
    if (!('value' in started)) return;
    const injected = settleSync(() => started.value.get(token));
    expect(
      'value' in injected ? injectedProblems(injected.value) : [String(injected.error)],
    ).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);

/**
 * The failures of opening, each as the files and the config that cause it. The configs are
 * loadConfig's result for APP_ENV=test with the keyring written out by hand, so that a case can
 * name a file loadConfig would not accept or an AppConfig that skipped loadConfig.
 */
function failureCases(entry: Entry): {
  readonly label: string;
  readonly code: KeyringStartupErrorCode;
  readonly files: LocalFiles;
  readonly config: object;
}[] {
  const hex = testKey(71).toString('hex');
  const make = (
    label: string,
    contents: Parameters<typeof writeFiles>[1],
    code: KeyringStartupErrorCode,
    edit: (files: LocalFiles) => { appEnv?: string; keyring: object },
  ) => {
    const files = fresh(`fail-${entry}`, contents);
    const base = loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' });
    return { label, code, files, config: { ...base, ...edit(files) } };
  };
  const local = (files: LocalFiles) => ({
    keyring: { provider: 'local', keyringFile: files.keyringFile, masterKeyFile: files.masterFile },
  });
  return [
    make('master key file is /dev/null', {}, 'master_key_unreadable', (files) => ({
      keyring: { provider: 'local', keyringFile: files.keyringFile, masterKeyFile: '/dev/null' },
    })),
    make(
      'master key not lower-case hex',
      { master: `${hex.toUpperCase()}\n` },
      'master_key_invalid',
      local,
    ),
    make('no keyring file', {}, 'keyring_unreadable', (files) => ({
      keyring: {
        provider: 'local',
        keyringFile: `${files.keyringFile}.missing`,
        masterKeyFile: files.masterFile,
      },
    })),
    make(
      'keyring not JSON and quoting the master key',
      { keyring: `master ${hex}` },
      'keyring_invalid',
      local,
    ),
    make('other master key', { master: masterText(OTHER_MASTER_LABEL) }, 'unwrap_failed', local),
    make('hand-built prod config with the local provider', {}, 'local_in_cloud', (files) => ({
      ...local(files),
      appEnv: 'prod',
    })),
    make('hand-built staging config with the local provider', {}, 'local_in_cloud', (files) => ({
      ...local(files),
      appEnv: 'staging',
    })),
    make('kms', {}, 'kms_unavailable', (files) => ({
      appEnv: 'staging',
      keyring: { provider: 'kms', keyringFile: files.keyringFile },
    })),
  ];
}

it.each(ENTRIES)(
  '[BR-ID-33][ADR-0001 §2] %s 入口打开失败时创建本身就失败，错误是确切的 KeyringStartupError，日志无密钥、路径与文件内容',
  async (entry) => {
    misleadingProcessEnv(fresh(`env-${entry}`));
    const cases = failureCases(entry);
    const results: Record<string, string[]> = {};
    for (const failure of cases) {
      const { logger, lines } = memoryLogger(entry, 'test');
      const outcome = await startAndClose(entry, { config: failure.config, logger });
      const problems =
        'error' in outcome ? startupErrorProblems(outcome.error, failure.code) : ['started'];
      const leaks = logLeaks(lines, {
        ...secretsOf(failure.files),
        'file content (master key hex)': testKey(71).toString('hex').toUpperCase(),
      });
      results[failure.label] = [...problems, ...leaks.map((name) => `log leaks ${name}`)];
    }
    expect(results).toEqual(Object.fromEntries(cases.map((c) => [c.label, []])));
  },
  NEST_TIMEOUT_MS,
);

it.each(ENTRIES)(
  '[ADR-0001 §2][规划/02 §12.6] %s 入口在 staging 与 prod 缺 keyring 配置时拒绝启动（经 loadConfig(process.env)）',
  async (entry) => {
    const seen: Record<string, unknown> = {};
    for (const appEnv of ['staging', 'prod'] as const) {
      stubProcessEnv({ APP_ENV: appEnv, LOG_LEVEL: 'silent' });
      const { logger } = memoryLogger(entry, appEnv);
      const outcome = await startAndClose(entry, { logger });
      seen[appEnv] =
        'error' in outcome
          ? configProblems(() => {
              throw outcome.error;
            })
          : 'started';
    }
    expect(seen).toEqual({
      staging: [PROBLEMS.providerUnset('staging')],
      prod: [PROBLEMS.providerUnset('prod')],
    });
  },
  NEST_TIMEOUT_MS,
);

it.each(ENTRIES)(
  '[ADR-0001 §2][规划/02 §12.6] %s 入口在 staging 与 prod 选 local 提供者拒绝启动；local 允许并注入可用的 FieldCrypto（经 loadConfig(process.env)）',
  async (entry) => {
    const files = fresh(`env-local-${entry}`);
    const refused: Record<string, unknown> = {};
    for (const appEnv of ['staging', 'prod'] as const) {
      stubProcessEnv(localEnv(appEnv, files));
      const outcome = await startAndClose(entry, { logger: memoryLogger(entry, appEnv).logger });
      refused[appEnv] =
        'error' in outcome
          ? configProblems(() => {
              throw outcome.error;
            })
          : 'started';
      vi.unstubAllEnvs();
    }
    expect(refused).toEqual({
      staging: [PROBLEMS.localInCloud('staging')],
      prod: [PROBLEMS.localInCloud('prod')],
    });

    stubProcessEnv(localEnv('local', files));
    const { logger, lines } = memoryLogger(entry, 'local');
    const local = await settle(startEntry(entry, { logger }));
    const token = await fieldCryptoToken();
    expect('value' in local ? 'started' : local.error).toBe('started');
    if (!('value' in local)) return;
    const injected = settleSync(() => local.value.get(token));
    await local.value.close();
    expect(
      'value' in injected ? injectedProblems(injected.value) : [String(injected.error)],
    ).toEqual([]);
    expect(logLeaks(lines, secretsOf(files))).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);

it.each(ENTRIES)(
  '[ADR-0001 §2] %s 入口在 staging 与 prod 选 kms 时配置通过、打开时以 kms_unavailable 拒绝启动',
  async (entry) => {
    const files = fresh(`env-kms-${entry}`);
    const seen: Record<string, string[]> = {};
    for (const appEnv of ['staging', 'prod'] as const) {
      stubProcessEnv({
        APP_ENV: appEnv,
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: files.keyringFile,
      });
      const { logger, lines } = memoryLogger(entry, appEnv);
      const outcome = await startAndClose(entry, { logger });
      seen[appEnv] = [
        ...('error' in outcome
          ? startupErrorProblems(outcome.error, 'kms_unavailable')
          : ['started']),
        ...logLeaks(lines, secretsOf(files)).map((name) => `log leaks ${name}`),
      ];
      vi.unstubAllEnvs();
    }
    expect(seen).toEqual({ staging: [], prod: [] });
  },
  NEST_TIMEOUT_MS,
);

it.each(ENTRIES)(
  '[规划/11 §8][ADR-0001 §2] %s 入口在 local 与 test 不设 keyring 时照常启动，AppConfig.keyring 为 null，不提供 FIELD_CRYPTO',
  async (entry) => {
    const token = await fieldCryptoToken();
    expect(typeof token).toBe('symbol');
    const { APP_CONFIG } = await platformIndex();
    const seen: Record<string, unknown> = {};
    for (const appEnv of ['local', 'test'] as const) {
      stubProcessEnv({ APP_ENV: appEnv, LOG_LEVEL: 'silent' });
      const started = await settle(
        startEntry(entry, { logger: memoryLogger(entry, appEnv).logger }),
      );
      if (!('value' in started)) {
        seen[appEnv] = started.error;
        continue;
      }
      const config = settleSync(() => started.value.get(APP_CONFIG));
      const injected = settleSync(() => started.value.get(token));
      await started.value.close();
      seen[appEnv] = {
        keyring:
          'value' in config ? (config.value as Record<string, unknown>)['keyring'] : 'no config',
        fieldCrypto: 'error' in injected ? 'not provided' : 'provided',
      };
      vi.unstubAllEnvs();
    }
    expect(seen).toEqual({
      local: { keyring: null, fieldCrypto: 'not provided' },
      test: { keyring: null, fieldCrypto: 'not provided' },
    });
  },
  NEST_TIMEOUT_MS,
);

// ---- review round 1: the injected cipher (key version, members, rotation) ----------------------

it.each(ENTRIES)(
  '[BR-ID-33][ADR-0001 §2] %s 入口注入的 FIELD_CRYPTO：密文带 current_version、能解自己的密文、方法集合完整、经它轮换后明文与盲索引不变',
  async (entry) => {
    const token = (await platformIndex())['FIELD_CRYPTO'];
    expect(typeof token).toBe('symbol');
    const seen: Record<string, string[]> = {};
    for (const kind of ['with-db', 'current1', 'no-db'] as const) {
      const { files, lines, started, versions, current } = sharedEntry(entry, kind);
      const key = `${versions.join('+')}@${String(current)}`;
      if (!('value' in started)) {
        seen[key] = ['did not start'];
        continue;
      }
      const injected = settleSync(() => started.value.get(token));
      const problems =
        'value' in injected ? cipherProblems(injected.value, versions, current) : ['not provided'];
      // Every method above ran on the id number sample: no log line may carry it (BR-ID-33).
      const leaks = logLeaks(lines, secretsOf(files));
      seen[key] = [...problems, ...leaks.map((name) => `log leaks ${name}`)];
    }
    expect(seen).toEqual({ '1+2@2': [], '1+2@1': [], '1+2+3@2': [] });
  },
  NEST_TIMEOUT_MS,
);

// ---- review round 1: a consumer module of another feature --------------------------------------

interface NestFactoryLike {
  createApplicationContext(
    module: object,
    options: object,
  ): Promise<{ get(token: unknown, options?: object): unknown; close(): Promise<void> }>;
}

/** NestFactory of the very @nestjs/core that apps/api uses (the test project has no Nest). */
async function nestFactory(): Promise<NestFactoryLike> {
  const apiDir = fileURLToPath(new URL('../../../../apps/api/', import.meta.url));
  const entry = realpathSync(join(apiDir, 'node_modules', '@nestjs', 'core', 'index.js'));
  const core = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as {
    NestFactory: NestFactoryLike;
  };
  return core.NestFactory;
}

const CONSUMER = Symbol('B1_01K_CONSUMER');

/** What the consumer saw through injection. */
interface ConsumerView {
  readonly injected: unknown;
  readonly version: number | string;
  readonly roundTrip: boolean;
}

it.each(ENTRIES)(
  '[BR-ID-33][ADR-0001 §2] %s：PlatformModule 导出 FIELD_CRYPTO，另一个功能模块经依赖注入（inject）拿到已打开的 FieldCrypto 并能加解密，应用能启动',
  async (entry) => {
    const index = await platformIndex();
    const token = index['FIELD_CRYPTO'];
    expect(typeof token).toBe('symbol');
    const platform = index['PlatformModule'] as { forRoot(options: object): object };
    const files = fresh(`r1-consumer-${entry}`);
    const config = loadConfig(localEnv('test', files));
    const { logger, lines } = memoryLogger(entry, 'test');
    class ConsumerModule {}
    class ConsumerRoot {}
    const consumer = {
      module: ConsumerModule,
      providers: [
        {
          provide: CONSUMER,
          inject: [token],
          useFactory: (fc: FieldCrypto): ConsumerView => {
            const ciphertext = fc.encrypt(SAMPLES.phone, 'users.phone');
            const parsed = settleSync(() => parseV1(ciphertext).version);
            return {
              injected: fc,
              version: 'value' in parsed ? parsed.value : 'unparsable',
              roundTrip: fc.decrypt(ciphertext, 'users.phone') === SAMPLES.phone,
            };
          },
        },
      ],
      exports: [CONSUMER],
    };
    const root = {
      module: ConsumerRoot,
      imports: [
        platform.forRoot({ entry, config, clock: clockFromConfig(config), logger }),
        consumer,
      ],
    };
    const factory = await nestFactory();
    const app = await settle(
      factory.createApplicationContext(root, { logger: false, abortOnError: false }),
    );
    if (!('value' in app)) {
      expect(String(app.error)).toBe('the application with the consumer module started');
      return;
    }
    const view = settleSync(() => app.value.get(CONSUMER, { strict: false }) as ConsumerView);
    const direct = settleSync(() => app.value.get(token, { strict: false }));
    await app.value.close();
    expect(
      'value' in view
        ? { version: view.value.version, roundTrip: view.value.roundTrip }
        : view.error,
    ).toEqual({
      version: 2,
      roundTrip: true,
    });
    expect('value' in view && 'value' in direct && view.value.injected === direct.value).toBe(true);
    expect(logLeaks(lines, secretsOf(files))).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);

// ---- review round 2: no plaintext in the entry's log after using the injected cipher ----------

/** Runs every method of the cipher on every sample; returns what did not work as it should. */
function exercise(fc: FieldCrypto): string[] {
  const problems: string[] = [];
  for (const [label, value] of Object.entries(PLAINTEXT_SAMPLES)) {
    const context = 'payout_accounts.account';
    const own = fc.encrypt(value, context);
    if (fc.decrypt(own, context) !== value) problems.push(`decrypt ${label}`);
    const old = referenceEncrypt(testKey(1), 1, value, context);
    if (!fc.needsReencrypt(old) || fc.keyVersionOf(old) !== 1) problems.push(`version ${label}`);
    if (fc.decrypt(fc.reencrypt(old, context), context) !== value)
      problems.push(`reencrypt ${label}`);
    if (fc.blindIndex(value, context) !== fc.blindIndex(value, context))
      problems.push(`blind ${label}`);
  }
  return problems;
}

it.each(ENTRIES)(
  '[BR-ID-33] %s 入口：经注入的 FIELD_CRYPTO 加密、解密、reencrypt、盲索引手机号、身份证号、收款账号与姓名之后，日志里没有这些明文',
  async (entry) => {
    const token = (await platformIndex())['FIELD_CRYPTO'];
    expect(typeof token).toBe('symbol');
    const { files, lines, started } = sharedEntry(entry, 'no-db');
    expect('value' in started ? 'started' : String(started.error)).toBe('started');
    if (!('value' in started)) return;
    const injected = settleSync(() => started.value.get(token) as FieldCrypto);
    const problems = 'value' in injected ? exercise(injected.value) : ['not provided'];
    expect(problems).toEqual([]);
    // The logger is the one the entry used: Nest wrote its start-up lines into it.
    expect(lines.length).toBeGreaterThan(0);
    expect(logLeaks(lines, secretsOf(files))).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);

// ---- what platform/index.ts exports -------------------------------------------------------------

it(
  '[BR-ID-33][ADR-0001 §2] platform/index.ts 导出 FIELD_CRYPTO 令牌（Symbol，描述为 FIELD_CRYPTO）',
  async () => {
    const index = await platformIndex();
    const token = index['FIELD_CRYPTO'];
    expect(typeof token).toBe('symbol');
    expect(typeof token === 'symbol' ? token.description : token).toBe('FIELD_CRYPTO');
  },
  NEST_TIMEOUT_MS,
);

it(
  '[BR-ID-33] platform/index.ts 导出 crypto 的 FieldCryptoError 与 FIELD_CRYPTO_MESSAGES（同一个值）',
  async () => {
    const index = await platformIndex();
    expect({
      FieldCryptoError: index['FieldCryptoError'] === crypto.FieldCryptoError,
      FIELD_CRYPTO_MESSAGES: index['FIELD_CRYPTO_MESSAGES'] === crypto.FIELD_CRYPTO_MESSAGES,
    }).toEqual({ FieldCryptoError: true, FIELD_CRYPTO_MESSAGES: true });
  },
  NEST_TIMEOUT_MS,
);

it(
  '[规划/02 §6.2] platform/index.ts 导出 http 的全部运行时名字（同一个值）',
  async () => {
    const index = await platformIndex();
    const names = Object.keys(http).sort();
    expect(names).toEqual([
      'GovernanceError',
      'createGovernor',
      'createMemoryQuotaLimiter',
      'quotaShares',
      'systemScheduler',
      'unionPolicy',
    ]);
    const same = Object.fromEntries(
      names.map((name) => [name, index[name] === (http as Record<string, unknown>)[name]]),
    );
    expect(same).toEqual(Object.fromEntries(names.map((name) => [name, true])));
  },
  NEST_TIMEOUT_MS,
);

it(
  '[BR-ID-33][ADR-0001 §2] 打开与改写 keyring 的函数不出 platform 模块：index.ts 不导出它们',
  async () => {
    const index = await platformIndex();
    const forbidden = [
      'LocalKeyProvider',
      'createWrappedKeyring',
      'rotateDataKey',
      'openFieldCrypto',
      'openConfiguredFieldCrypto',
      'readKeyringConfig',
    ];
    // The module itself must load and export the token, or the absence below proves nothing.
    expect(typeof index['FIELD_CRYPTO']).toBe('symbol');
    expect(forbidden.filter((name) => Object.hasOwn(index, name))).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);
