// SMS codes (规划/08 BR-ID-05; 04 §6.1 POST /v1/auth/sms-codes): sending a code for login / bind /
// step_up, and «check and consume» for the endpoints that take one (B1-02j login, B1-02f step-up,
// B1-20 phone binding reuse verifyAndConsume and normalize_phone).
//
// send(), in the order of BR-ID-05 (signature ① and the token stages run before the controller):
//   1. normalize_phone → 20001 phone_invalid (no SMS, nothing counted);
//   2. prefix blocklist sms.blocked_prefixes of the request's app (08 default when the key is
//      missing or malformed) on the E.164 form → 44001, kind blocked_prefix (B1-03d records the
//      risk hit from this structured result);
//   3. insertion points, in order, each short-circuits: phoneBlocklist (44001, B1-03d) → captcha
//      (44003, B1-03g) → deviceQuota (42901, B1-03g). They get the request with the normalised
//      number, the device id and the client IP;
//   4. one atomic call reserves the per-phone quota (60 s / natural hour / natural day / rolling
//      24 h) and stores the new random code as the candidate of (app, phone, purpose)
//      (infra/sms-code-store.ts): a limit → 42901 with the latest release; a candidate equal to a
//      code the record still knows → another code is drawn (at most SMS_CODE_DRAWS, then 50001);
//      Redis unavailable → 42901, Retry-After 5, no SMS. From here the previous code is void;
//   5. the code goes to the sender port, bounded by sendTimeoutMs (a timeout is «unknown»):
//      - accepted or unknown (timeout, a thrown adapter error, any other answer): counted as sent
//        (ruling §9.5 #1) — the commit counts the send at the time the provider answered and puts
//        the candidate in force; it is retried once with the same token (idempotent, nothing is
//        resent). If it still fails, the reservation keeps counting at its reservation time and the
//        candidate stays the current code, so the answer is still 0. afterAccepted runs (B1-03g
//        counters; its failure is logged, never answered). resend_after_sec is the seconds until
//        the next send may go (≥ 60);
//      - rejected: the reservation and the candidate are dropped (nothing counted, the previous
//        code is in force again), the answer is 50001.
// verifyAndConsume(): see its comment.
//
// Nothing is logged that identifies the number or the code: no phone in any form, no code, no
// captcha_token, no device id or IP (BR-ID-33). Codes and keys are HMACs made by the injected
// `hmac` (production: the field-encryption blind index, the same in every process).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import { randomBytes, randomInt } from 'node:crypto';
import {
  RedisUnavailableError,
  type Clock,
  type RedisHandle,
  type RootLogger,
} from '../../platform/index.ts';
import { normalize_phone } from '../domain/normalize-phone.ts';
import {
  SMS_BLOCKED_PREFIXES_KEY,
  SMS_CODE_DIGITS,
  SMS_CODE_LIFETIME_SECONDS,
  SMS_DEFAULT_BLOCKED_PREFIXES,
  SMS_RESEND_INTERVAL_MS,
  SMS_UNAVAILABLE_RETRY_AFTER_SECONDS,
  isBlockedPrefix,
  parseBlockedPrefixes,
  secondsUntil,
} from '../domain/sms-limits.ts';
import { createSmsCodeStore, type ReserveOutcome, type SmsKeys } from '../infra/sms-code-store.ts';

export type SmsPurpose = 'login' | 'bind' | 'step_up';
export type SmsDelivery = 'accepted' | 'rejected' | 'unknown';
export interface SmsMessage {
  readonly app_id: string;
  readonly phone: string;
  readonly purpose: SmsPurpose;
  readonly code: string;
}
/**
 * Sender port (identity today; the real provider adapter moves to notification, ruling §9.3 #6):
 * accepted, definitely rejected, or outcome unknown. An adapter that fails before anything left
 * the process (a configuration error, a refused credential, a malformed request it builds) must
 * answer `rejected`: a thrown error, a timeout or any other answer counts as sent (`unknown`).
 */
