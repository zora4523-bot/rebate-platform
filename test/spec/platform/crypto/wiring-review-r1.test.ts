// Rule tests added after the first rule-test review of B1-01k (规划/08 BR-ID-33「密文带 key_version，
// 支持轮换」「日志…中不得出现明文」; ADR-0001 §2 鉴权与密钥; §4–§6 of
// apps/api/src/modules/platform/config/keyring-startup.ts):
// - the cipher handed out (by openConfiguredFieldCrypto and through FIELD_CRYPTO) writes the
//   keyring's current_version into its own ciphertexts and decrypts them, independently parsed;
// - it has exactly the six methods of the FieldCrypto contract and rotation works through it:
//   a version-1 ciphertext re-encrypts to the current version, plaintext and blind index unchanged;
// - FIELD_CRYPTO is exported by PlatformModule: a separate consumer module gets it by dependency
//   injection (not only through app.get);
// - openConfiguredFieldCrypto prints nothing: run in a plain node process (wiring-child.ts) over
//   files holding a synthetic phone number, id number and key marker, stdout is exactly the
//   child's reply and stderr is empty.
// Top-level it() only (规划/11 §4.3).
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { openConfiguredFieldCrypto } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { clockFromConfig } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  BLIND_KEY_LABEL,
  SAMPLES,
  leaksIn,
  parseV1,
  referenceBlindIndex,
  referenceDecrypt,
  referenceEncrypt,
  testKey,
} from './kit.ts';
import type { WiringChildReply, WiringChildRequest } from './wiring-child.ts';
import {
  ENTRIES,
  keyringDoc,
  localEnv,
  makeDir,
  memoryLogger,
  platformIndex,
  removeDir,
  secretsOf,
  settle,
  settleSync,
  startEntry,
  writeFiles,
  type LocalFiles,
} from './wiring-kit.ts';

// Starting Nest (and loading it the first time) is slow on CI runners: explicit timeout.
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

function local(files: LocalFiles) {
  return {
    provider: 'local',
    keyringFile: files.keyringFile,
    masterKeyFile: files.masterFile,
  } as const;
}

/** The keyrings of these tests: versions held and the current one. */
const KEYRINGS = [
  { versions: [1, 2], current: 2 },
  { versions: [1, 2], current: 1 },
  { versions: [1, 2, 3], current: 2 },
] as const;

const METHODS = [
  'blindIndex',
  'currentKeyVersion',
  'decrypt',
  'encrypt',
  'keyVersionOf',
  'needsReencrypt',
  'reencrypt',
];

/**
 * Everything the FieldCrypto contract promises, checked against independent references: the
 * exact member set; its own ciphertexts carry `current` (parsed here) and decrypt with it and
 * with the reference; every held version decrypts; a ciphertext of another version needs
 * re-encryption and re-encrypts to `current`, same plaintext, same blind index.
 */
function cipherProblems(value: unknown, versions: readonly number[], current: number): string[] {
  if (value === null || typeof value !== 'object') return [`not an object: ${String(value)}`];
  const members = Reflect.ownKeys(value).map(String).sort();
  if (JSON.stringify(members) !== JSON.stringify(METHODS)) return [`members ${members.join(',')}`];
  const record = value as Record<string, unknown>;
  const missing = METHODS.filter(
    (name) => name !== 'currentKeyVersion' && typeof record[name] !== 'function',
  );
  if (missing.length > 0) return [`not functions: ${missing.join(',')}`];
  const fc = value as FieldCrypto;
  const problems: string[] = [];
  const context = 'users.id_no';
  if (fc.currentKeyVersion !== current) problems.push(`currentKeyVersion ${fc.currentKeyVersion}`);
  const own = fc.encrypt(SAMPLES.idNo, context);
  const parsed = settleSync(() => parseV1(own).version);
  if (!('value' in parsed) || parsed.value !== current) problems.push('own ciphertext version');
  if (fc.keyVersionOf(own) !== current) problems.push('keyVersionOf(own)');
  if (fc.needsReencrypt(own)) problems.push('needsReencrypt(own)');
  if (fc.decrypt(own, context) !== SAMPLES.idNo) problems.push('decrypt(own)');
  const byReference = settleSync(() => referenceDecrypt(testKey(current), own, context));
  if (!('value' in byReference) || byReference.value !== SAMPLES.idNo) {
    problems.push('own ciphertext under the current key');
  }
  const blind = referenceBlindIndex(testKey(BLIND_KEY_LABEL), SAMPLES.idNo, context);
  if (fc.blindIndex(SAMPLES.idNo, context) !== blind) problems.push('blindIndex');
  for (const version of versions) {
    const old = referenceEncrypt(testKey(version), version, SAMPLES.idNo, context);
    if (fc.decrypt(old, context) !== SAMPLES.idNo) problems.push(`decrypt v${version}`);
    if (fc.keyVersionOf(old) !== version) problems.push(`keyVersionOf v${version}`);
    if (fc.needsReencrypt(old) !== (version !== current))
      problems.push(`needsReencrypt v${version}`);
    const again = fc.reencrypt(old, context);
    const againVersion = settleSync(() => parseV1(again).version);
    if (!('value' in againVersion) || againVersion.value !== current) {
      problems.push(`reencrypt v${version} version`);
    }
    if (fc.decrypt(again, context) !== SAMPLES.idNo) problems.push(`reencrypt v${version} text`);
    const againByReference = settleSync(() => referenceDecrypt(testKey(current), again, context));
    if (!('value' in againByReference) || againByReference.value !== SAMPLES.idNo) {
      problems.push(`reencrypt v${version} under the current key`);
    }
    if (fc.blindIndex(SAMPLES.idNo, context) !== blind)
      problems.push(`blindIndex after v${version}`);
  }
  return problems;
}

