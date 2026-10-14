// First super-admin bootstrap (F1-06c; BR-ID-34 with its rule 「首次绑定身份验证器」, BR-ID-33 field
// encryption, 04 §3.2 admin_users / audit_logs). Run by the owner in a terminal through
// apps/api/scripts/admin-bootstrap.ts; there is no HTTP route.
//
// Flow of `run` (every refusal returns a nonzero exit code and leaves the database unchanged):
//   1. stdin/stdout must be a terminal; app id, login name and trusted options are checked.
//   2. Refuse when ANY super exists (any app, any status, bound or not) or the login name is
//      taken — before a password is read or a secret generated.
//   2a. When the terminal offers `readConfirmation`, echo the app id and login name and continue
//      only on `yes` (a mistyped app id would otherwise consume the one-time bootstrap).
//   3. Read the password (never echoed) and hash it with the injected production hash.
//   4. Generate the TOTP secret (refused under 20 bytes), encrypt it for this account's context,
//      show the otpauth URI exactly once through `terminal.showBinding` (never logged/written).
//   5. Read the dynamic code (up to MAX_CODE_ATTEMPTS, same secret); it is checked with the
//      F1-06b verifier against the injected Clock at input time. Wrong code / EOF writes nothing.
//   6. One transaction: global advisory lock (all bootstrap runs serialise on it), re-check «no
//      super anywhere», insert the bound super, consume the confirming step through the durable
//      replay store (admin_users.totp_last_step), append the audit row, commit. A second process
//      waiting on the lock sees the committed super on its re-check and refuses.
// No permissions, tokens or sessions are created. Nothing is printed except through the ports.
//
// Pure module (no decorators, erasable syntax, only type imports from the platform barrel):
// node can run it directly (the script and the concurrency rule test do).
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { AuditPort, Clock, FieldCrypto } from '../../platform/index.ts';
import {
  createTotpVerifier,
  totpSecretContext,
  TOTP_STEP_SECONDS,
  type TotpAccount,
  type TotpClaim,
} from '../domain/totp.ts';
import { createPgTotpReplayStore } from '../infra/totp-replay-pg.ts';

/** Terminal-only port. null means EOF/cancellation; passwords/codes must not be echoed. */
export interface BootstrapTerminal {
  readonly isTTY: boolean;
  /**
   * Echoed line input for confirming the target. When present, `run` shows the app id and the
   * login name and continues only on the answer `yes` (before a password is read or a secret is
   * generated); the CLI always provides it. null means EOF/cancellation.
   */
  readConfirmation?(question: string): Promise<string | null>;
  readPassword(): Promise<string | null>;
  readCode(): Promise<string | null>;
  /** The only permitted sink for the otpauth URI, called once per binding attempt. */
  showBinding(uri: string): void;
  write(message: string): void;
}

/** The CLI wires this port to pino; credentials must never reach any log level. */
export interface BootstrapLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface BootstrapDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: Pick<FieldCrypto, 'encrypt' | 'decrypt'>;
  /** CLI wires generateAdminTotpSecret; reject fewer than 20 bytes before disclosure. */
  readonly generateTotpSecret: () => Uint8Array;
  /** CLI supplies the domain UUIDv7 generator. */
  readonly newAdminId: () => string;
  /** CLI wires hashAdminPassword, shared with the future F1-06 login verifier. */
  readonly hashPassword: (password: string) => Promise<string>;
  /** Must bind the F1-06b audit writer to the account-creation transaction. */
  readonly audit: (transaction: Transaction<DB>) => AuditPort;
  readonly terminal: BootstrapTerminal;
  readonly logger: BootstrapLogger;
  /** Trusted configuration: schema/contracts deliberately leave admin status open. */
  readonly activeStatus: string;
  readonly issuer: string;
}

export interface BootstrapRequest {
  readonly appId: string;
  readonly loginName: string;
}

export interface BootstrapResult {
  /** 0 only after account + binding + audit commit; all refusals are nonzero. */
  readonly exitCode: number;
}

