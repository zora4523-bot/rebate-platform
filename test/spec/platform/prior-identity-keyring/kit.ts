// Shared helpers of the prior identity keyring rule tests (B1-27e; 规划/08 BR-ID-25 细则「旧身份留存」:
// 「隔离存储用独立的数据密钥」; 规划/04 §3.2「实名更正旧身份」行; ADR-0001 §2 鉴权与密钥、配置校验;
// 规划/11 §8). The contract is the comment of
// apps/api/src/modules/platform/config/keyring-prior-identity.ts; every expected value here is
// written out by hand from it, never taken from the implementation. Key bytes come from testKey()
// of ../crypto/kit.ts (derived by code, no literal) and the keyring documents are wrapped by its
// reference wrapper, so the tests know every plain key and can search every output for it.
// The main keyring of these tests is the one of ../crypto/wiring-kit.ts: master key testKey(71),
// data keys testKey(1) and testKey(2) (current 2), blind-index key testKey(200). The prior identity
// keyring uses other labels: master key testKey(81), data key of version v testKey(300 + v),
// blind-index key testKey(310).
// Files live in a fresh directory under <repo>/.tmp (git-ignored), never in /tmp or $TMPDIR.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { vi } from 'vitest';
import {
  PriorIdentityKeyringError,
  type PriorIdentityKeyringErrorCode,
} from '../../../../apps/api/src/modules/platform/config/keyring-prior-identity.ts';
import {
  FieldCryptoError,
  type FieldCrypto,
  type WrappedKeyring,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  BLIND_KEY_LABEL,
  SAMPLES,
  parseV1,
  referenceBlindIndex,
  referenceDecrypt,
  referenceEncrypt,
  referenceWrap,
  shapeProblems,
  testKey,
} from '../crypto/kit.ts';
import {
  MASTER_LABEL,
  METHODS,
  OTHER_MASTER_LABEL,
  PLAINTEXT_SAMPLES,
  keyringDoc,
  masterText,
  settleSync,
  stubProcessEnv,
  type AppEnvName,
} from '../crypto/wiring-kit.ts';

/** The variables of the contract (§1). */
export const PRIOR_VARS = [
  'PRIOR_IDENTITY_KEY_PROVIDER',
  'PRIOR_IDENTITY_KEYRING_FILE',
  'PRIOR_IDENTITY_MASTER_KEY_FILE',
] as const;

/** The prior identity problems of loadConfig, copied from §3 of the contract. */
export const PRIOR_PROBLEMS = {
  providerUnset: (appEnv: AppEnvName) =>
    `PRIOR_IDENTITY_KEY_PROVIDER: must be set when APP_ENV=${appEnv}`,
  providerInvalid: 'PRIOR_IDENTITY_KEY_PROVIDER: must be local or kms',
  localInCloud: (appEnv: AppEnvName) =>
    `PRIOR_IDENTITY_KEY_PROVIDER: local must not be used when APP_ENV=${appEnv} (cloud keys come from KMS)`,
  kmsInLocal: (appEnv: AppEnvName) =>
    `PRIOR_IDENTITY_KEY_PROVIDER: kms must not be used when APP_ENV=${appEnv} (local and test never load real keys)`,
  keyringWithoutProvider:
    'PRIOR_IDENTITY_KEYRING_FILE: must not be set without PRIOR_IDENTITY_KEY_PROVIDER',
  keyringUnset: 'PRIOR_IDENTITY_KEYRING_FILE: must be set when PRIOR_IDENTITY_KEY_PROVIDER is set',
  keyringRelative: 'PRIOR_IDENTITY_KEYRING_FILE: must be an absolute path',
  keyringSameAsField:
    'PRIOR_IDENTITY_KEYRING_FILE: must not be the same file as FIELD_KEYRING_FILE',
  masterWithoutProvider:
    'PRIOR_IDENTITY_MASTER_KEY_FILE: must not be set without PRIOR_IDENTITY_KEY_PROVIDER',
  masterUnset: 'PRIOR_IDENTITY_MASTER_KEY_FILE: must be set when PRIOR_IDENTITY_KEY_PROVIDER=local',
  masterRelative: 'PRIOR_IDENTITY_MASTER_KEY_FILE: must be an absolute path',
  masterWithKms:
    'PRIOR_IDENTITY_MASTER_KEY_FILE: must not be set when PRIOR_IDENTITY_KEY_PROVIDER=kms',
} as const;

