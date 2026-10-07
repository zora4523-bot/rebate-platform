// Account creation core (BR-ID-04, BR-ID-05 细则「同设备注册上限的计数」, BR-INV-01, BR-INV-06,
// BR-INV-14, BR-ATTR-06; 04 §3.2 users, device_registrations): no route. Reused by SMS login
// (B1-02j), third-party first login (B1-02d) and the landing-page sign-up (B1-11), each in its own
// transaction, which it passes in and commits.
//
// register(trx, command), in order:
//   1. the command is checked (a caller bug throws a TypeError before anything is written); an app
//      method (sms, wechat, apple, huawei) without device_hash is let through with a warning;
//   2. SAVEPOINT: the whole creation runs after it, and every answer but 0 rolls back to it, so the
//      caller's own writes before and after stay intact and it may commit or roll back safely;
//   3. configuration through the identity configuration port, the 08 default when a key is missing
//      or malformed (malformed also logs a warning): level.default (L1) and, on a device,
//      risk.merge_tombstone_dedupe (on) and risk.device_register_limit (3). The port is
//      command.config when the caller gives one (a snapshot read before its transaction with
//      snapshotRegistrationConfig, so nothing inside the transaction borrows a second pooled
//      connection), otherwise options.config;
//   4. on a device (device_hash given; the landing page has none and skips 4–5): the caller's
//      transaction must be READ COMMITTED (a snapshot level throws, answered 50001); a transaction
//      lock on (app_id, device_hash); a phone already held by an account not deleted answers
//      { outcome: 'phone_taken' } here, before any limit (an existing account logging in on the
//      device is not affected, BR-ID-05); then the count of the device's registration records
//      with created_at > Clock − 30×24 h (countDeviceRegistrations);
//   5. count ≥ limit: the release port of B1-03d (one-time pass after a granted appeal, BR-ID-36
//      结案; default: no) — true goes on as usual, anything else answers 44001
//      device_register_limit with what B1-03d needs to record the hit;
//   6. the users row: id UUIDv7 from the Clock, phone ciphertext and blind index, default nickname
//      and avatar, level, register_method, registered_channel (X-Channel), an invite code (at most
//      5 candidates, each filtered by the sensitive words, then inserted after a savepoint; a hit
//      or a collision costs one) and an attr_code (at most 5 candidates). Either run out → 50001 and
//      a warning. A phone held by an account not deleted → { outcome: 'phone_taken' } (the caller
//      logs in instead);
//   7. on a device, the registration source record, created_at = the same Clock instant as the
//      window of step 4 (not the database's now());
//   8. the level-log port (BR-INV-14 source=register; default: nothing, the table does not exist);
//   9. a normalised, non-empty invite_code → the binding port after its own savepoint: anything but
//      bound (failed, a throw, a failed statement — also one the port caught itself, which makes
//      the RELEASE fail) rolls back to it only; the account stays. No port → { failed, 50001 };
//  10. the B1-03g port (same-IP registration count) once, before the caller commits; its failure
//      (a throw, or a failed statement that makes the RELEASE fail) is logged and rolled back to
//      its own savepoint, never answered.
// Any other error rolls back to the savepoint of step 2 and answers 50001 (logged as an error with
// its class and, for a database error, SQLSTATE, constraint and table — never its message or
// detail, which may quote a phone); when even that rollback fails, the error rejects.
//
// Nothing logged identifies the person: no phone in any form, no device hash or id, no IP, no
// invite code, no message of a port's error (only its class).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { DB } from '@couli/db';
import type { components, UserLevel } from '@couli/contracts-ts';
import type { Transaction } from 'kysely';
import { newUuidV7, type Clock, type FieldCrypto, type RootLogger } from '../../platform/index.ts';
import { isWellFormedDeviceHash } from '../domain/device.ts';
import { normalize_phone } from '../domain/normalize-phone.ts';
import {
  ATTR_CODE_CANDIDATES,
  DEFAULT_AVATAR,
  DEVICE_REGISTER_METHODS,
  DEFAULT_DEVICE_REGISTER_LIMIT,
  DEFAULT_LEVEL_KEY,
  DEFAULT_MERGE_TOMBSTONE_DEDUPE,
  DEFAULT_USER_LEVEL,
  DEVICE_REGISTER_LIMIT_KEY,
  DEVICE_REGISTER_WINDOW_MS,
  INVITE_CODE_CANDIDATES,
  MERGE_TOMBSTONE_DEDUPE_KEY,
  PHONE_BLIND_INDEX_CONTEXT,
  PHONE_CIPHER_CONTEXT,
  PHONE_REGISTER_METHODS,
  countDeviceRegistrations,
  createSensitiveWordMatcher,
  defaultNickname,
  isAttrCode,
  isInviteCode,
  isRegisterMethod,
  parseDefaultLevel,
  parseDeviceRegisterLimit,
  parseMergeTombstoneDedupe,
  type RegisterMethod,
} from '../domain/registration.ts';
import { loadInviteCodeSensitiveWords } from '../infra/invite-code-sensitive-words.ts';
import { newAttrCode, newInviteCode } from '../infra/registration-codes.ts';
import {
  deviceRegistrationsSince,
  insertDeviceRegistration,
  insertUser,
  lockDeviceRegistrations,
  phoneHeld,
  releaseSavepoint,
  rollbackToSavepoint,
  savepoint,
  transactionIsolation,
  type NewUser,
  type Savepoint,
} from '../infra/registration-store.ts';
import type { SmsConfigReader } from './sms-codes.ts';