it('[BR-ID-33][ADR-0001 §2] openConfiguredFieldCrypto 返回的密码器：自己的密文带 keyring 的 current_version，能解自己的密文，方法集合完整，轮换（reencrypt）后明文与盲索引不变', async () => {
  const seen: Record<string, string[]> = {};
  for (const ring of KEYRINGS) {
    const files = fresh('r1-open', {
      keyring: JSON.stringify(keyringDoc({ versions: ring.versions, current: ring.current })),
    });
    const outcome = await settle(openConfiguredFieldCrypto('test', local(files)));
    seen[`${ring.versions.join('+')}@${ring.current}`] =
      'value' in outcome
        ? cipherProblems(outcome.value, ring.versions, ring.current)
        : ['rejected'];
  }
  expect(seen).toEqual({ '1+2@2': [], '1+2@1': [], '1+2+3@2': [] });
});

it.each(ENTRIES)(
  '[BR-ID-33][ADR-0001 §2] %s 入口注入的 FIELD_CRYPTO：密文带 current_version、能解自己的密文、方法集合完整、经它轮换后明文与盲索引不变',
  async (entry) => {
    const token = (await platformIndex())['FIELD_CRYPTO'];
    expect(typeof token).toBe('symbol');
    const seen: Record<string, string[]> = {};
    for (const ring of KEYRINGS) {
      const files = fresh(`r1-entry-${entry}`, {
        keyring: JSON.stringify(keyringDoc({ versions: ring.versions, current: ring.current })),
      });
      const { logger, lines } = memoryLogger(entry, 'test');
      const started = await settle(
        startEntry(entry, { config: loadConfig(localEnv('test', files)), logger }),
      );
      const key = `${ring.versions.join('+')}@${ring.current}`;
      if (!('value' in started)) {
        seen[key] = ['did not start'];
        continue;
      }
      const injected = settleSync(() => started.value.get(token));
      seen[key] =
        'value' in injected
          ? cipherProblems(injected.value, ring.versions, ring.current)
          : ['not provided'];
      await started.value.close();
      // Every method above ran on the id number sample: no log line may carry it (BR-ID-33).
      const leaks = [...new Set(lines.flatMap((line) => leaksIn(line, secretsOf(files))))];
      seen[key] = [...(seen[key] ?? []), ...leaks.map((name) => `log leaks ${name}`)];
    }
    expect(seen).toEqual({ '1+2@2': [], '1+2@1': [], '1+2+3@2': [] });
  },
  NEST_TIMEOUT_MS,
);

// ---- a consumer module of another feature -------------------------------------------------------

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
    expect([...new Set(lines.flatMap((line) => leaksIn(line, secretsOf(files))))]).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);

// ---- nothing printed by the opener --------------------------------------------------------------

const CHILD = fileURLToPath(new URL('./wiring-child.ts', import.meta.url));

/** A key-looking marker derived by code (no literal): 64 hex characters. */
function keyMarker(): string {
  return testKey(97).toString('hex');
}