/** The fixed message of every error code, copied from §4 of the contract (not imported). */
export const PRIOR_MESSAGES: Readonly<Record<PriorIdentityKeyringErrorCode, string>> = {
  not_configured: 'the prior identity keyring must be configured when APP_ENV is staging or prod',
  local_in_cloud:
    'the local key provider must not be used for the prior identity keyring when APP_ENV is prod',
  kms_unavailable: 'the KMS key provider is not available for the prior identity keyring',
  master_key_unreadable: 'the prior identity master key file cannot be read',
  master_key_invalid:
    'the prior identity master key file must hold exactly 64 lowercase hex characters',
  keyring_unreadable: 'the prior identity keyring file cannot be read',
  keyring_invalid: 'the prior identity keyring file is not a valid keyring for this master key',
  unwrap_failed: 'the prior identity keyring does not open with this master key',
  main_keyring_unavailable:
    'the field keyring cannot be read to compare it with the prior identity keyring',
  shares_main_data_key: 'the prior identity keyring shares a data key with the field keyring',
};

/** Largest keyring file accepted (./keyring-startup.ts KEYRING_FILE_MAX_BYTES, copied): 1 MiB. */
export const KEYRING_LIMIT = 1_048_576;

/** Labels of the prior identity test keys (testKey of ../crypto/kit.ts). */
export const PRIOR_MASTER_LABEL = 81;
export const PRIOR_OTHER_MASTER_LABEL = 82;
export const PRIOR_BLIND_LABEL = 310;
export const PRIOR_VERSIONS = [1, 2] as const;
export const PRIOR_CURRENT = 2;

/** Label of the plain data key of `version` in the prior identity test keyrings. */
export function priorKeyLabel(version: number): number {
  return 300 + version;
}