export {
  countDeviceRegistrations,
  DEFAULT_AVATAR,
  PHONE_BLIND_INDEX_CONTEXT,
  PHONE_CIPHER_CONTEXT,
} from '../domain/registration.ts';
export type { DeviceRegistrationRecord, RegisterMethod } from '../domain/registration.ts';

export type InviteBindResult = components['schemas']['InviteBind'];
export interface RegistrationCommand {
  readonly app_id: string;
  // normalize_phone output: 11 digits without +86; third-party callers may pass null.
  readonly phone: string | null;
  // B1-02d supplies the third-party identity digest; SMS callers omit it or pass null.
  readonly third_party_digest?: string | null;
  readonly register_method: RegisterMethod;
  /** X-Channel of the request; absent → registered_channel NULL. */
  readonly channel?: string;
  /** From the caller's device row (the service reads no devices); absent on the landing page. */
  readonly device_hash?: string;
  /** For the binding port's same-device check (BR-INV-08); absent on the landing page. */
  readonly device_id?: string;
  /** Normalised by the caller (BR-INV-02); empty after normalisation means none was sent. */
  readonly invite_code?: string;
  readonly client_ip: string;
  /**
   * Per-call configuration port, in place of options.config: a caller that opens its own
   * transaction reads the keys beforehand (snapshotRegistrationConfig) and passes the snapshot,
   * so register() never borrows a second connection from the pool. Not passed on to the ports.
   */
  readonly config?: SmsConfigReader;
}
export interface DeviceLimitContext {
  readonly app_id: string;
  readonly device_hash: string;
  readonly count: number;
  readonly limit: number;
}
export type RegistrationResult =
  | {
      readonly code: 0;
      readonly user_id: string;
      readonly invite_code: string;
      readonly attr_code: string;
      readonly invite_bind?: InviteBindResult;
    }
  | ({ readonly code: 44001; readonly kind: 'device_register_limit' } & DeviceLimitContext)
  | { readonly code: 50001 }
  | { readonly outcome: 'phone_taken' };
