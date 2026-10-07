// Shared helpers of the keyring wiring rule tests (规划/08 BR-ID-33; ADR-0001 §2 鉴权与密钥、配置校验;
// 规划/02 §12.3, §12.6; 规划/11 §8). Expected values are written out by hand from the contract in
// apps/api/src/modules/platform/config/keyring.ts and config/keyring-startup.ts, never taken from the
// implementation. Key bytes come from testKey() of ./kit.ts (derived by code, no literal), and the
// keyring documents are wrapped by the reference wrapper of ./kit.ts, so the tests know every
// plain key and can search every output for it.
// Files live in a fresh directory under <repo>/.tmp (git-ignored), never in /tmp or $TMPDIR.
//
// Entries are started through apps/api/src/bootstrap.ts and the token comes from
// apps/api/src/modules/platform/index.ts. Both carry NestJS decorators, which the `test` project
// cannot type-check, so they are loaded with a dynamic import of a computed URL (Vitest transforms
// them like the api package does) and typed here by hand.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { ConfigError } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  KeyringStartupError,
  type KeyringStartupErrorCode,
} from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import type { WrappedKeyring } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  BLIND_KEY_LABEL,
  SAMPLES,
  parseV1,
  referenceBlindIndex,
  referenceDecrypt,
  referenceEncrypt,
  referenceWrap,
  testKey,
} from './kit.ts';

export const ENTRIES = ['api', 'stream', 'admin', 'worker', 'payout'] as const;
export type Entry = (typeof ENTRIES)[number];
export const HTTP_ENTRY_NAMES: readonly Entry[] = ['api', 'stream', 'admin'];

export const APP_ENV_NAMES = ['local', 'test', 'staging', 'prod'] as const;
export type AppEnvName = (typeof APP_ENV_NAMES)[number];

/** The fixed message of every startup error code, copied from the contract (not imported). */
export const STARTUP_MESSAGES: Readonly<Record<KeyringStartupErrorCode, string>> = {
  local_in_cloud: 'the local key provider must not be used when APP_ENV is prod',
  kms_unavailable: 'the KMS key provider is not available',
  master_key_unreadable: 'the master key file cannot be read',
  master_key_invalid: 'the master key file must hold exactly 64 lowercase hex characters',
  keyring_unreadable: 'the keyring file cannot be read',
  keyring_invalid: 'the keyring file is not a valid keyring for this master key',
  unwrap_failed: 'the keyring does not open with this master key',
};

/** The keyring problems of loadConfig, copied from §3 of config/keyring.ts. */
export const PROBLEMS = {
  providerUnset: (appEnv: AppEnvName) => `FIELD_KEY_PROVIDER: must be set when APP_ENV=${appEnv}`,
  providerInvalid: 'FIELD_KEY_PROVIDER: must be local or kms',
  localInCloud: (appEnv: AppEnvName) =>
    `FIELD_KEY_PROVIDER: local must not be used when APP_ENV=${appEnv} (cloud keys come from KMS)`,
  kmsInLocal: (appEnv: AppEnvName) =>
    `FIELD_KEY_PROVIDER: kms must not be used when APP_ENV=${appEnv} (local and test never load real keys)`,
  keyringWithoutProvider: 'FIELD_KEYRING_FILE: must not be set without FIELD_KEY_PROVIDER',
  keyringUnset: 'FIELD_KEYRING_FILE: must be set when FIELD_KEY_PROVIDER is set',
  keyringRelative: 'FIELD_KEYRING_FILE: must be an absolute path',
  masterWithoutProvider: 'FIELD_MASTER_KEY_FILE: must not be set without FIELD_KEY_PROVIDER',
  masterUnset: 'FIELD_MASTER_KEY_FILE: must be set when FIELD_KEY_PROVIDER=local',
  masterRelative: 'FIELD_MASTER_KEY_FILE: must be an absolute path',
  masterWithKms: 'FIELD_MASTER_KEY_FILE: must not be set when FIELD_KEY_PROVIDER=kms',
} as const;

/** The variables of the contract. */
export const FIELD_VARS = [
  'FIELD_KEY_PROVIDER',
  'FIELD_KEYRING_FILE',
  'FIELD_MASTER_KEY_FILE',
] as const;