export interface SmsSender {
  send(message: SmsMessage): Promise<SmsDelivery>;
}
export interface SmsRequest {
  readonly app_id: string;
  readonly phone: string;
  readonly purpose: SmsPurpose;
  readonly captcha_token?: string;
  readonly action?: string;
  /** The verified device of the request (stage ①), for the device limits of B1-03g. */
  readonly device_id?: string;
  /** The client IP Fastify reports, for the IP limits and captcha triggers of B1-03g. */
  readonly client_ip?: string;
}
export type SmsResult =
  | {
      readonly code: 0;
      readonly data: { readonly resend_after_sec: number; readonly expires_in_sec: number };
    }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly string[]; readonly reason: 'phone_invalid' };
    }
  | {
      readonly code: 44001;
      readonly kind: 'blocked_prefix' | 'phone_blocklist';
      readonly data?: { readonly risk_msg_code: string };
    }
  | { readonly code: 44003 }
  | { readonly code: 42901; readonly retryAfterSec: number }
  | { readonly code: 50001 };
/** The identity configuration port (content implements it; app.module assembles it). */
export interface SmsConfigReader {
  configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: unknown; readonly version: number } | null>;
}
/** Ordered seams for B1-03d/g, after normalisation/prefix checks and before phone quota. */
export interface SmsHooks {
  readonly phoneBlocklist?: (
    request: SmsRequest,
  ) => Promise<Extract<SmsResult, { code: 44001 }> | null>;
  readonly captcha?: (request: SmsRequest) => Promise<Extract<SmsResult, { code: 44003 }> | null>;
  readonly deviceQuota?: (
    request: SmsRequest,
  ) => Promise<Extract<SmsResult, { code: 42901 }> | null>;
  readonly afterAccepted?: (request: SmsRequest) => Promise<void>;
}
export interface SmsCodeOptions {
  readonly clock: Clock;
  readonly redis: RedisHandle;
  readonly sender: SmsSender;
  readonly config: SmsConfigReader;
  readonly logger: RootLogger;
  readonly hmac: (text: string) => string;
  readonly hooks?: SmsHooks;
  /**
   * Longest wait for the sender, in milliseconds (default SMS_SEND_TIMEOUT_MS); far below the
   * 60-second window, so a slow provider cannot let a second request for the phone through.
   */
  readonly sendTimeoutMs?: number;
}
export interface SmsCodeService {
  send(request: SmsRequest): Promise<SmsResult>;
  verifyAndConsume(
    request: Pick<SmsMessage, 'app_id' | 'phone' | 'purpose' | 'code'>,
  ): Promise<{ readonly code: 0 | 20002 | 20003 }>;
}

/** Default bound of one send (review round 1 S3-2). */
export const SMS_SEND_TIMEOUT_MS = 10_000;
/** Codes drawn before a run of collisions answers 50001 (review round 1). */
export const SMS_CODE_DRAWS = 8;
/** Commit attempts with the same token after the provider answered (the first and one retry). */
const COMMIT_ATTEMPTS = 2;

const CODE_FORMAT = /^[0-9]{6}$/;
const CODE_SPACE = 10 ** SMS_CODE_DIGITS;
const DELIVERIES: ReadonlySet<unknown> = new Set(['accepted', 'rejected', 'unknown']);
const TIMED_OUT = Symbol('timed out');

function newCode(): string {
  return String(randomInt(0, CODE_SPACE)).padStart(SMS_CODE_DIGITS, '0');
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return error === null ? 'null' : typeof error;
}