export interface RegistrationService {
  // Non-success rolls back this service's writes, preserving the caller's earlier writes.
  register(trx: Transaction<DB>, command: RegistrationCommand): Promise<RegistrationResult>;
}
export interface SensitiveWords {
  matches(scene: 'invite_code', candidate: string): boolean;
}
export interface RegistrationOptions {
  readonly clock: Clock;
  readonly config: SmsConfigReader;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  readonly sensitiveWords: SensitiveWords;
  // Default sources use the CSPRNG (infra/registration-codes.ts). Invite: at most 5 draws; attr:
  // at most 5 candidates including the first; either running out answers 50001 with a warning.
  readonly inviteCandidate?: () => string;
  readonly attrCandidate?: () => string;
  // B1-11 implements it. Runs after its own savepoint; anything but bound rolls back to it.
  readonly bindInvite?: (
    trx: Transaction<DB>,
    input: RegistrationCommand & {
      readonly user_id: string;
      readonly invite_code: string;
    },
  ) => Promise<InviteBindResult>;
  // B1-03g: once on success, in the caller's transaction before commit.
  readonly afterRegistered?: (
    trx: Transaction<DB>,
    input: RegistrationCommand & {
      readonly user_id: string;
    },
  ) => Promise<void>;
  // B1-03d: default denies; ordered before returning the device-limit rejection. Its writes are
  // rolled back with the rest when the answer is 44001.
  readonly allowBlockedRegistration?: (
    trx: Transaction<DB>,
    // BR-ID-36 closure: bind the exception to the original device and phone/third-party subject.
    input: DeviceLimitContext & {
      readonly phone_hmac: string | null;
      readonly third_party_digest: string | null;
    },
  ) => Promise<boolean>;
  // TODO(规划/11 §2.3): BR-INV-14 same-transaction source=register log — blocked on level_change_logs table task.
  readonly recordInitialLevel?: (
    trx: Transaction<DB>,
    input: {
      readonly app_id: string;
      readonly user_id: string;
      readonly level: UserLevel;
      readonly source: 'register';
    },
  ) => Promise<void>;
}
export interface RegistrationConstants {
  readonly PHONE_BLIND_INDEX_CONTEXT: string;
  readonly PHONE_CIPHER_CONTEXT: string;
  readonly DEFAULT_AVATAR: string;
}

const CONSTANTS: RegistrationConstants = Object.freeze({
  PHONE_BLIND_INDEX_CONTEXT,
  PHONE_CIPHER_CONTEXT,
  DEFAULT_AVATAR,
});

export function registrationConstants(): RegistrationConstants {
  return CONSTANTS;
}

/**
 * The invite_code scene of the sensitive-word port backed by the seed list
 * specs/sensitive-words.invite-code.txt (case-insensitive substring match), until the BR-INV-01
 * word bank replaces it. Reads the list on each call; the call throws when the list is missing or
 * empty (nothing is read at import; the wiring task builds it once at start-up).
 */
export function createDefaultInviteCodeFilter(): SensitiveWords {
  const matches = createSensitiveWordMatcher(loadInviteCodeSensitiveWords());
  return Object.freeze({
    matches: (scene: 'invite_code', candidate: string): boolean =>
      scene === 'invite_code' && matches(candidate),
  });
}

const FAILED: RegistrationResult = Object.freeze({ code: 50001 });
const BIND_FAILURE_CODES: ReadonlySet<unknown> = new Set([30401, 30403, 30408, 42901, 50001]);
const BIND_INTERNAL_ERROR: InviteBindResult = Object.freeze({ result: 'failed', code: 50001 });

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return error === null ? 'null' : typeof error;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/**
 * Loggable facts of an error: its class and, for a database error (node-postgres DatabaseError),
 * the SQLSTATE and the constraint and table names. Never the message, detail, where or hint: those
 * may quote the row (a phone, a code).
 */
export function errorFields(error: unknown): {
  readonly error_class: string;
  readonly sqlstate?: string;
  readonly constraint?: string;
  readonly table?: string;
} {
  const fields: { error_class: string; sqlstate?: string; constraint?: string; table?: string } = {
    error_class: errorClass(error),
  };
  if (typeof error !== 'object' || error === null) return fields;
  const { code, constraint, table } = error as {
    code?: unknown;
    constraint?: unknown;
    table?: unknown;
  };
  if (typeof code === 'string' && SQLSTATE.test(code)) fields.sqlstate = code;
  if (typeof constraint === 'string' && IDENTIFIER.test(constraint)) fields.constraint = constraint;
  if (typeof table === 'string' && IDENTIFIER.test(table)) fields.table = table;
  return fields;
}