export interface AdminBootstrap {
  /**
   * No super anywhere in admin_users (including inactive/unbound/other-app supers).
   * Confirm the displayed secret using F1-06b TOTP before inserting any account/binding.
   * Account and audit commit atomically. A database lock/constraint arbitrates independent
   * processes, and the existence check must remain true at commit. No permissions or tokens.
   * Wrong code/EOF may terminate this attempt; a later attempt generates a fresh secret.
   * No filesystem writes, direct console/stdout logging, or returned credentials.
   */
  run(request: BootstrapRequest): Promise<BootstrapResult>;
}

/** Exit codes of `run` (and of the command-line script). */
export const BOOTSTRAP_EXIT = Object.freeze({
  ok: 0,
  /** Unexpected failure (database, encryption, hashing, terminal); nothing committed. */
  failed: 1,
  /** Not a terminal, invalid request or options, password not given / too short. */
  invalid: 2,
  /** A super already exists (checked before disclosure and again under the lock). */
  superExists: 3,
  /** Wrong / expired dynamic code or input ended; nothing committed. */
  notConfirmed: 4,
  /** The login name is already used by another account. */
  loginTaken: 5,
});

/** Wrong codes accepted per run before giving up (same secret); a new run makes a new secret. */
export const MAX_CODE_ATTEMPTS = 3;
/** Minimum password length (technical default of this task; BR-ID-34 fixes none). */
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;
/** Minimum TOTP secret size (RFC 4226 §4 R6 recommends 160 bits). */
export const MIN_TOTP_SECRET_BYTES = 20;
/** Audit action of a successful bootstrap. */
export const BOOTSTRAP_AUDIT_ACTION = 'admin.bootstrap_super';

// Fixed key of the transaction-level advisory lock taken by every bootstrap run ('coul', 0x6c).
const LOCK_KEY_HIGH = 0x636f756c;
const LOCK_KEY_LOW = 0x06c;

const APP_ID = /^[a-z][a-z0-9_]{0,31}$/;
const LOGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = '23505';