/** Labels of the test keys (testKey of ./kit.ts). */
export const MASTER_LABEL = 71;
export const OTHER_MASTER_LABEL = 72;
export const VERSIONS = [1, 2] as const;
export const CURRENT_VERSION = 2;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** A fresh directory under <repo>/.tmp; remove it with removeDir. */
export function makeDir(label: string): string {
  const base = join(REPO_ROOT, '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `spec-b1-01k-${label}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Master key file content: 64 lowercase hex characters and one line feed. */
export function masterText(label: number = MASTER_LABEL): string {
  return `${testKey(label).toString('hex')}\n`;
}

/**
 * A keyring document whose plain keys the tests know: data key of version v is testKey(v), the
 * blind-index key testKey(BLIND_KEY_LABEL), all wrapped by the reference LocalKeyProvider format
 * under the master key testKey(masterLabel) with AAD `keyId`.
 */
export function keyringDoc(
  options: {
    readonly masterLabel?: number;
    readonly keyId?: string;
    readonly versions?: readonly number[];
    readonly current?: number;
  } = {},
): WrappedKeyring {
  const master = testKey(options.masterLabel ?? MASTER_LABEL);
  const keyId = options.keyId ?? 'local';
  return {
    key_id: keyId,
    current_version: options.current ?? CURRENT_VERSION,
    data_keys: (options.versions ?? VERSIONS).map((version) => ({
      version,
      wrapped: referenceWrap(master, keyId, testKey(version)),
    })),
    blind_index_key: referenceWrap(master, keyId, testKey(BLIND_KEY_LABEL)),
  };
}

export interface LocalFiles {
  readonly dir: string;
  readonly masterFile: string;
  readonly keyringFile: string;
}

/** Writes a master key file and a keyring file (text or bytes as given) into `dir`. */
export function writeFiles(
  dir: string,
  contents: {
    readonly master?: string | Uint8Array;
    readonly keyring?: string | Uint8Array;
  } = {},
): LocalFiles {
  const masterFile = join(dir, 'master.hex');
  const keyringFile = join(dir, 'keyring.json');
  writeFileSync(masterFile, contents.master ?? masterText());
  writeFileSync(keyringFile, contents.keyring ?? `${JSON.stringify(keyringDoc())}\n`);
  return { dir, masterFile, keyringFile };
}

/** The variables of a working local keyring for loadConfig. */
export function localEnv(appEnv: AppEnvName, files: LocalFiles): Record<string, string> {
  return {
    APP_ENV: appEnv,
    LOG_LEVEL: 'silent',
    FIELD_KEY_PROVIDER: 'local',
    FIELD_KEYRING_FILE: files.keyringFile,
    FIELD_MASTER_KEY_FILE: files.masterFile,
  };
}

/**
 * Every secret a test of this directory could leak, for the leak search of kit.ts: the master
 * keys (text and bytes), the plain data and blind-index keys, a byte sample of the files, and the
 * directory (its unique name and full path).
 */
export function secretsOf(files: LocalFiles): Record<string, string | Uint8Array> {
  const dirName = files.dir.slice(files.dir.lastIndexOf('/') + 1);
  return {
    'master key (hex)': testKey(MASTER_LABEL).toString('hex'),
    'master key': testKey(MASTER_LABEL),
    'other master key': testKey(OTHER_MASTER_LABEL),
    'data key 1': testKey(1),
    'data key 2': testKey(2),
    'blind-index key': testKey(BLIND_KEY_LABEL),
    'temporary directory name': dirName,
    'temporary directory': files.dir,
    ...PLAINTEXT_SAMPLES,
  };
}

/**
 * The synthetic personal data the tests encrypt (BR-ID-33: phone number, id number, payout
 * account, payee name): none of it may show up in a log line, an error or a process output.
 */
export const PLAINTEXT_SAMPLES: Readonly<Record<string, string>> = {
  'phone number sample': SAMPLES.phone,
  'id number sample': SAMPLES.idNo,
  'alipay account sample': SAMPLES.alipay,
  'bank card sample': SAMPLES.bankCard,
  'payee name sample': SAMPLES.name,
};

/**
 * A working keyring document with one more property, `note`, whose string value holds a byte that
 * is not UTF-8 (0x80): only a strict UTF-8 decoder refuses it; a lenient one turns it into U+FFFD
 * and the document would open, since unused properties are ignored.
 */
export function notUtf8(): Buffer {
  const text = Buffer.from(JSON.stringify({ ...keyringDoc(), note: 'X' }), 'utf8');
  const at = text.indexOf('"note":"X"') + '"note":"'.length;
  const out = Buffer.from(text);
  out[at] = 0x80;
  return out;
}

/** The same document with a well-formed `note`: it opens (unused properties are ignored). */
export function withNote(): string {
  return JSON.stringify({ ...keyringDoc(), note: 'X' });
}

const ERROR_KEYS = new Set<PropertyKey>(['stack', 'message', 'name', 'code']);

/** One V8 stack frame, as in kit.ts (`at async` frames are missing under Vitest, both pass). */
const FRAME =
  /^ {4}at (?:async )?(?:.+ \()?(?:file:\/\/\S+:\d+:\d+|node:\S+:\d+:\d+|\/\S+:\d+:\d+|<anonymous>|native|index \d+)\)?$/;

/**
 * Why `error` is not exactly the contract's KeyringStartupError of `code`: an empty list when it
 * is a KeyringStartupError named 'KeyringStartupError' with that code, exactly the fixed message,
 * a stack that is that message followed by plain `at …` frames, and no property besides stack,
 * message, name and code (no `cause`).
 */
export function startupErrorProblems(error: unknown, code: KeyringStartupErrorCode): string[] {
  if (!(error instanceof KeyringStartupError)) {
    return [`not a KeyringStartupError: ${explain(error)}`];
  }
  const problems: string[] = [];
  if (error.name !== 'KeyringStartupError') problems.push('name');
  if (error.code !== code) problems.push(`code ${String(error.code)}`);
  if (error.message !== STARTUP_MESSAGES[code]) problems.push('message');
  const [first, ...frames] = (error.stack ?? '').split('\n');
  if (first !== `KeyringStartupError: ${STARTUP_MESSAGES[code]}`) problems.push('stack head');
  if (frames.length === 0 || frames.some((line) => !FRAME.test(line))) {
    problems.push('stack frames');
  }
  const extra = Reflect.ownKeys(error).filter((key) => !ERROR_KEYS.has(key));
  if (extra.length > 0) problems.push(`own properties ${extra.map(String).join(',')}`);
  if ('cause' in error) problems.push('cause');
  return problems;
}

function explain(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

/** What a promise did: `{ value }` when it resolved, `{ error }` when it rejected. */
export async function settle<T>(
  promise: Promise<T>,
): Promise<{ readonly value: T } | { readonly error: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

/** What a call did: `{ value }` when it returned, `{ error }` when it threw. */
export function settleSync<T>(run: () => T): { readonly value: T } | { readonly error: unknown } {
  try {
    return { value: run() };
  } catch (error) {
    return { error };
  }
}

/** The problems of the ConfigError thrown by `run`, or a description of what happened instead. */
export function configProblems(run: () => unknown): readonly string[] | string {
  const outcome = settleSync(run);
  if ('value' in outcome) return 'returned without a ConfigError';
  if (!(outcome.error instanceof ConfigError)) return `other error: ${explain(outcome.error)}`;
  return outcome.error.problems;
}

// ---- Nest entries -------------------------------------------------------------------------------

/** The part of a Nest application / application context the tests use. */
export interface StartedApp {
  get(token: unknown): unknown;
  close(): Promise<void>;
}

interface BootstrapModule {
  createHttpApp(entry: string, overrides: object): Promise<StartedApp>;
  createWorkerContext(entry: string, overrides: object): Promise<StartedApp>;
}

const BOOTSTRAP = '../../../../apps/api/src/bootstrap.ts';
const PLATFORM_INDEX = '../../../../apps/api/src/modules/platform/index.ts';

/** apps/api/src/modules/platform/index.ts, loaded without type-checking it. */
export async function platformIndex(): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ new URL(PLATFORM_INDEX, import.meta.url).href)) as Record<
    string,
    unknown
  >;
}

async function bootstrap(): Promise<BootstrapModule> {
  return (await import(
    /* @vite-ignore */ new URL(BOOTSTRAP, import.meta.url).href
  )) as BootstrapModule;
}

/**
 * Starts an entry the way the entry runner does (createHttpApp for api / stream / admin,
 * createWorkerContext for worker / payout), WITHOUT app.init() for HTTP entries.
 */
export async function startEntry(entry: Entry, overrides: object): Promise<StartedApp> {
  const boot = await bootstrap();
  return HTTP_ENTRY_NAMES.includes(entry)
    ? boot.createHttpApp(entry, overrides)
    : boot.createWorkerContext(entry, overrides);
}

/** Starts an entry and closes it again if it started; returns what happened. */
export async function startAndClose(
  entry: Entry,
  overrides: object,
): Promise<{ readonly started: true } | { readonly error: unknown }> {
  const outcome = await settle(startEntry(entry, overrides));
  if ('error' in outcome) return { error: outcome.error };
  await outcome.value.close();
  return { started: true };
}

/** A pino root logger at level trace that keeps every line in memory. */
export function memoryLogger(
  entry: Entry,
  appEnv: string,
): { logger: RootLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry, appEnv },
    {
      write(line: string): void {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}

const CREDENTIAL_LIKE =
  /^(?:UNION|ALIPAY|BANK|SMS)_(?:[A-Z0-9]+_)*(?:SECRET|PRIVATE_KEY|ACCESS_KEY)$/i;

/**
 * Makes process.env hold exactly the given values for the variables loadConfig reads (all others
 * of them unset, credential-looking names of the developer's shell included). Undo with
 * vi.unstubAllEnvs().
 */
export function stubProcessEnv(values: Readonly<Record<string, string>>): void {
  const names = [
    'APP_ENV',
    'LOG_LEVEL',
    'CLOCK_NOW',
    'COULI_EXIT_AFTER_INIT',
    'API_HOST',
    'API_PORT',
    'STREAM_PORT',
    'ADMIN_PORT',
    ...FIELD_VARS,
    ...Object.keys(process.env).filter((name) => CREDENTIAL_LIKE.test(name)),
  ];
  for (const name of names) vi.stubEnv(name, values[name]);
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

// ---- the FieldCrypto contract, checked from outside ------------------------------------------

/** The keyrings of these tests: versions held and the current one. */
export const KEYRINGS = [
  { versions: [1, 2], current: 2 },
  { versions: [1, 2], current: 1 },
  { versions: [1, 2, 3], current: 2 },
] as const;

export const METHODS = [
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
export function cipherProblems(
  value: unknown,
  versions: readonly number[],
  current: number,
): string[] {
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