/** Snapshot isolation levels under which the count after the device lock could miss a commit. */
const SNAPSHOT_ISOLATION: ReadonlySet<string> = new Set(['repeatable read', 'serializable']);

export class RegistrationIsolationError extends Error {
  constructor(isolation: string) {
    super(`registration: a device registration needs read committed, not ${isolation}`);
    this.name = 'RegistrationIsolationError';
  }
}

/** The binding port's answer in the contract's shape, or null when it is not one. */
export function bindResultOf(value: unknown): InviteBindResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const { result, code } = value as { result?: unknown; code?: unknown };
  if (result === 'failed') {
    return BIND_FAILURE_CODES.has(code) ? { result, code: code as InviteBindResult['code'] } : null;
  }
  if ((result === 'bound' || result === 'ignored_existing_user') && (code ?? null) === null) {
    return { result, code: null };
  }
  return null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Every configuration key register() reads (step 3); a snapshot must cover all of them. */
export const REGISTRATION_CONFIG_KEYS: readonly string[] = Object.freeze([
  DEFAULT_LEVEL_KEY,
  MERGE_TOMBSTONE_DEDUPE_KEY,
  DEVICE_REGISTER_LIMIT_KEY,
]);

/**
 * Reads REGISTRATION_CONFIG_KEYS of one app through `reader` now and answers a port that only
 * returns those values, never reading again. Another app or key is a caller bug and throws (a
 * key added to register() without the snapshot would otherwise silently read its default).
 */
export async function snapshotRegistrationConfig(
  reader: SmsConfigReader,
  appId: string,
): Promise<SmsConfigReader> {
  const values = new Map<string, Awaited<ReturnType<SmsConfigReader['configValue']>>>();
  for (const key of REGISTRATION_CONFIG_KEYS) {
    values.set(key, await reader.configValue(appId, key));
  }
  return Object.freeze({
    configValue(app: string, key: string) {
      const entry = values.get(key);
      if (app !== appId || entry === undefined) {
        return Promise.reject(new Error('registration: configuration read outside the snapshot'));
      }
      return Promise.resolve(entry);
    },
  });
}

/** Caller bugs, refused before any write. The phone must already be normalize_phone output. */
export function checkCommand(command: RegistrationCommand): void {
  if (typeof command.app_id !== 'string' || command.app_id.length === 0) {
    throw new TypeError('registration: app_id must be a non-empty string');
  }
  if (!isRegisterMethod(command.register_method)) {
    throw new TypeError('registration: unknown register_method');
  }
  const phone = command.phone;
  if (phone === null) {
    if (PHONE_REGISTER_METHODS.has(command.register_method)) {
      throw new TypeError('registration: this register_method needs a phone');
    }
  } else {
    const normalized = typeof phone === 'string' ? normalize_phone(phone) : null;
    if (normalized?.code !== 0 || normalized.phone !== phone) {
      throw new TypeError('registration: phone must be the output of normalize_phone');
    }
  }
  if (command.device_hash !== undefined && !isWellFormedDeviceHash(command.device_hash)) {
    throw new TypeError('registration: device_hash must be 64 lowercase hex characters');
  }
  const digest = command.third_party_digest;
  if (
    !optionalString(command.channel) ||
    !optionalString(command.device_id) ||
    !optionalString(command.invite_code) ||
    (digest !== undefined && digest !== null && typeof digest !== 'string') ||
    typeof command.client_ip !== 'string' ||
    (command.config !== undefined && typeof command.config.configValue !== 'function')
  ) {
    throw new TypeError('registration: malformed optional field');
  }
}

