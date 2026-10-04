// Shared helpers of the B1-01n rule tests for the maintenance connection (contract in
// apps/api/src/modules/platform/db/maint.ts). Expected values are written out by hand from the
// contract, never taken from the implementation. Passwords are built by code from labels (see
// ./kit.ts): no credential literal appears here. Nothing here imports `@couli/db/testing`.
import { ConnectionUrl } from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  loadMaintConnectionConfig,
  type MaintConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/maint.ts';
import { configErrorOf, configErrorProblems, describeError, phraseOf } from './kit.ts';

export const MAINT_VAR = 'DATABASE_MAINT_URL';

/** The problems of section 1 of the contract, copied by hand. */
export const MAINT_PROBLEMS = {
  missing: 'DATABASE_MAINT_URL: must be set for the worker entry',
  malformed:
    'DATABASE_MAINT_URL: must be a postgres:// or postgresql:// URL with a user, a host and a database name',
  query:
    'DATABASE_MAINT_URL: query parameters may only be sslmode (disable, require, verify-ca or verify-full), sslrootcert (required by verify-ca, allowed with verify-full), options, password or sslpassword, each at most once and with a literal name',
  control: 'DATABASE_MAINT_URL: connection fields may not contain control characters',
  role: 'DATABASE_MAINT_URL: must connect as couli_maint',
  root: 'DATABASE_MAINT_URL: sslrootcert could not be read',
} as const;

export const APP_ENVS = ['local', 'test', 'staging', 'prod'] as const;
export type AppEnvName = (typeof APP_ENVS)[number];

/** A couli_maint URL (or of `role`) with the encoded password of `label`, to 127.0.0.1:1. */
export function maintUrlOf(label: string, role = 'couli_maint', query = ''): string {
  const pw = encodeURIComponent(phraseOf(`maint.${label}`));
  return `postgres://${role}:${pw}@127.0.0.1:1/couli${query === '' ? '' : `?${query}`}`;
}

/** The redacted form of maintUrlOf(…, role) (db/index.ts section 3). */
export function maintRedactedOf(role = 'couli_maint'): string {
  return `postgres://${role}:***@127.0.0.1:1/couli`;
}

/** Everything section 1 fixes about a returned config, as plain data. */
export function maintView(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== 'object') return `not an object: ${String(value)}`;
  const config = value as MaintConnectionConfig;
  const url: unknown = config.url;
  return {
    plain: Object.getPrototypeOf(config) === Object.prototype,
    frozen: Object.isFrozen(config),
    keys: Reflect.ownKeys(config).map(String).sort(),
    name: config.name,
    url:
      url instanceof ConnectionUrl
        ? { isConnectionUrl: true, redacted: url.redacted, reveal: url.reveal() }
        : `not a ConnectionUrl: ${String(url)}`,
    max: config.max,
    applicationName: config.applicationName,
    readOnly: config.readOnly,
  };
}

/** The view of the config the contract requires for the URL `value`. */
export function expectedMaint(reveal: string, redacted: string): unknown {
  return {
    plain: true,
    frozen: true,
    keys: ['applicationName', 'max', 'name', 'readOnly', 'url'],
    name: 'dbMaint',
    url: { isConnectionUrl: true, redacted, reveal },
    max: 1,
    applicationName: 'couli-worker-maint',
    readOnly: false,
  };
}

/** maintView of what loadMaintConnectionConfig returns, or how it failed. */
export function loadView(
  entry: Parameters<typeof loadMaintConnectionConfig>[0],
  env: Readonly<Record<string, string | undefined>>,
): unknown {
  try {
    return maintView(loadMaintConnectionConfig(entry, env));
  } catch (error) {
    return describeError(error);
  }
}

/** [] when `run` throws exactly a ConfigError with `problems`; what is wrong otherwise. */
export function problemsOrWhat(run: () => unknown, problems: readonly string[]): string[] {
  const error = configErrorOf(run);
  return typeof error === 'string' ? [error] : configErrorProblems(error, problems);
}

/**
 * [] when the worker's loader refuses DATABASE_MAINT_URL = `value` (undefined: not in env) under
 * APP_ENV = `appEnv` (undefined: not in env) with exactly `problem`.
 */
export function maintProblems(
  value: string | undefined,
  appEnv: string | undefined,
  problem: string,
): string[] {
  const env: Record<string, string | undefined> = {};
  if (appEnv !== undefined) env.APP_ENV = appEnv;
  if (value !== undefined) env[MAINT_VAR] = value;
  return problemsOrWhat(() => loadMaintConnectionConfig('worker', env), [problem]);
}