export function createSmsCodeService(options: SmsCodeOptions): SmsCodeService {
  const { clock, sender, config, logger } = options;
  const hooks = options.hooks ?? {};
  const sendTimeoutMs = options.sendTimeoutMs ?? SMS_SEND_TIMEOUT_MS;
  if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs < 1) {
    throw new TypeError('createSmsCodeService: sendTimeoutMs must be a positive integer');
  }
  const store = createSmsCodeStore(options.redis);
  // Domain-separated inputs of the one injected HMAC; app ids are [a-z0-9_] and purposes fixed.
  const phoneKey = (phone: string): string => options.hmac(`phone:${phone}`);
  const keysOf = (appId: string, purpose: SmsPurpose, phone: string): SmsKeys => {
    const key = phoneKey(phone);
    return { phoneKey: key, codeKey: `${appId}:${purpose}:${key}` };
  };
  const codeHash = (appId: string, purpose: SmsPurpose, phone: string, code: string): string =>
    options.hmac(`code:${appId}:${phone}:${purpose}:${code}`);
  const nowMs = (): number => clock.now().getTime();

  async function blockedPrefixes(appId: string): Promise<readonly string[]> {
    const entry = await config.configValue(appId, SMS_BLOCKED_PREFIXES_KEY);
    if (entry === null) return SMS_DEFAULT_BLOCKED_PREFIXES;
    const prefixes = parseBlockedPrefixes(entry.value);
    if (prefixes !== null) return prefixes;
    logger.warn(
      { app_id: appId, config_key: SMS_BLOCKED_PREFIXES_KEY, config_version: entry.version },
      'sms_config_invalid',
    );
    return SMS_DEFAULT_BLOCKED_PREFIXES;
  }

  async function deliver(message: SmsMessage): Promise<SmsDelivery> {
    const fields = { app_id: message.app_id, purpose: message.purpose };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sending = Promise.resolve().then(() => sender.send(message));
      // A send still running after the timeout must not surface as an unhandled rejection.
      sending.catch(() => undefined);
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), sendTimeoutMs);
      });
      const delivery: unknown = await Promise.race([sending, timeout]);
      if (delivery === TIMED_OUT) {
        logger.warn({ ...fields, timeout_ms: sendTimeoutMs }, 'sms_delivery_timeout');
        return 'unknown';
      }
      if (DELIVERIES.has(delivery)) return delivery as SmsDelivery;
      logger.warn(fields, 'sms_delivery_unexpected');
    } catch (error) {
      logger.warn({ ...fields, error_class: errorClass(error) }, 'sms_delivery_failed');
    } finally {
      clearTimeout(timer);
    }
    return 'unknown';
  }

  /** Commit with the same token, retried once on a Redis failure; null when it did not run. */
  async function commit(keys: SmsKeys, token: string, acceptedAt: number): Promise<number | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await store.commit(keys, token, acceptedAt);
      } catch (error) {
        if (!(error instanceof RedisUnavailableError)) throw error;
        if (attempt >= COMMIT_ATTEMPTS) return null;
      }
    }
  }

  return Object.freeze({
    async send(request: SmsRequest): Promise<SmsResult> {
      const normalized = normalize_phone(request.phone);
      if (normalized.code !== 0) {
        return { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } };
      }
      const phone = normalized.phone;
      const { app_id: appId, purpose } = request;
      const checked: SmsRequest = { ...request, phone };

      if (isBlockedPrefix(phone, await blockedPrefixes(appId))) {
        logger.info({ app_id: appId, purpose, kind: 'blocked_prefix' }, 'sms_code_blocked');
        return { code: 44001, kind: 'blocked_prefix' };
      }
      const blocked = (await hooks.phoneBlocklist?.(checked)) ?? null;
      if (blocked !== null) return blocked;
      const captcha = (await hooks.captcha?.(checked)) ?? null;
      if (captcha !== null) return captcha;
      const device = (await hooks.deviceQuota?.(checked)) ?? null;
      if (device !== null) return device;

      const keys = keysOf(appId, purpose, phone);
      const token = randomBytes(16).toString('hex');
      const reservedAt = nowMs();
      let reservation: ReserveOutcome = { kind: 'collision' };
      let code = '';
      try {
        for (let draw = 0; draw < SMS_CODE_DRAWS && reservation.kind === 'collision'; draw++) {
          code = newCode();
          const hash = codeHash(appId, purpose, phone, code);
          reservation = await store.reserve(keys, token, hash, purpose, reservedAt);
        }
      } catch (error) {
        if (!(error instanceof RedisUnavailableError)) throw error;
        logger.warn({ app_id: appId, purpose, reason: error.reason }, 'sms_quota_unavailable');
        return { code: 42901, retryAfterSec: SMS_UNAVAILABLE_RETRY_AFTER_SECONDS };
      }
      if (reservation.kind === 'collision') {
        logger.error({ app_id: appId, purpose, draws: SMS_CODE_DRAWS }, 'sms_code_collision');
        return { code: 50001 };
      }
      if (reservation.kind === 'limited') {
        const retryAfterSec = secondsUntil(reservation.releaseAtMs, reservedAt);
        logger.info({ app_id: appId, purpose, retry_after_sec: retryAfterSec }, 'sms_code_limited');
        return { code: 42901, retryAfterSec };
      }

      const delivery = await deliver({ app_id: appId, phone, purpose, code });
      if (delivery === 'rejected') {
        try {
          await store.release(keys, token, nowMs());
        } catch (error) {
          if (!(error instanceof RedisUnavailableError)) throw error;
          // Counted as sent and the candidate stays current: stricter, never looser.
          logger.warn({ app_id: appId, purpose, reason: error.reason }, 'sms_release_failed');
        }
        logger.warn({ app_id: appId, purpose }, 'sms_code_rejected');
        return { code: 50001 };
      }

      // The 60-second window and the code's lifetime start when the provider answered.
      const acceptedAt = nowMs();
      let releaseAt = await commit(keys, token, acceptedAt);
      if (releaseAt === null) {
        // The reservation still counts (at its reservation time) and the candidate is current.
        logger.error({ app_id: appId, purpose }, 'sms_commit_failed');
        releaseAt = Math.max(reservation.releaseAtMs, acceptedAt + SMS_RESEND_INTERVAL_MS);
      }
      // The SMS went out (or may have): the post-acceptance counters see it either way, and
      // their failure does not change the answer.
      try {
        await hooks.afterAccepted?.(checked);
      } catch (error) {
        logger.error(
          { app_id: appId, purpose, error_class: errorClass(error) },
          'sms_after_accepted_failed',
        );
      }
      logger.info({ app_id: appId, purpose, delivery }, 'sms_code_sent');
      return {
        code: 0,
        data: {
          resend_after_sec: Math.max(
            SMS_RESEND_INTERVAL_MS / 1000,
            secondsUntil(releaseAt, acceptedAt),
          ),
          expires_in_sec: SMS_CODE_LIFETIME_SECONDS,
        },
      };
    },

    /**
     * 0 when the code matches the current code of (app, phone, purpose), which is consumed; 20002
     * when a current code exists and this one is wrong (counted; the fifth wrong try voids the
     * code); 20003 when there is no current code (never sent, expired after 300 s, replaced,
     * consumed, void) or the submitted code is one of those. Redis failures reject.
     * The caller normalises the number first (normalize_phone) and answers 20001 phone_invalid
     * itself when it does not normalise; such a number has no code here and answers 20003.
     */
    async verifyAndConsume(
      request: Pick<SmsMessage, 'app_id' | 'phone' | 'purpose' | 'code'>,
    ): Promise<{ readonly code: 0 | 20002 | 20003 }> {
      const normalized = normalize_phone(request.phone);
      if (normalized.code !== 0) return { code: 20003 };
      const { app_id: appId, purpose, code } = request;
      const phone = normalized.phone;
      // A value that cannot be a code is a wrong try without being hashed.
      const hash =
        typeof code === 'string' && CODE_FORMAT.test(code)
          ? codeHash(appId, purpose, phone, code)
          : '';
      const outcome = await store.verify(keysOf(appId, purpose, phone).codeKey, hash, nowMs());
      if (outcome === 'consumed') return { code: 0 };
      if (outcome === 'wrong') return { code: 20002 };
      return { code: 20003 };
    },
  });
}