type CodesOutcome =
  | { readonly kind: 'inserted'; readonly inviteCode: string; readonly attrCode: string }
  | { readonly kind: 'exhausted'; readonly codeKind: 'invite_code' | 'attr_code' }
  | { readonly kind: 'phone_taken' };

export function createRegistrationService(options: RegistrationOptions): RegistrationService {
  const { clock, config, crypto, logger, sensitiveWords } = options;
  const inviteCandidate = options.inviteCandidate ?? newInviteCode;
  const attrCandidate = options.attrCandidate ?? newAttrCode;

  async function configured<T>(
    config: SmsConfigReader,
    appId: string,
    key: string,
    parse: (value: unknown) => T | null,
    fallback: T,
  ): Promise<T> {
    const entry = await config.configValue(appId, key);
    if (entry === null) return fallback;
    const value = parse(entry.value);
    if (value !== null) return value;
    logger.warn(
      { app_id: appId, config_key: key, config_version: entry.version },
      'registration_config_invalid',
    );
    return fallback;
  }

  /** Rolls back to the savepoint; when that fails too, the original error is what rejects. */
  async function undo(trx: Transaction<DB>, name: Savepoint, error: unknown): Promise<void> {
    try {
      await rollbackToSavepoint(trx, name);
    } catch {
      throw error;
    }
  }

  /** The users row with its invite code and attr_code (BR-INV-01, BR-ATTR-06). */
  async function insertWithCodes(
    trx: Transaction<DB>,
    row: Omit<NewUser, 'inviteCode' | 'attrCode'>,
  ): Promise<CodesOutcome> {
    let inviteDraws = 0;
    let attrDraws = 0;
    let inviteCode: string | null = null;
    let attrCode: string | null = null;
    for (;;) {
      if (inviteCode === null) {
        if (inviteDraws >= INVITE_CODE_CANDIDATES) {
          return { kind: 'exhausted', codeKind: 'invite_code' };
        }
        inviteDraws++;
        const candidate = inviteCandidate();
        if (!isInviteCode(candidate)) {
          throw new TypeError('registration: malformed invite code candidate');
        }
        // A sensitive hit costs one candidate, like a collision.
        if (sensitiveWords.matches('invite_code', candidate)) continue;
        inviteCode = candidate;
      }
      if (attrCode === null) {
        if (attrDraws >= ATTR_CODE_CANDIDATES) return { kind: 'exhausted', codeKind: 'attr_code' };
        attrDraws++;
        const candidate = attrCandidate();
        if (!isAttrCode(candidate)) {
          throw new TypeError('registration: malformed attr_code candidate');
        }
        attrCode = candidate;
      }
      const outcome = await insertUser(trx, { ...row, inviteCode, attrCode });
      if (outcome === 'inserted') return { kind: 'inserted', inviteCode, attrCode };
      if (outcome === 'phone_taken') return { kind: 'phone_taken' };
      // Only the candidate that collided is drawn again.
      if (outcome === 'invite_code_taken') inviteCode = null;
      else attrCode = null;
    }
  }

  async function bind(
    trx: Transaction<DB>,
    input: RegistrationCommand & { readonly user_id: string; readonly invite_code: string },
  ): Promise<InviteBindResult> {
    const fields = { app_id: input.app_id, register_method: input.register_method };
    const port = options.bindInvite;
    if (port === undefined) {
      logger.warn(fields, 'registration_invite_bind_unavailable');
      return BIND_INTERNAL_ERROR;
    }
    await savepoint(trx, 'identity_registration_invite_bind');
    let answer: unknown;
    try {
      answer = await port(trx, input);
    } catch (error) {
      await undo(trx, 'identity_registration_invite_bind', error);
      logger.warn({ ...fields, ...errorFields(error) }, 'registration_invite_bind_failed');
      return BIND_INTERNAL_ERROR;
    }
    const result = bindResultOf(answer);
    if (result?.result === 'bound') {
      try {
        await releaseSavepoint(trx, 'identity_registration_invite_bind');
      } catch (error) {
        // The port caught a failed statement of its own: the transaction is aborted and RELEASE
        // fails. Its writes are undone like any other failure of the port.
        await undo(trx, 'identity_registration_invite_bind', error);
        logger.warn({ ...fields, ...errorFields(error) }, 'registration_invite_bind_failed');
        return BIND_INTERNAL_ERROR;
      }
      return result;
    }
    await rollbackToSavepoint(trx, 'identity_registration_invite_bind');
    if (result === null) {
      logger.warn(fields, 'registration_invite_bind_invalid');
      return BIND_INTERNAL_ERROR;
    }
    logger.info(
      { ...fields, bind_result: result.result, bind_code: result.code },
      'registration_invite_bind_refused',
    );
    return result;
  }

  async function afterRegistered(
    trx: Transaction<DB>,
    input: RegistrationCommand & { readonly user_id: string },
  ): Promise<void> {
    const port = options.afterRegistered;
    if (port === undefined) return;
    await savepoint(trx, 'identity_registration_after');
    try {
      await port(trx, input);
      // Fails when the port caught a failed statement of its own (the transaction is aborted).
      await releaseSavepoint(trx, 'identity_registration_after');
    } catch (error) {
      await undo(trx, 'identity_registration_after', error);
      logger.error(
        { app_id: input.app_id, ...errorFields(error) },
        'registration_after_registered_failed',
      );
    }
  }

  /** Steps 3–10; runs after the registration savepoint. `command` carries no config. */
  async function create(
    trx: Transaction<DB>,
    command: RegistrationCommand,
    reader: SmsConfigReader,
  ): Promise<RegistrationResult> {
    const { app_id: appId, register_method: registerMethod } = command;
    const deviceHash = command.device_hash;
    const level = await configured(
      reader,
      appId,
      DEFAULT_LEVEL_KEY,
      parseDefaultLevel,
      DEFAULT_USER_LEVEL,
    );
    const phone = command.phone;
    const phoneHmac = phone === null ? null : crypto.blindIndex(phone, PHONE_BLIND_INDEX_CONTEXT);
    const now = clock.now();

    if (deviceHash !== undefined) {
      const dedupe = await configured(
        reader,
        appId,
        MERGE_TOMBSTONE_DEDUPE_KEY,
        parseMergeTombstoneDedupe,
        DEFAULT_MERGE_TOMBSTONE_DEDUPE,
      );
      const limit = await configured(
        reader,
        appId,
        DEVICE_REGISTER_LIMIT_KEY,
        parseDeviceRegisterLimit,
        DEFAULT_DEVICE_REGISTER_LIMIT,
      );
      // The count below sees registrations committed while it waited for the lock only when each
      // statement takes a fresh snapshot.
      const isolation = await transactionIsolation(trx);
      if (SNAPSHOT_ISOLATION.has(isolation)) throw new RegistrationIsolationError(isolation);
      // Lock, then count, then create (BR-ID-05 细则「并发」).
      await lockDeviceRegistrations(trx, appId, deviceHash);
      // An existing account is not affected by the limit (BR-ID-05): its phone answers
      // phone_taken (the caller logs it in) even on a device that is full.
      if (phoneHmac !== null && (await phoneHeld(trx, appId, phoneHmac))) {
        logger.info({ app_id: appId, register_method: registerMethod }, 'registration_phone_taken');
        return { outcome: 'phone_taken' };
      }
      const records = await deviceRegistrationsSince(
        trx,
        appId,
        deviceHash,
        now,
        DEVICE_REGISTER_WINDOW_MS,
      );
      const count = countDeviceRegistrations(
        records,
        { app_id: appId, device_hash: deviceHash },
        now,
        dedupe,
      );
      if (count >= limit) {
        const context: DeviceLimitContext = {
          app_id: appId,
          device_hash: deviceHash,
          count,
          limit,
        };
        const allow = options.allowBlockedRegistration;
        const allowed =
          allow === undefined
            ? false
            : await allow(trx, {
                ...context,
                phone_hmac: phoneHmac,
                third_party_digest: command.third_party_digest ?? null,
              });
        if (allowed !== true) {
          logger.info(
            { app_id: appId, register_method: registerMethod, count, limit },
            'registration_device_limited',
          );
          return { code: 44001, kind: 'device_register_limit', ...context };
        }
        logger.info(
          { app_id: appId, register_method: registerMethod, count, limit },
          'registration_device_limit_released',
        );
      }
    }

    const userId = newUuidV7(now);
    const codes = await insertWithCodes(trx, {
      id: userId,
      appId,
      phoneCipher:
        phone === null ? null : Buffer.from(crypto.encrypt(phone, PHONE_CIPHER_CONTEXT), 'utf8'),
      phoneHmac,
      nickname: defaultNickname(userId),
      avatar: DEFAULT_AVATAR,
      level,
      registerMethod,
      registeredChannel: command.channel ?? null,
      now,
    });
    if (codes.kind === 'phone_taken') {
      logger.info({ app_id: appId, register_method: registerMethod }, 'registration_phone_taken');
      return { outcome: 'phone_taken' };
    }
    if (codes.kind === 'exhausted') {
      // Alert (BR-INV-01): the candidate budget ran out, the whole creation is rolled back.
      logger.warn(
        {
          app_id: appId,
          register_method: registerMethod,
          code_kind: codes.codeKind,
          candidates:
            codes.codeKind === 'invite_code' ? INVITE_CODE_CANDIDATES : ATTR_CODE_CANDIDATES,
        },
        'registration_codes_exhausted',
      );
      return FAILED;
    }

    if (deviceHash !== undefined) {
      // The same Clock instant the window was computed from (step 4), never the database's now().
      await insertDeviceRegistration(trx, {
        appId,
        deviceHash,
        userId,
        registerMethod,
        createdAt: now,
      });
    }
    await options.recordInitialLevel?.(trx, {
      app_id: appId,
      user_id: userId,
      level,
      source: 'register',
    });

    const inviteCode = command.invite_code;
    const inviteBind =
      inviteCode === undefined || inviteCode === ''
        ? undefined
        : await bind(trx, { ...command, user_id: userId, invite_code: inviteCode });
    await afterRegistered(trx, { ...command, user_id: userId });

    logger.info(
      { app_id: appId, register_method: registerMethod, user_id: userId },
      'registration_created',
    );
    return {
      code: 0,
      user_id: userId,
      invite_code: codes.inviteCode,
      attr_code: codes.attrCode,
      ...(inviteBind === undefined ? {} : { invite_bind: inviteBind }),
    };
  }

  return Object.freeze({
    async register(
      trx: Transaction<DB>,
      command: RegistrationCommand,
    ): Promise<RegistrationResult> {
      checkCommand(command);
      if (
        command.device_hash === undefined &&
        DEVICE_REGISTER_METHODS.has(command.register_method)
      ) {
        // An app sign-up without its device escapes the same-device limit (BR-ID-05); the callers
        // (B1-02j, B1-02d) take device_hash from the device row. Warned, not refused: the frozen
        // rule test of the six register methods creates sms / wechat / apple / huawei accounts
        // without a device; refusing waits for that test's revision.
        logger.warn(
          { app_id: command.app_id, register_method: command.register_method },
          'registration_device_hash_missing',
        );
      }
      await savepoint(trx, 'identity_registration');
      let result: RegistrationResult;
      try {
        const { config: perCall, ...plain } = command;
        result = await create(trx, plain, perCall ?? config);
      } catch (error) {
        await undo(trx, 'identity_registration', error);
        logger.error(
          {
            app_id: command.app_id,
            register_method: command.register_method,
            ...errorFields(error),
          },
          'registration_failed',
        );
        return FAILED;
      }
      if ('code' in result && result.code === 0) {
        await releaseSavepoint(trx, 'identity_registration');
      } else {
        await rollbackToSavepoint(trx, 'identity_registration');
      }
      return result;
    },
  });
}
