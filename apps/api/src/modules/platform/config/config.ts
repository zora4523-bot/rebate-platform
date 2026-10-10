// Environment configuration (ADR-0001 §2 配置校验): validated once at startup with zod.
// `loadConfig` is pure: it only looks at the object it is given.
import { z } from 'zod';
import { APP_ENVS, type AppEnv } from './app-env.ts';
import { readAdminAuthConfig, type AdminAuthConfig } from './admin-auth.ts';
import { findCredentialLikeEnvNames } from './credential-env.ts';
import { JWT_ENV_NAMES, readJwtKeyConfig, type JwtKeyConfig } from './jwt.ts';
import { readKeyringConfig, type KeyringConfig } from './keyring.ts';
import { readMediaConfig } from './media.ts';
import { readTrustedProxies } from './trusted-proxies.ts';

export { APP_ENVS, type AppEnv } from './app-env.ts';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const port = (fallback: number) =>
  z
    .string()
    .regex(/^\d{1,5}$/, 'must be a decimal port number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .default(fallback);

const envSchema = z.object({
  APP_ENV: z.enum(APP_ENVS),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // ISO-8601 instant with an explicit offset (`Z` or `+08:00`), see clockFromConfig.
  CLOCK_NOW: z.iso.datetime({ offset: true }).optional(),
  COULI_EXIT_AFTER_INIT: z.enum(['0', '1']).default('0'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: port(3100),
  STREAM_PORT: port(3101),
  ADMIN_PORT: port(3102),
});

type EnvKey = keyof z.input<typeof envSchema>;
const ENV_KEYS = Object.keys(envSchema.shape) as EnvKey[];

export interface AppConfig {
  /**
   * MEDIA_PUBLIC_BASE_URL (./media.ts, F1-06z): https base of stored media files. loadConfig gives
   * the local / test default when unset there; undefined in staging / prod when unset (media writes
   * and URLs then fail per request). A hand-built config without it counts as unset.
   */
  readonly mediaPublicBaseUrl?: string | undefined;
  readonly appEnv: AppEnv;
  readonly logLevel: LogLevel;
  /** Validated CLOCK_NOW text; parsed into an instant only inside platform/clock. */
  readonly clockNow: string | undefined;
  readonly exitAfterInit: boolean;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly streamPort: number;
  readonly adminPort: number;
  readonly keyring: KeyringConfig | null;
  /**
   * The access-token signing key of the api entry (./jwt.ts, B1-02h). Null when no JWT_* variable
   * is set: local / test then sign with an ephemeral key pair, staging / prod refuse to start
   * when identity's key provider is created. A hand-built config without it counts as null.
   */
  readonly jwt: JwtKeyConfig | null;
  /**
   * TRUSTED_PROXIES (./trusted-proxies.ts, B1-03m): addresses / ranges of the gateways whose
   * X-Forwarded-For entries every HTTP entry believes when deriving `request.ip`. Empty (unset)
   * trusts no forwarded header; a hand-built config without it counts as empty.
   */
  readonly trustedProxies?: readonly string[];
  /**
   * ADMIN_TOKEN_SIGNING_KEY / ADMIN_IP_ALLOWLIST / ADMIN_CORS_ORIGIN (./admin-auth.ts, F1-06k).
   * Null when none is set: local / test sign admin tokens with a per-process random key and allow
   * loopback sources only; staging / prod refuse to start the admin entry. A hand-built config
   * without it counts as null.
   */
  readonly adminAuth?: AdminAuthConfig | null;
}

/** Thrown by `loadConfig`; `problems` lists every finding. Messages never contain values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Invalid environment configuration:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Startup assertions that depend on the environment name (ADR-0001 §4.2 #10, 规划/11 §8). */
export function startupViolations(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const violations: string[] = [];
  if (appEnv === 'prod' && (env['CLOCK_NOW'] ?? '') !== '') {
    violations.push(
      'CLOCK_NOW: must not be set when APP_ENV=prod (the production clock is real time)',
    );
  }
  if (appEnv === 'local' || appEnv === 'test') {
    for (const name of findCredentialLikeEnvNames(env)) {
      violations.push(
        `${name}: looks like a real third-party credential; APP_ENV=${appEnv} only runs fake adapters, unset it`,
      );
    }
  }
  return violations;
}

/**
 * The JWT signing key part of loadConfig: its problems are merged only when at least one JWT_*
 * variable is set, so an environment without them keeps exactly its other problems; a missing
 * cloud key is refused at startup by identity's key provider (contract in ./jwt.ts).
 */
function readJwt(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly jwt: JwtKeyConfig | null; readonly problems: readonly string[] } {
  const result = readJwtKeyConfig(appEnv, env);
  const set = JWT_ENV_NAMES.some((name) => (env[name] ?? '') !== '');
  return set ? result : { jwt: null, problems: [] };
}

/**
 * Validates the environment and returns the typed configuration. Variables set to an empty
 * string count as unset. Throws one `ConfigError` listing every problem.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const input: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') input[key] = value;
  }

  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(environment)'}: ${issue.message}`,
    );
    // APP_ENV-dependent assertions still run when APP_ENV itself is valid.
    const appEnv = z.enum(APP_ENVS).safeParse(input['APP_ENV']);
    if (appEnv.success) {
      problems.push(...startupViolations(appEnv.data, env));
      problems.push(...readKeyringConfig(appEnv.data, env).problems);
      problems.push(...readJwt(appEnv.data, env).problems);
    }
    problems.push(...readTrustedProxies(env).problems);
    problems.push(...readAdminAuthConfig(appEnv.success ? appEnv.data : undefined, env).problems);
    problems.push(...readMediaConfig(appEnv.success ? appEnv.data : undefined, env).problems);
    throw new ConfigError(problems);
  }

  const values = parsed.data;
  const violations = startupViolations(values.APP_ENV, env);
  const { keyring, problems } = readKeyringConfig(values.APP_ENV, env);
  violations.push(...problems);
  const { jwt, problems: jwtProblems } = readJwt(values.APP_ENV, env);
  violations.push(...jwtProblems);
  const { trustedProxies, problems: proxyProblems } = readTrustedProxies(env);
  violations.push(...proxyProblems);
  const { adminAuth, problems: adminProblems } = readAdminAuthConfig(values.APP_ENV, env);
  violations.push(...adminProblems);
  const { mediaPublicBaseUrl, problems: mediaProblems } = readMediaConfig(values.APP_ENV, env);
  violations.push(...mediaProblems);
  if (violations.length > 0) throw new ConfigError(violations);

  return {
    appEnv: values.APP_ENV,
    logLevel: values.LOG_LEVEL,
    clockNow: values.CLOCK_NOW,
    exitAfterInit: values.COULI_EXIT_AFTER_INIT === '1',
    apiHost: values.API_HOST,
    apiPort: values.API_PORT,
    streamPort: values.STREAM_PORT,
    adminPort: values.ADMIN_PORT,
    keyring,
    jwt,
    trustedProxies,
    adminAuth,
    mediaPublicBaseUrl,
  };
}
