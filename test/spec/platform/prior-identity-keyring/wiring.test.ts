// Rule tests that start the process entries with the second field keyring (B1-27e; 规划/08 BR-ID-25
// 细则「旧身份留存」:「隔离存储用独立的数据密钥」; 规划/04 §3.2「实名更正旧身份」行; ADR-0001 §2;
// 规划/11 §8; §5 of apps/api/src/modules/platform/config/keyring-prior-identity.ts): every entry
// opens it while it starts and hands it to the other modules through PRIOR_IDENTITY_FIELD_CRYPTO,
// apart from FIELD_CRYPTO; staging / prod without the group refuse to start (loadConfig), and a
// hand-built staging config without it gives no such token, so a module that injects it cannot be
// created; the second keyring's keys never reach a log line or an error; what platform/index.ts
// exports.
// Entries are started like the entry runner does (createHttpApp for api / stream / admin without
// app.init(), createWorkerContext for worker / payout), with an in-memory pino logger at level
// trace whose every line is searched for key material, the files' paths and the synthetic
// personal data. All Nest tests of this task are in this one file, so Nest is loaded once.
// Top-level it() only (规划/11 §4.3).
import { generateKeyPairSync } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { clockFromConfig } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  loadConfig,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { PriorIdentityKeyringErrorCode } from '../../../../apps/api/src/modules/platform/config/keyring-prior-identity.ts';
import { leaksIn, testKey } from '../crypto/kit.ts';
import {
  ENTRIES,
  OTHER_MASTER_LABEL,
  configProblems,
  keyringDoc,
  masterText,
  memoryLogger,
  platformIndex,
  settle,
  settleSync,
  startAndClose,
  startEntry,
  startupErrorProblems,
  type AppEnvName,
  type Entry,
  type StartedApp,
} from '../crypto/wiring-kit.ts';
import {
  PRIOR_MASTER_LABEL,
  PRIOR_OTHER_MASTER_LABEL,
  PRIOR_PROBLEMS,
  bothEnv,
  fieldLocal,
  generatedCipherProblems,
  makeDir,
  nestFactory,
  priorCipherProblems,
  priorDoc,
  priorErrorProblems,
  priorKeyLabel,
  priorKeySecrets,
  priorLocal,
  priorMasterText,
  priorSecretsOf,
  removeDir,
  separationProblems,
  stubEnv,
  writePriorFiles,
  type PriorFiles,
} from './kit.ts';

// Starting Nest (and loading it the first time) is slow on CI runners: an explicit timeout keeps
// the default 5 s from failing a correct entry.
const NEST_TIMEOUT_MS = 90_000;

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

function fresh(label: string, contents: Parameters<typeof writePriorFiles>[1] = {}): PriorFiles {
  const dir = makeDir(label);
  dirs.push(dir);
  return writePriorFiles(dir, contents);
}

