// Rule tests: every process entry opens the keyring while it starts and hands the opened
// FieldCrypto to the other modules through the token FIELD_CRYPTO (§4 of
// apps/api/src/modules/platform/config/keyring-startup.ts; 规划/08 BR-ID-33; ADR-0001 §2 鉴权与密钥、配置校验;
// 规划/02 §12.6; 规划/11 §8). Entries are started like the entry runner does — createHttpApp for
// api / stream / admin (never app.init(), so a failure must come from creating the providers),
// createWorkerContext for worker / payout — with an in-memory pino logger whose every line is
// searched for key material, the files' paths and their content. Top-level it() only.
import { rmSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  createDbHandles,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { KeyringStartupErrorCode } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import {
  BLIND_KEY_LABEL,
  SAMPLES,
  leaksIn,
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
  PROBLEMS,
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
} from './wiring-kit.ts';

// Starting Nest (and loading it the first time) is slow on CI runners, several times slower than
// on a workstation: an explicit timeout keeps the default 5 s from failing a correct entry.
const NEST_TIMEOUT_MS = 30_000;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});
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

/** Problems of the value injected for FIELD_CRYPTO: shape, keys of the test keyring. */
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

it.each(ENTRIES)(
  '[BR-ID-33][ADR-0001 §2] %s 入口带数据库句柄启动：注入的 FIELD_CRYPTO 是已打开的 FieldCrypto，启动后删改文件不影响，日志无密钥与路径',
  async (entry) => {
    const files = fresh(`ok-${entry}`);
    misleadingProcessEnv(files);
    const { logger, lines } = memoryLogger(entry, 'test');
    const config = loadConfig(localEnv('test', files));
    const started = await settle(
      startEntry(entry, { config, logger, dbHandles: dbHandlesFor(entry, logger) }),
    );
    // Opened while the entry was created: the files are no longer needed.
    rmSync(files.masterFile);
    writeFileSync(
      files.keyringFile,
      JSON.stringify(keyringDoc({ masterLabel: OTHER_MASTER_LABEL })),
    );
    const token = await fieldCryptoToken();
    expect(typeof token).toBe('symbol');
    expect('value' in started ? 'started' : started.error).toBe('started');
    if (!('value' in started)) return;
    const first = settleSync(() => started.value.get(token));
    const second = settleSync(() => started.value.get(token));
    await started.value.close();
    expect('value' in first ? injectedProblems(first.value) : [String(first.error)]).toEqual([]);
    expect('value' in first && 'value' in second && first.value === second.value).toBe(true);
    expect(logLeaks(lines, secretsOf(files))).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);

it.each(ENTRIES)(
  '[BR-ID-33][ADR-0001 §2] %s 入口不带数据库句柄时同样提供 FIELD_CRYPTO（与 dbHandles 无关）',
  async (entry) => {
    const files = fresh(`nodb-${entry}`);
    misleadingProcessEnv(files);
    const { logger } = memoryLogger(entry, 'staging');
    const config = loadConfig(localEnv('staging', files));
    const started = await settle(startEntry(entry, { config, logger }));
    const token = await fieldCryptoToken();
    expect(typeof token).toBe('symbol');
    expect('value' in started ? 'started' : started.error).toBe('started');
    if (!('value' in started)) return;
    const injected = settleSync(() => started.value.get(token));
    await started.value.close();
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
    make('hand-built prod config with the local provider', {}, 'local_in_prod', (files) => ({
      ...local(files),
      appEnv: 'prod',
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
    const results: Record<string, string[]> = {};
    for (const failure of failureCases(entry)) {
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
    expect(results).toEqual(Object.fromEntries(failureCases(entry).map((c) => [c.label, []])));
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
  '[ADR-0001 §2][规划/02 §12.6] %s 入口在 prod 选 local 提供者拒绝启动；staging 允许并注入可用的 FieldCrypto（经 loadConfig(process.env)）',
  async (entry) => {
    const files = fresh(`env-local-${entry}`);
    stubProcessEnv(localEnv('prod', files));
    const prod = await startAndClose(entry, { logger: memoryLogger(entry, 'prod').logger });
    expect(
      'error' in prod
        ? configProblems(() => {
            throw prod.error;
          })
        : 'started',
    ).toEqual([PROBLEMS.localInProd]);

    vi.unstubAllEnvs();
    stubProcessEnv(localEnv('staging', files));
    const { logger, lines } = memoryLogger(entry, 'staging');
    const staging = await settle(startEntry(entry, { logger }));
    const token = await fieldCryptoToken();
    expect('value' in staging ? 'started' : staging.error).toBe('started');
    if (!('value' in staging)) return;
    const injected = settleSync(() => staging.value.get(token));
    await staging.value.close();
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