/** Thrown inside the transaction to roll it back with a definite exit code. */
class Refusal extends Error {
  readonly exitCode: number;
  readonly reason: string;
  constructor(exitCode: number, reason: string) {
    super(reason);
    this.name = 'Refusal';
    this.exitCode = exitCode;
    this.reason = reason;
  }
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Pure, directly Node-loadable entry point; no Nest or dist dependency. */
export function createAdminBootstrap(deps: BootstrapDeps): AdminBootstrap {
  const { db, clock, crypto, terminal, logger } = deps;
  if (typeof deps.activeStatus !== 'string' || deps.activeStatus.length === 0) {
    throw new Error('activeStatus must not be empty');
  }
  if (typeof deps.issuer !== 'string' || deps.issuer.length === 0 || deps.issuer.includes(':')) {
    throw new Error('issuer must be non-empty and must not contain a colon');
  }

  const refuse = (exitCode: number, reason: string, message: string): BootstrapResult => {
    logger.warn({ event: 'admin_bootstrap_refused', reason }, 'admin bootstrap refused');
    terminal.write(message);
    return { exitCode };
  };

  async function superExists(handle: Kysely<DB>): Promise<boolean> {
    const row = await handle
      .selectFrom('admin_users')
      .select('id')
      .where('is_super', '=', true)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function loginTaken(handle: Kysely<DB>, loginName: string): Promise<boolean> {
    const row = await handle
      .selectFrom('admin_users')
      .select('id')
      .where('login_name', '=', loginName)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function attempt(request: BootstrapRequest): Promise<BootstrapResult> {
    const { appId, loginName } = request;
    if (typeof appId !== 'string' || !APP_ID.test(appId)) {
      return refuse(BOOTSTRAP_EXIT.invalid, 'invalid_app_id', 'app_id 不合法。');
    }
    if (typeof loginName !== 'string' || !LOGIN_NAME.test(loginName)) {
      return refuse(
        BOOTSTRAP_EXIT.invalid,
        'invalid_login_name',
        '登录名只能用字母、数字和 . _ @ -，以字母或数字开头，最长 64 位。',
      );
    }
    if (terminal.isTTY !== true) {
      return refuse(BOOTSTRAP_EXIT.invalid, 'not_a_terminal', '只能在交互终端里运行。');
    }
    if (await superExists(db)) {
      return refuse(
        BOOTSTRAP_EXIT.superExists,
        'super_exists',
        '已有超级管理员，引导命令不再可用。',
      );
    }
    if (await loginTaken(db, loginName)) {
      return refuse(BOOTSTRAP_EXIT.loginTaken, 'login_taken', '该登录名已被占用。');
    }
    if (terminal.readConfirmation !== undefined) {
      const answer = await terminal.readConfirmation(
        `将为 app_id「${appId}」创建首个超级管理员，登录名「${loginName}」。确认无误请输入 yes：`,
      );
      if (typeof answer !== 'string' || answer.trim() !== 'yes') {
        return refuse(
          BOOTSTRAP_EXIT.invalid,
          'target_not_confirmed',
          '未确认 app_id 与登录名，已退出，未写入任何数据。',
        );
      }
    }

    const password = await terminal.readPassword();
    if (password === null) {
      return refuse(BOOTSTRAP_EXIT.invalid, 'password_missing', '未输入密码，已退出。');
    }
    if (
      typeof password !== 'string' ||
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      return refuse(
        BOOTSTRAP_EXIT.invalid,
        'password_length',
        `密码长度须为 ${String(MIN_PASSWORD_LENGTH)}–${String(MAX_PASSWORD_LENGTH)} 位。`,
      );
    }
    const passwordHash = await deps.hashPassword(password);

    const generated = deps.generateTotpSecret();
    if (!(generated instanceof Uint8Array) || generated.byteLength < MIN_TOTP_SECRET_BYTES) {
      return refuse(BOOTSTRAP_EXIT.failed, 'weak_secret', '身份验证器密钥生成失败，已退出。');
    }
    const rawId = deps.newAdminId();
    if (typeof rawId !== 'string' || !UUID.test(rawId)) {
      throw new Error('newAdminId must return a UUID');
    }
    const adminId = rawId.toLowerCase();
    const account: TotpAccount = { appId, adminId };
    const secret = Buffer.from(generated);
    let secretText: string;
    try {
      secretText = encodeBase32(secret);
    } finally {
      secret.fill(0);
    }
    const cipher = Buffer.from(crypto.encrypt(secretText, totpSecretContext(account)), 'utf8');

    terminal.showBinding(otpauthUri(deps.issuer, loginName, secretText));
    secretText = '';

    // Codes are checked against the clock at input time; the matched step is consumed durably
    // inside the transaction below, after the row exists.
    let matched: bigint | undefined;
    const capture = {
      consume(claim: TotpClaim): Promise<boolean> {
        matched = claim.timeStep;
        return Promise.resolve(true);
      },
    };
    const verifier = createTotpVerifier({ clock, crypto, replay: capture, digits: 6 });
    for (let tries = 0; matched === undefined; tries += 1) {
      if (tries >= MAX_CODE_ATTEMPTS) {
        return refuse(
          BOOTSTRAP_EXIT.notConfirmed,
          'code_attempts_exhausted',
          '动态码多次不正确，未创建账号。重新运行会生成新的密钥，请删除身份验证器里这次添加的条目。',
        );
      }
      const code = await terminal.readCode();
      if (code === null) {
        return refuse(BOOTSTRAP_EXIT.notConfirmed, 'code_missing', '未输入动态码，未创建账号。');
      }
      if (!(await verifier.verify({ ...account, secretCipher: cipher, code }))) {
        terminal.write('动态码不正确或已过期，请输入身份验证器上当前显示的 6 位数字。');
      }
    }
    const step = matched;

    try {
      await db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(${LOCK_KEY_HIGH}::int4, ${LOCK_KEY_LOW}::int4)`.execute(
          trx,
        );
        if (await superExists(trx)) {
          throw new Refusal(BOOTSTRAP_EXIT.superExists, 'super_exists');
        }
        const now = clock.now();
        await trx
          .insertInto('admin_users')
          .values({
            id: adminId,
            app_id: appId,
            login_name: loginName,
            password_hash: passwordHash,
            totp_secret_cipher: cipher,
            totp_bound_at: now,
            is_super: true,
            status: deps.activeStatus,
            created_at: now,
            updated_at: now,
          })
          .execute();
        // Durable replay protection: the confirming code cannot be used again after commit.
        const consumed = await createPgTotpReplayStore({ db: trx }).consume({
          ...account,
          timeStep: step,
        });
        if (!consumed) throw new Error('confirming code could not be consumed');
        await deps.audit(trx).append({
          appId,
          actor: adminId,
          action: BOOTSTRAP_AUDIT_ACTION,
          target: `admin_users:${adminId}`,
          before: null,
          after: {
            login_name: loginName,
            is_super: true,
            status: deps.activeStatus,
            totp_bound: true,
          },
          ip: null,
        });
      });
    } catch (error) {
      if (error instanceof Refusal && error.exitCode === BOOTSTRAP_EXIT.superExists) {
        return refuse(error.exitCode, error.reason, '已有超级管理员，引导命令不再可用。');
      }
      if (pgCode(error) === UNIQUE_VIOLATION) {
        return refuse(BOOTSTRAP_EXIT.loginTaken, 'login_taken', '该登录名已被占用，未创建账号。');
      }
      throw error;
    }
    logger.info({ event: 'admin_bootstrap_done', appId, adminId }, 'first super admin created');
    terminal.write(`超级管理员 ${loginName} 已创建并绑定身份验证器。`);
    return { exitCode: BOOTSTRAP_EXIT.ok };
  }

  return {
    async run(request: BootstrapRequest): Promise<BootstrapResult> {
      try {
        return await attempt(request);
      } catch (error) {
        // Never log the message: driver and crypto errors may quote values.
        logger.error(
          {
            event: 'admin_bootstrap_failed',
            error: error instanceof Error ? error.name : typeof error,
            code: pgCode(error),
          },
          'admin bootstrap failed',
        );
        terminal.write('引导失败，未创建账号。');
        return { exitCode: BOOTSTRAP_EXIT.failed };
      }
    },
  };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32, upper case, without padding (the form authenticator apps expect). */
export function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Key URI of the binding (Google Authenticator key-URI format; SHA1, 6 digits, 30 s). Also the
 * URI of the console's first binding (F1-06k).
 */
export function otpauthUri(issuer: string, loginName: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(loginName)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString().replace(/\+/g, '%20')}`;
}

// ---- Production password hash (shared with the future F1-06 login verifier) ----

const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_SALT_BYTES = 16;
// 128 * N * r = 128 MiB is needed; leave headroom.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SCRYPT_PREFIX = `scrypt$v=1$N=${String(SCRYPT_N)}$r=${String(SCRYPT_R)}$p=${String(SCRYPT_P)}$`;
const SCRYPT_FORMAT = /^scrypt\$v=1\$N=131072\$r=8\$p=1\$([0-9a-f]{32})\$([0-9a-f]{128})$/;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const options: ScryptOptions = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM };
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_BYTES, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * Production password format for bootstrap and future F1-06 login (technical choice;
 * neither ADR nor contracts prescribe an existing format):
 * scrypt$v=1$N=131072$r=8$p=1$<16-byte lowercase hex salt>$<64-byte lowercase hex key>.
 * Fresh cryptographic salt per call; Node scrypt maxmem must allow the chosen cost.
 * The CLI imports this function, never supplies a separate password implementation.
 */
export async function hashAdminPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await deriveKey(password, salt);
  return `${SCRYPT_PREFIX}${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Verify the versioned format above; wrong passwords and malformed hashes return false. */
export async function verifyAdminPassword(password: string, encodedHash: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  const parts = SCRYPT_FORMAT.exec(encodedHash);
  if (parts === null) return false;
  const expected = Buffer.from(parts[2]!, 'hex');
  const actual = await deriveKey(password, Buffer.from(parts[1]!, 'hex'));
  return timingSafeEqual(actual, expected);
}

/** Production CLI generator: fresh cryptographically random bytes, at least 20 per call. */
export function generateAdminTotpSecret(): Uint8Array {
  return new Uint8Array(randomBytes(MIN_TOTP_SECRET_BYTES));
}