function runChild(request: WiringChildRequest): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly reply: WiringChildReply | string;
} {
  const run = spawnSync(process.execPath, [CHILD], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env['PATH'] ?? '' },
  });
  let reply: WiringChildReply | string;
  try {
    reply = JSON.parse(run.stdout) as WiringChildReply;
  } catch {
    reply = 'stdout is not one JSON reply';
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, reply };
}

it('[BR-ID-33] openConfiguredFieldCrypto 与 loadConfig 在独立进程里成功、失败都不打印任何东西：stdout 正好是回复、stderr 为空，文件里的手机号、身份证号与密钥标记哪里都找不到', () => {
  const marker = keyMarker();
  const planted = { phone: SAMPLES.phone, id_no: SAMPLES.idNo, marker };
  const withPlanted = JSON.stringify({ ...keyringDoc(), ...planted });
  const files = {
    ok: fresh('r1-child-ok', { keyring: withPlanted }),
    notKeyring: fresh('r1-child-not-keyring', { keyring: JSON.stringify(planted) }),
    notJson: fresh('r1-child-not-json', {
      keyring: `phone=${SAMPLES.phone} id=${SAMPLES.idNo} key=${marker}`,
    }),
    masterPhone: fresh('r1-child-master', { master: `${SAMPLES.phone}${SAMPLES.idNo}\n` }),
    masterMarkerUpper: fresh('r1-child-master-upper', { master: `${marker.toUpperCase()}\n` }),
    otherMaster: fresh('r1-child-other', {
      master: `${marker}\n`,
      keyring: withPlanted,
    }),
  };
  const request: WiringChildRequest = {
    open: [
      { appEnv: 'test', keyring: local(files.ok) },
      { appEnv: 'local', keyring: local(files.ok) },
      { appEnv: 'test', keyring: local(files.notKeyring) },
      { appEnv: 'test', keyring: local(files.notJson) },
      { appEnv: 'test', keyring: local(files.masterPhone) },
      { appEnv: 'test', keyring: local(files.masterMarkerUpper) },
      { appEnv: 'test', keyring: local(files.otherMaster) },
      { appEnv: 'test', keyring: { ...local(files.ok), keyringFile: `${files.ok.dir}/none.json` } },
      { appEnv: 'test', keyring: { ...local(files.ok), masterKeyFile: files.ok.dir } },
      { appEnv: 'prod', keyring: local(files.ok) },
      { appEnv: 'staging', keyring: { provider: 'kms', keyringFile: files.ok.keyringFile } },
    ],
    config: [
      {
        APP_ENV: 'prod',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_KEYRING_FILE: `/srv/${SAMPLES.phone}`,
        FIELD_MASTER_KEY_FILE: `/srv/${marker}`,
      },
      { APP_ENV: 'test', FIELD_KEY_PROVIDER: SAMPLES.idNo, FIELD_KEYRING_FILE: marker },
      { APP_ENV: 'test', FIELD_KEYRING_FILE: `/srv/${SAMPLES.idNo}` },
      localEnv('test', files.ok),
    ],
    plaintexts: [SAMPLES.phone, SAMPLES.idNo, marker],
  };
  const run = runChild(request);
  const opened = { opened: true, currentKeyVersion: 2, roundTrips: true, blindIndexStable: true };
  const refused = (code: string) => ({ code, exact: true });
  expect(run.reply).toEqual({
    open: [
      opened,
      opened,
      refused('keyring_invalid'),
      refused('keyring_invalid'),
      refused('master_key_invalid'),
      refused('master_key_invalid'),
      refused('unwrap_failed'),
      refused('keyring_unreadable'),
      refused('master_key_unreadable'),
      refused('local_in_cloud'),
      refused('kms_unavailable'),
    ],
    config: [1, 1, 1, -1],
  });
  expect({
    status: run.status,
    stderr: run.stderr,
    exact: run.stdout === JSON.stringify(run.reply),
  }).toEqual({
    status: 0,
    stderr: '',
    exact: true,
  });
  const secrets = {
    ...secretsOf(files.ok),
    phone: SAMPLES.phone,
    'id number': SAMPLES.idNo,
    'key marker': marker,
    'key marker bytes': testKey(97),
  };
  expect(leaksIn(`${run.stdout}\n${run.stderr}`, secrets)).toEqual([]);
});