function explain(value: unknown): string {
  return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

/** The variables of the main local keyring only (no prior identity group). */
function fieldEnv(appEnv: AppEnvName, files: PriorFiles): Record<string, string> {
  return {
    APP_ENV: appEnv,
    LOG_LEVEL: 'silent',
    FIELD_KEY_PROVIDER: 'local',
    FIELD_KEYRING_FILE: files.fieldKeyringFile,
    FIELD_MASTER_KEY_FILE: files.fieldMasterFile,
  };
}

/** B3-09j (D10-327): the synthetic AGENT_USER_HASH_KEY that prod environments of this file add. */
const PROD_AGENT_KEY = { AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-prior-wiring' };

/** Synthetic signing key: a staging api entry needs one to get as far as the keyrings. */
function stagingJwtEnv(): Record<string, string> {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    JWT_KEY_ID: 'b1-27e-staging-test',
    JWT_VERIFY_KEYS_JSON: '{}',
  };
}

/** process.env pointing somewhere else entirely: an entry that reads it instead of the config fails. */
function misleadingProcessEnv(files: PriorFiles): void {
  stubEnv({
    APP_ENV: 'prod',
    FIELD_KEY_PROVIDER: 'kms',
    FIELD_KEYRING_FILE: join(files.dir, 'process-env-field.json'),
    PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
    PRIOR_IDENTITY_KEYRING_FILE: join(files.dir, 'process-env-prior.json'),
  });
}

async function tokens(): Promise<{ readonly prior: unknown; readonly field: unknown }> {
  const index = await platformIndex();
  return { prior: index['PRIOR_IDENTITY_FIELD_CRYPTO'], field: index['FIELD_CRYPTO'] };
}

function logLeaks(lines: readonly string[], files: PriorFiles): string[] {
  const secrets = priorSecretsOf(files);
  return [...new Set(lines.flatMap((line) => leaksIn(line, secrets)))].map(
    (name) => `log leaks ${name}`,
  );
}

/** What one started entry injects: the problems of `check(prior, field)`, then it is closed. */
async function inspectStarted(
  started: { readonly value: StartedApp } | { readonly error: unknown },
  check: (app: StartedApp) => string[],
): Promise<string[]> {
  if (!('value' in started)) return [`did not start: ${explain(started.error)}`];
  try {
    return check(started.value);
  } finally {
    await started.value.close();
  }
}

it.each(ENTRIES)(
  '[AC-B1-27e#25][BR-ID-25][规划/11 §8] %s 入口在 local 与 test 没配这一组时注入生成的旧身份 FieldCrypto：每次注入同一个、不是 FIELD_CRYPTO、密文互相解不开；没有主密钥环时也注入；每次启动密钥都不同',
  async (entry) => {
    const { prior, field } = await tokens();
    expect(typeof prior).toBe('symbol');
    const files = fresh(`generated-${entry}`);
    const runs = [
      { label: 'local with the main keyring', appEnv: 'local', main: true },
      { label: 'test with the main keyring', appEnv: 'test', main: true },
      { label: 'test without the main keyring', appEnv: 'test', main: false },
    ] as const;
    const seen: Record<string, string[]> = {};
    const ciphers: unknown[] = [];
    for (const run of runs) {
      const config = loadConfig(
        run.main ? fieldEnv(run.appEnv, files) : { APP_ENV: run.appEnv, LOG_LEVEL: 'silent' },
      );
      const { logger, lines } = memoryLogger(entry, run.appEnv);
      const started = await settle(startEntry(entry, { config, logger }));
      seen[run.label] = await inspectStarted(started, (app) => {
        const first = settleSync(() => app.get(prior));
        const second = settleSync(() => app.get(prior));
        if (!('value' in first)) return ['PRIOR_IDENTITY_FIELD_CRYPTO not provided'];
        ciphers.push(first.value);
        const problems = generatedCipherProblems(first.value);
        if (!('value' in second) || second.value !== first.value) {
          problems.push('not the same object on every injection');
        }
        if (run.main) {
          const main = settleSync(() => app.get(field));
          problems.push(
            ...('value' in main
              ? separationProblems(first.value, main.value)
              : ['FIELD_CRYPTO not provided']),
          );
        }
        return [...problems, ...logLeaks(lines, files)];
      });
    }
    const [one, two] = ciphers;
    seen['two starts'] =
      one !== undefined && two !== undefined ? separationProblems(one, two) : ['not two ciphers'];
    expect(seen).toEqual({
      'local with the main keyring': [],
      'test with the main keyring': [],
      'test without the main keyring': [],
      'two starts': [],
    });
  },
  NEST_TIMEOUT_MS,
);

it.each(ENTRIES)(
  '[AC-B1-27e#26][BR-ID-25] %s 入口配了 local 组时注入这套密钥环的 FieldCrypto（只看 config，不读 process.env），启动后删改文件不影响，日志无密钥与路径',
  async (entry) => {
    const { prior, field } = await tokens();
    expect(typeof prior).toBe('symbol');
    const files = fresh(`configured-${entry}`, {
      keyring: JSON.stringify(priorDoc({ versions: [1, 2, 3], current: 2 })),
    });
    const config = loadConfig(bothEnv('test', files));
    misleadingProcessEnv(files);
    const { logger, lines } = memoryLogger(entry, 'test');
    const started = await settle(startEntry(entry, { config, logger }));
    if ('value' in started) {
      // Opened while the entry was created: the files are no longer needed.
      rmSync(files.masterFile);
      writeFileSync(
        files.keyringFile,
        JSON.stringify(priorDoc({ masterLabel: PRIOR_OTHER_MASTER_LABEL })),
      );
      rmSync(files.fieldKeyringFile);
    }
    const problems = await inspectStarted(started, (app) => {
      const injected = settleSync(() => app.get(prior));
      const main = settleSync(() => app.get(field));
      if (!('value' in injected)) return ['PRIOR_IDENTITY_FIELD_CRYPTO not provided'];
      if (!('value' in main)) return ['FIELD_CRYPTO not provided'];
      return [
        ...priorCipherProblems(injected.value, [1, 2, 3], 2),
        ...separationProblems(injected.value, main.value),
        ...logLeaks(lines, files),
      ];
    });
    expect(problems).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);

it.each(ENTRIES)(
  '[AC-B1-27e#27][BR-ID-25][ADR-0001 §2] %s 入口经 loadConfig(process.env)：staging 两组都配 local 时启动并分别注入；prod 选 local、test 选 kms 时拒绝启动',
  async (entry) => {
    const { prior, field } = await tokens();
    expect(typeof prior).toBe('symbol');
    const files = fresh(`process-env-${entry}`);
    stubEnv({ ...bothEnv('staging', files), ...stagingJwtEnv() });
    const { logger, lines } = memoryLogger(entry, 'staging');
    const staging = await inspectStarted(await settle(startEntry(entry, { logger })), (app) => {
      const injected = settleSync(() => app.get(prior));
      const main = settleSync(() => app.get(field));
      if (!('value' in injected)) return ['PRIOR_IDENTITY_FIELD_CRYPTO not provided'];
      if (!('value' in main)) return ['FIELD_CRYPTO not provided'];
      return [
        ...priorCipherProblems(injected.value, [1, 2], 2),
        ...separationProblems(injected.value, main.value),
        ...logLeaks(lines, files),
      ];
    });
    vi.unstubAllEnvs();
    const refused: Record<string, unknown> = {};
    for (const [label, env] of [
      [
        'prod local',
        {
          APP_ENV: 'prod',
          LOG_LEVEL: 'silent',
          FIELD_KEY_PROVIDER: 'kms',
          FIELD_KEYRING_FILE: files.fieldKeyringFile,
          PRIOR_IDENTITY_KEY_PROVIDER: 'local',
          PRIOR_IDENTITY_KEYRING_FILE: files.keyringFile,
          PRIOR_IDENTITY_MASTER_KEY_FILE: files.masterFile,
          ...PROD_AGENT_KEY,
        },
      ],
      [
        'test kms',
        {
          APP_ENV: 'test',
          LOG_LEVEL: 'silent',
          PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
          PRIOR_IDENTITY_KEYRING_FILE: files.keyringFile,
        },
      ],
    ] as const) {
      stubEnv(env);
      const outcome = await startAndClose(entry, {
        logger: memoryLogger(entry, env.APP_ENV).logger,
      });
      refused[label] =
        'error' in outcome
          ? configProblems(() => {
              throw outcome.error;
            })
          : 'started';
      vi.unstubAllEnvs();
    }
    expect({ staging, refused }).toEqual({
      staging: [],
      refused: {
        'prod local': [PRIOR_PROBLEMS.localInCloud('prod')],
        'test kms': [PRIOR_PROBLEMS.kmsInLocal('test')],
      },
    });
  },
  NEST_TIMEOUT_MS,
);

const CONSUMER = Symbol('B1_27E_CONSUMER');

/** Builds an application of PlatformModule and a module that injects `token`; what it got. */
async function startConsumer(
  entry: Entry,
  config: AppConfig,
  token: unknown,
): Promise<{ readonly value: unknown } | { readonly error: unknown }> {
  const index = await platformIndex();
  const platform = index['PlatformModule'] as { forRoot(options: object): object };
  const { logger } = memoryLogger(entry, config.appEnv);
  class ConsumerModule {}
  class ConsumerRoot {}
  const consumer = {
    module: ConsumerModule,
    providers: [{ provide: CONSUMER, inject: [token], useFactory: (fc: unknown) => ({ fc }) }],
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
  if (!('value' in app)) return { error: app.error };
  try {
    const view = settleSync(() => app.value.get(CONSUMER, { strict: false }) as { fc: unknown });
    return 'value' in view ? { value: view.value.fc } : { error: view.error };
  } finally {
    await app.value.close();
  }
}

it.each(ENTRIES)(
  '[AC-B1-27e#28][BR-ID-25][规划/02 §12.6] %s：经 loadConfig(process.env) 时 staging 与 prod 配了 FIELD_* 却没配这一组拒绝启动；手工构造的 staging 配置不带这一组（null 或没有这个属性）时照常启动但不提供 PRIOR_IDENTITY_FIELD_CRYPTO，注入它的模块建不起来；test 里同一个模块拿到生成的 FieldCrypto',
  async (entry) => {
    const { prior, field } = await tokens();
    expect(typeof prior).toBe('symbol');
    const files = fresh(`cloud-unset-${entry}`);
    const refused: Record<string, unknown> = {};
    for (const [appEnv, env] of [
      ['staging', { ...fieldEnv('staging', files), ...stagingJwtEnv() }],
      [
        'prod',
        {
          APP_ENV: 'prod',
          LOG_LEVEL: 'silent',
          FIELD_KEY_PROVIDER: 'kms',
          FIELD_KEYRING_FILE: files.fieldKeyringFile,
          ...PROD_AGENT_KEY,
        },
      ],
    ] as const) {
      stubEnv(env);
      const outcome = await startAndClose(entry, { logger: memoryLogger(entry, appEnv).logger });
      refused[appEnv] =
        'error' in outcome
          ? configProblems(() => {
              throw outcome.error;
            })
          : 'started';
      vi.unstubAllEnvs();
    }
    // A config built by hand (as the frozen tests of other modules do) counts as unset.
    const loaded = loadConfig({ ...bothEnv('staging', files), ...stagingJwtEnv() });
    const withNull: AppConfig = { ...loaded, ...{ priorIdentityKeyring: null } };
    const withoutProperty: AppConfig = { ...loaded };
    Reflect.deleteProperty(withoutProperty, 'priorIdentityKeyring');
    const handBuilt: Record<string, unknown> = {};
    for (const [label, config] of [
      ['null', withNull],
      ['no property', withoutProperty],
    ] as const) {
      const { logger } = memoryLogger(entry, 'staging');
      const entryView = await inspectStarted(
        await settle(startEntry(entry, { config, logger })),
        (app) => [
          'value' in settleSync(() => app.get(field)) ? 'FIELD_CRYPTO provided' : 'no FIELD_CRYPTO',
          'error' in settleSync(() => app.get(prior))
            ? 'no PRIOR_IDENTITY_FIELD_CRYPTO'
            : 'PRIOR_IDENTITY_FIELD_CRYPTO provided',
        ],
      );
      const consumer = await startConsumer(entry, config, prior);
      handBuilt[label] = {
        entry: entryView,
        consumer:
          'error' in consumer
            ? String(consumer.error).includes('PRIOR_IDENTITY_FIELD_CRYPTO')
              ? 'refused for the missing token'
              : `refused: ${explain(consumer.error)}`
            : 'created',
      };
    }
    const inTest = await startConsumer(entry, loadConfig(fieldEnv('test', files)), prior);
    const notProvided = {
      entry: ['FIELD_CRYPTO provided', 'no PRIOR_IDENTITY_FIELD_CRYPTO'],
      consumer: 'refused for the missing token',
    };
    expect({
      refused,
      handBuilt,
      test: 'value' in inTest ? generatedCipherProblems(inTest.value) : [explain(inTest.error)],
    }).toEqual({
      refused: {
        staging: [PRIOR_PROBLEMS.providerUnset('staging')],
        prod: [PRIOR_PROBLEMS.providerUnset('prod')],
      },
      handBuilt: { null: notProvided, 'no property': notProvided },
      test: [],
    });
  },
  NEST_TIMEOUT_MS,
);

/**
 * The failures of opening through the entries, each as the files and the config that cause it.
 * The configs are loadConfig's result for APP_ENV=test with both keyrings written out by hand, so
 * that a case can name files loadConfig would not accept or a hand-built staging config.
 */
function failureCases(entry: Entry): {
  readonly label: string;
  readonly files: PriorFiles;
  readonly config: object;
  readonly check: (error: unknown) => string[];
}[] {
  const make = (
    label: string,
    contents: Parameters<typeof writePriorFiles>[1],
    edit: (files: PriorFiles) => object,
    check: (error: unknown) => string[],
  ) => {
    const files = fresh(`fail-${entry}`, contents);
    const base = loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent', ...stagingJwtEnv() });
    const both = { keyring: fieldLocal(files), priorIdentityKeyring: priorLocal(files) };
    return { label, files, config: { ...base, ...both, ...edit(files) }, check };
  };
  const prior = (code: PriorIdentityKeyringErrorCode) => (error: unknown) =>
    priorErrorProblems(error, code);
  return [
    make(
      'prior master key file is /dev/null',
      {},
      (files) => ({ priorIdentityKeyring: { ...priorLocal(files), masterKeyFile: '/dev/null' } }),
      prior('master_key_unreadable'),
    ),
    make(
      'prior keyring not JSON',
      { keyring: 'not a keyring' },
      () => ({}),
      prior('keyring_invalid'),
    ),
    make(
      'prior keyring under another master key',
      { master: priorMasterText(PRIOR_OTHER_MASTER_LABEL) },
      () => ({}),
      prior('unwrap_failed'),
    ),
    make(
      'prior keyring is a copy of the main one',
      { master: masterText(), keyring: JSON.stringify(keyringDoc()) },
      () => ({}),
      prior('shares_main_data_key'),
    ),
    make(
      'hand-built staging config with a kms prior keyring',
      {},
      (files) => ({
        appEnv: 'staging',
        priorIdentityKeyring: { provider: 'kms', keyringFile: files.keyringFile },
      }),
      prior('kms_unavailable'),
    ),
    make(
      'main keyring fails first',
      { fieldMaster: masterText(OTHER_MASTER_LABEL), keyring: 'not a keyring' },
      () => ({}),
      (error) => startupErrorProblems(error, 'unwrap_failed'),
    ),
  ];
}

it.each(ENTRIES)(
  '[AC-B1-27e#29][BR-ID-25] %s 入口打开旧身份 keyring 失败时创建本身就失败，错误是确切的 PriorIdentityKeyringError；主密钥环先打开、它的错误在前；日志无密钥、路径与文件内容',
  async (entry) => {
    const cases = failureCases(entry);
    const results: Record<string, string[]> = {};
    for (const failure of cases) {
      misleadingProcessEnv(failure.files);
      const { logger, lines } = memoryLogger(entry, 'test');
      const outcome = await startAndClose(entry, { config: failure.config, logger });
      results[failure.label] = [
        ...('error' in outcome ? failure.check(outcome.error) : ['started']),
        ...logLeaks(lines, failure.files),
      ];
      vi.unstubAllEnvs();
    }
    expect(results).toEqual(Object.fromEntries(cases.map((c) => [c.label, []])));
  },
  NEST_TIMEOUT_MS,
);

it.each(ENTRIES)(
  '[AC-B1-27e#34][BR-ID-25][BR-ID-33] %s 入口：第二套密钥环的主密钥、数据密钥与盲索引密钥不进日志，也不进打开失败时的错误（含文件里写着这些密钥的情形）',
  async (entry) => {
    const priorHex = testKey(PRIOR_MASTER_LABEL).toString('hex');
    const dataKeyHex = testKey(priorKeyLabel(1)).toString('hex');
    const cases: {
      readonly label: string;
      readonly contents: Parameters<typeof writePriorFiles>[1];
      readonly code: PriorIdentityKeyringErrorCode | null;
    }[] = [
      { label: 'opened', contents: {}, code: null },
      {
        label: 'shares a data key with the main keyring',
        contents: { keyring: JSON.stringify(priorDoc({ keyLabels: { 1: 1 } })) },
        code: 'shares_main_data_key',
      },
      {
        label: 'another master key',
        contents: { master: priorMasterText(PRIOR_OTHER_MASTER_LABEL) },
        code: 'unwrap_failed',
      },
      {
        label: 'master key file in upper case',
        contents: { master: `${priorHex.toUpperCase()}\n` },
        code: 'master_key_invalid',
      },
      {
        label: 'keyring file holding a plain data key',
        contents: { keyring: `{"data_key":"${dataKeyHex}"` },
        code: 'keyring_invalid',
      },
    ];
    const secrets = priorKeySecrets();
    const results: Record<string, string[]> = {};
    for (const item of cases) {
      const files = fresh(`keys-${entry}`, item.contents);
      const config = loadConfig(bothEnv('test', files));
      const { logger, lines } = memoryLogger(entry, 'test');
      const outcome = await startAndClose(entry, { config, logger });
      const problems: string[] = [];
      if (item.code === null) {
        if ('error' in outcome) problems.push(`did not start: ${explain(outcome.error)}`);
      } else if ('error' in outcome) {
        problems.push(...priorErrorProblems(outcome.error, item.code));
        problems.push(...leaksIn(outcome.error, secrets).map((name) => `error leaks ${name}`));
      } else {
        problems.push('started');
      }
      const logged = [...new Set(lines.flatMap((line) => leaksIn(line, secrets)))];
      results[item.label] = [...problems, ...logged.map((name) => `log leaks ${name}`)];
    }
    expect(results).toEqual(Object.fromEntries(cases.map((c) => [c.label, []])));
  },
  NEST_TIMEOUT_MS,
);

it(
  '[AC-B1-27e#30][BR-ID-25] platform/index.ts 导出 PRIOR_IDENTITY_FIELD_CRYPTO（Symbol，描述同名，不是 FIELD_CRYPTO），不导出打开与读取它的函数和错误类',
  async () => {
    const index = await platformIndex();
    const token = index['PRIOR_IDENTITY_FIELD_CRYPTO'];
    expect(typeof token).toBe('symbol');
    expect(typeof token === 'symbol' ? token.description : token).toBe(
      'PRIOR_IDENTITY_FIELD_CRYPTO',
    );
    expect(token).not.toBe(index['FIELD_CRYPTO']);
    const forbidden = [
      'openPriorIdentityFieldCrypto',
      'readPriorIdentityKeyringConfig',
      'PriorIdentityKeyringError',
      'LocalKeyProvider',
      'openFieldCrypto',
      'openConfiguredFieldCrypto',
    ];
    expect(forbidden.filter((name) => Object.hasOwn(index, name))).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);