/** A context of the prior identity store (prefix `prior_identity.`, §6) and one of the main store. */
export const PRIOR_CONTEXT = 'prior_identity.id_no';
export const MAIN_CONTEXT = 'users.id_no';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** A fresh directory under <repo>/.tmp; remove it with removeDir. */
export function makeDir(label: string): string {
  const base = join(REPO_ROOT, '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `spec-b1-27e-${label}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Master key file content: 64 lowercase hex characters and one line feed. */
export function priorMasterText(label: number = PRIOR_MASTER_LABEL): string {
  return `${testKey(label).toString('hex')}\n`;
}

/**
 * A prior identity keyring document whose plain keys the tests know: the data key of version v is
 * testKey(keyLabels[v] ?? priorKeyLabel(v)), the blind-index key testKey(blindLabel ??
 * PRIOR_BLIND_LABEL), all wrapped in the LocalKeyProvider format under testKey(masterLabel) with
 * AAD `keyId`.
 */
export function priorDoc(
  options: {
    readonly masterLabel?: number;
    readonly keyId?: string;
    readonly versions?: readonly number[];
    readonly current?: number;
    readonly keyLabels?: Readonly<Record<number, number>>;
    readonly blindLabel?: number;
  } = {},
): WrappedKeyring {
  const master = testKey(options.masterLabel ?? PRIOR_MASTER_LABEL);
  const keyId = options.keyId ?? 'local';
  return {
    key_id: keyId,
    current_version: options.current ?? PRIOR_CURRENT,
    data_keys: (options.versions ?? PRIOR_VERSIONS).map((version) => ({
      version,
      wrapped: referenceWrap(
        master,
        keyId,
        testKey(options.keyLabels?.[version] ?? priorKeyLabel(version)),
      ),
    })),
    blind_index_key: referenceWrap(master, keyId, testKey(options.blindLabel ?? PRIOR_BLIND_LABEL)),
  };
}

/** The files of one test: the prior identity keyring and the main (FIELD_*) keyring. */
export interface PriorFiles {
  readonly dir: string;
  readonly masterFile: string;
  readonly keyringFile: string;
  readonly fieldMasterFile: string;
  readonly fieldKeyringFile: string;
}

/**
 * Writes the four files into `dir` (text or bytes as given). Defaults: the prior identity master
 * key testKey(81) and priorDoc(); the main master key testKey(71) and keyringDoc() of
 * ../crypto/wiring-kit.ts (data keys testKey(1), testKey(2), current 2).
 */
export function writePriorFiles(
  dir: string,
  contents: {
    readonly master?: string | Uint8Array;
    readonly keyring?: string | Uint8Array;
    readonly fieldMaster?: string | Uint8Array;
    readonly fieldKeyring?: string | Uint8Array;
  } = {},
): PriorFiles {
  const files = {
    dir,
    masterFile: join(dir, 'prior-master.hex'),
    keyringFile: join(dir, 'prior-keyring.json'),
    fieldMasterFile: join(dir, 'field-master.hex'),
    fieldKeyringFile: join(dir, 'field-keyring.json'),
  };
  writeFileSync(files.masterFile, contents.master ?? priorMasterText());
  writeFileSync(files.keyringFile, contents.keyring ?? `${JSON.stringify(priorDoc())}\n`);
  writeFileSync(files.fieldMasterFile, contents.fieldMaster ?? masterText());
  writeFileSync(files.fieldKeyringFile, contents.fieldKeyring ?? JSON.stringify(keyringDoc()));
  return files;
}

export type LocalKeyringConfig = {
  readonly provider: 'local';
  readonly keyringFile: string;
  readonly masterKeyFile: string;
};

/** `AppConfig.priorIdentityKeyring` of the prior identity files. */
export function priorLocal(files: PriorFiles): LocalKeyringConfig {
  return { provider: 'local', keyringFile: files.keyringFile, masterKeyFile: files.masterFile };
}

/** `AppConfig.keyring` of the main files. */
export function fieldLocal(files: PriorFiles): LocalKeyringConfig {
  return {
    provider: 'local',
    keyringFile: files.fieldKeyringFile,
    masterKeyFile: files.fieldMasterFile,
  };
}

/** The variables of both local keyrings for loadConfig. */
export function bothEnv(appEnv: AppEnvName, files: PriorFiles): Record<string, string> {
  return {
    APP_ENV: appEnv,
    LOG_LEVEL: 'silent',
    FIELD_KEY_PROVIDER: 'local',
    FIELD_KEYRING_FILE: files.fieldKeyringFile,
    FIELD_MASTER_KEY_FILE: files.fieldMasterFile,
    PRIOR_IDENTITY_KEY_PROVIDER: 'local',
    PRIOR_IDENTITY_KEYRING_FILE: files.keyringFile,
    PRIOR_IDENTITY_MASTER_KEY_FILE: files.masterFile,
  };
}

/**
 * stubProcessEnv of ../crypto/wiring-kit.ts plus the three PRIOR_IDENTITY_* names (unset unless
 * given). Undo with vi.unstubAllEnvs().
 */
export function stubEnv(values: Readonly<Record<string, string>>): void {
  stubProcessEnv(values);
  for (const name of PRIOR_VARS) vi.stubEnv(name, values[name]);
}

/**
 * Every secret a test of this directory could leak: both master keys (text and bytes), every plain
 * data and blind-index key of both keyrings, the directory (its unique name and full path), and the
 * synthetic personal data.
 */
export function priorSecretsOf(files: PriorFiles): Record<string, string | Uint8Array> {
  const dirName = files.dir.slice(files.dir.lastIndexOf('/') + 1);
  return {
    'prior master key (hex)': testKey(PRIOR_MASTER_LABEL).toString('hex'),
    'prior master key': testKey(PRIOR_MASTER_LABEL),
    'other prior master key': testKey(PRIOR_OTHER_MASTER_LABEL),
    'prior data key 1': testKey(priorKeyLabel(1)),
    'prior data key 2': testKey(priorKeyLabel(2)),
    'prior data key 3': testKey(priorKeyLabel(3)),
    'prior blind-index key': testKey(PRIOR_BLIND_LABEL),
    'field master key (hex)': testKey(MASTER_LABEL).toString('hex'),
    'field master key': testKey(MASTER_LABEL),
    'other field master key': testKey(OTHER_MASTER_LABEL),
    'field data key 1': testKey(1),
    'field data key 2': testKey(2),
    'field blind-index key': testKey(BLIND_KEY_LABEL),
    'temporary directory name': dirName,
    'temporary directory': files.dir,
    ...PLAINTEXT_SAMPLES,
  };
}

/**
 * The key material of the second keyring only (the main keyring's is in secretsOf of
 * ../crypto/wiring-kit.ts): its master keys (text and bytes), every plain data key and the
 * blind-index key. None of it may show up in a log line or an error.
 */
export function priorKeySecrets(): Record<string, string | Uint8Array> {
  return {
    'prior master key (hex)': testKey(PRIOR_MASTER_LABEL).toString('hex'),
    'prior master key': testKey(PRIOR_MASTER_LABEL),
    'other prior master key (hex)': testKey(PRIOR_OTHER_MASTER_LABEL).toString('hex'),
    'other prior master key': testKey(PRIOR_OTHER_MASTER_LABEL),
    'prior data key 1': testKey(priorKeyLabel(1)),
    'prior data key 2': testKey(priorKeyLabel(2)),
    'prior data key 3': testKey(priorKeyLabel(3)),
    'prior blind-index key': testKey(PRIOR_BLIND_LABEL),
  };
}

const ERROR_KEYS = new Set<PropertyKey>(['stack', 'message', 'name', 'code']);

/** One V8 stack frame (as ../crypto/wiring-kit.ts). */
const FRAME =
  /^ {4}at (?:async )?(?:.+ \()?(?:file:\/\/\S+:\d+:\d+|node:\S+:\d+:\d+|\/\S+:\d+:\d+|<anonymous>|native|index \d+)\)?$/;

function explain(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

/**
 * Why `error` is not exactly the contract's PriorIdentityKeyringError of `code`: an empty list
 * when it is one, named 'PriorIdentityKeyringError', with that code, exactly the fixed message, a
 * stack that is that message followed by plain `at …` frames, and no property besides stack,
 * message, name and code (no `cause`).
 */
export function priorErrorProblems(error: unknown, code: PriorIdentityKeyringErrorCode): string[] {
  if (!(error instanceof PriorIdentityKeyringError)) {
    return [`not a PriorIdentityKeyringError: ${explain(error)}`];
  }
  const problems: string[] = [];
  if (error.name !== 'PriorIdentityKeyringError') problems.push('name');
  if (error.code !== code) problems.push(`code ${String(error.code)}`);
  if (error.message !== PRIOR_MESSAGES[code]) problems.push('message');
  const [first, ...frames] = (error.stack ?? '').split('\n');
  if (first !== `PriorIdentityKeyringError: ${PRIOR_MESSAGES[code]}`) problems.push('stack head');
  if (frames.length === 0 || frames.some((line) => !FRAME.test(line))) {
    problems.push('stack frames');
  }
  const extra = Reflect.ownKeys(error).filter((key) => !ERROR_KEYS.has(key));
  if (extra.length > 0) problems.push(`own properties ${extra.map(String).join(',')}`);
  if ('cause' in error) problems.push('cause');
  return problems;
}

/** True when `run` throws a FieldCryptoError (the cipher refused; it never returns wrong text). */
export function refuses(run: () => unknown): boolean {
  const outcome = settleSync(run);
  return 'error' in outcome && outcome.error instanceof FieldCryptoError;
}

function membersProblems(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [`not an object: ${String(value)}`];
  const members = Reflect.ownKeys(value).map(String).sort();
  if (JSON.stringify(members) !== JSON.stringify(METHODS)) return [`members ${members.join(',')}`];
  const record = value as Record<string, unknown>;
  const missing = METHODS.filter(
    (name) => name !== 'currentKeyVersion' && typeof record[name] !== 'function',
  );
  return missing.length > 0 ? [`not functions: ${missing.join(',')}`] : [];
}

/** Runs `check`; an exception becomes a problem instead of failing the test with it. */
function guarded(check: () => string[]): string[] {
  const outcome = settleSync(check);
  return 'value' in outcome ? outcome.value : [`threw ${explain(outcome.error)}`];
}

/**
 * Problems of a cipher opened from priorDoc({ versions, current }): the exact member set and
 * shape; its own ciphertexts carry `current` and decrypt with the reference under the plain key
 * of `current`; every held version decrypts and re-encrypts to `current`; the blind index is the
 * one of the prior blind-index key.
 */
export function priorCipherProblems(
  value: unknown,
  versions: readonly number[],
  current: number,
): string[] {
  const members = membersProblems(value);
  if (members.length > 0) return members;
  return guarded(() => {
    const fc = value as FieldCrypto;
    const problems = shapeProblems(fc, { fieldCrypto: current });
    const own = fc.encrypt(SAMPLES.idNo, PRIOR_CONTEXT);
    const parsed = settleSync(() => parseV1(own).version);
    if (!('value' in parsed) || parsed.value !== current) problems.push('own ciphertext version');
    if (fc.decrypt(own, PRIOR_CONTEXT) !== SAMPLES.idNo) problems.push('decrypt(own)');
    const byReference = settleSync(() =>
      referenceDecrypt(testKey(priorKeyLabel(current)), own, PRIOR_CONTEXT),
    );
    if (!('value' in byReference) || byReference.value !== SAMPLES.idNo) {
      problems.push('own ciphertext under the current prior data key');
    }
    for (const version of versions) {
      const old = referenceEncrypt(
        testKey(priorKeyLabel(version)),
        version,
        SAMPLES.name,
        PRIOR_CONTEXT,
      );
      if (fc.decrypt(old, PRIOR_CONTEXT) !== SAMPLES.name) problems.push(`decrypt v${version}`);
      if (fc.needsReencrypt(old) !== (version !== current)) {
        problems.push(`needsReencrypt v${version}`);
      }
      const again = fc.reencrypt(old, PRIOR_CONTEXT);
      if (fc.keyVersionOf(again) !== current) problems.push(`reencrypt v${version} version`);
      if (fc.decrypt(again, PRIOR_CONTEXT) !== SAMPLES.name) {
        problems.push(`reencrypt v${version} text`);
      }
    }
    if (
      fc.blindIndex(SAMPLES.idNo, PRIOR_CONTEXT) !==
      referenceBlindIndex(testKey(PRIOR_BLIND_LABEL), SAMPLES.idNo, PRIOR_CONTEXT)
    ) {
      problems.push('blindIndex');
    }
    return problems;
  });
}

/**
 * Problems of a cipher generated for local / test (§4 a): the exact member set and shape, current
 * version 1, its own ciphertexts carry version 1 and round-trip (decrypt, reencrypt), the blind
 * index is 64 lowercase hex characters and stable, and it holds none of the known test data keys
 * (a ciphertext under the main data key 1 or the prior data key 1 is refused).
 */
export function generatedCipherProblems(value: unknown): string[] {
  const members = membersProblems(value);
  if (members.length > 0) return members;
  return guarded(() => {
    const fc = value as FieldCrypto;
    const problems = shapeProblems(fc, { fieldCrypto: 1 });
    const own = fc.encrypt(SAMPLES.idNo, PRIOR_CONTEXT);
    const parsed = settleSync(() => parseV1(own).version);
    if (!('value' in parsed) || parsed.value !== 1) problems.push('own ciphertext version');
    if (fc.decrypt(own, PRIOR_CONTEXT) !== SAMPLES.idNo) problems.push('decrypt(own)');
    if (fc.needsReencrypt(own)) problems.push('needsReencrypt(own)');
    const again = fc.reencrypt(own, PRIOR_CONTEXT);
    if (again === own || fc.decrypt(again, PRIOR_CONTEXT) !== SAMPLES.idNo) {
      problems.push('reencrypt');
    }
    const blind = fc.blindIndex(SAMPLES.idNo, PRIOR_CONTEXT);
    if (!/^[0-9a-f]{64}$/.test(blind) || fc.blindIndex(SAMPLES.idNo, PRIOR_CONTEXT) !== blind) {
      problems.push('blindIndex');
    }
    for (const [label, key] of [
      ['field data key 1', testKey(1)],
      ['prior data key 1', testKey(priorKeyLabel(1))],
    ] as const) {
      const foreign = referenceEncrypt(key, 1, SAMPLES.idNo, PRIOR_CONTEXT);
      if (!refuses(() => fc.decrypt(foreign, PRIOR_CONTEXT))) problems.push(`holds ${label}`);
    }
    return problems;
  });
}

/**
 * Problems of keeping the two stores apart: the prior identity cipher is another object than the
 * main one, and a ciphertext written by either does not decrypt under the other (same context, so
 * only the data keys tell them apart).
 */
export function separationProblems(prior: unknown, main: unknown): string[] {
  const members = [...membersProblems(prior), ...membersProblems(main)];
  if (members.length > 0) return members;
  return guarded(() => {
    const problems: string[] = [];
    const priorCrypto = prior as FieldCrypto;
    const mainCrypto = main as FieldCrypto;
    if (prior === main) problems.push('the same object as FIELD_CRYPTO');
    for (const context of [MAIN_CONTEXT, PRIOR_CONTEXT]) {
      const fromMain = mainCrypto.encrypt(SAMPLES.idNo, context);
      if (!refuses(() => priorCrypto.decrypt(fromMain, context))) {
        problems.push(`main ciphertext opens under the prior cipher (${context})`);
      }
      const fromPrior = priorCrypto.encrypt(SAMPLES.idNo, context);
      if (!refuses(() => mainCrypto.decrypt(fromPrior, context))) {
        problems.push(`prior ciphertext opens under the main cipher (${context})`);
      }
    }
    return problems;
  });
}

// ---- Nest -----------------------------------------------------------------------------------

export interface NestFactoryLike {
  createApplicationContext(
    module: object,
    options: object,
  ): Promise<{ get(token: unknown, options?: object): unknown; close(): Promise<void> }>;
}

/** NestFactory of the very @nestjs/core that apps/api uses (the test project has no Nest). */
export async function nestFactory(): Promise<NestFactoryLike> {
  const apiDir = fileURLToPath(new URL('../../../../apps/api/', import.meta.url));
  const entry = realpathSync(join(apiDir, 'node_modules', '@nestjs', 'core', 'index.js'));
  const core = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as {
    NestFactory: NestFactoryLike;
  };
  return core.NestFactory;
}
