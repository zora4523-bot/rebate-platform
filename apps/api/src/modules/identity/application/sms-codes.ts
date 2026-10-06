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
//      number;
//   4. per-phone quota (60 s / natural hour / natural day / rolling 24 h): an atomic reservation;
//      a limit → 42901 with the latest release; Redis unavailable → 42901, Retry-After 5, no SMS;
//   5. a new random code to the sender port:
//      - accepted, or unknown (timeout, a thrown adapter error, any other answer): counted as sent
//        (ruling §9.5 #1) — the reservation is confirmed at the time the provider answered, the code
//        replaces the previous one of (app, phone, purpose), afterAccepted runs (B1-03g counters),
//        and the answer is 0 with resend_after_sec (seconds until the next send may go, ≥ 60);
//      - rejected: the reservation is released (counts towards nothing), the previous code stays
//        valid, the answer is 50001.
// verifyAndConsume(): 0 when the code matches the valid code of (app, phone, purpose), which is
// consumed; 20002 when a valid code exists and this one is wrong (counted; after the fifth wrong
// try the code is void); 20003 when there is no valid code (never sent, expired after 300 s,
// replaced, consumed, void). An unnormalisable number has no code: 20003. Redis failures reject.
//
// Nothing is logged that identifies the number or the code: no phone in any form, no code, no
// captcha_token (BR-ID-33). Codes and keys are HMACs made by the injected `hmac` (production: the
// field-encryption blind index, the same in every process).
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
import { createSmsCodeStore, type ReserveOutcome } from '../infra/sms-code-store.ts';

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
 * accepted, definitely rejected, or outcome unknown.
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
}
export interface SmsCodeService {
  send(request: SmsRequest): Promise<SmsResult>;
  verifyAndConsume(
    request: Pick<SmsMessage, 'app_id' | 'phone' | 'purpose' | 'code'>,
  ): Promise<{ readonly code: 0 | 20002 | 20003 }>;
}

const CODE_FORMAT = /^[0-9]{6}$/;
const CODE_SPACE = 10 ** SMS_CODE_DIGITS;
const DELIVERIES: ReadonlySet<unknown> = new Set(['accepted', 'rejected', 'unknown']);

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
  const store = createSmsCodeStore(options.redis);
  // Domain-separated inputs of the one injected HMAC; app ids are [a-z0-9_] and purposes fixed.
  const phoneKey = (phone: string): string => options.hmac(`phone:${phone}`);
  const codeKey = (appId: string, purpose: SmsPurpose, phone: string): string =>
    `${appId}:${purpose}:${phoneKey(phone)}`;
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
    try {
      const delivery: unknown = await sender.send(message);
      if (DELIVERIES.has(delivery)) return delivery as SmsDelivery;
      logger.warn({ app_id: message.app_id, purpose: message.purpose }, 'sms_delivery_unexpected');
    } catch (error) {
      logger.warn(
        { app_id: message.app_id, purpose: message.purpose, error_class: errorClass(error) },
        'sms_delivery_failed',
      );
    }
    return 'unknown';
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

      const key = phoneKey(phone);
      const token = randomBytes(16).toString('hex');
      const reservedAt = nowMs();
      let reservation: ReserveOutcome;
      try {
        reservation = await store.reserve(key, token, reservedAt);
      } catch (error) {
        if (!(error instanceof RedisUnavailableError)) throw error;
        logger.warn({ app_id: appId, purpose, reason: error.reason }, 'sms_quota_unavailable');
        return { code: 42901, retryAfterSec: SMS_UNAVAILABLE_RETRY_AFTER_SECONDS };
      }
      if (!reservation.reserved) {
        const retryAfterSec = secondsUntil(reservation.releaseAtMs, reservedAt);
        logger.info({ app_id: appId, purpose, retry_after_sec: retryAfterSec }, 'sms_code_limited');
        return { code: 42901, retryAfterSec };
      }

      const code = newCode();
      const delivery = await deliver({ app_id: appId, phone, purpose, code });
      if (delivery === 'rejected') {
        try {
          await store.release(key, token);
        } catch (error) {
          if (!(error instanceof RedisUnavailableError)) throw error;
          // The reservation stops counting once its lease runs out (by Clock).
          logger.warn({ app_id: appId, purpose, reason: error.reason }, 'sms_release_failed');
        }
        logger.warn({ app_id: appId, purpose }, 'sms_code_rejected');
        return { code: 50001 };
      }

      // The 60-second window and the code's lifetime start when the provider answered.
      const acceptedAt = nowMs();
      let releaseAt: number | null = null;
      try {
        releaseAt = await store.confirm(key, token, acceptedAt);
        await store.storeCode(
          codeKey(appId, purpose, phone),
          codeHash(appId, purpose, phone, code),
          purpose,
          acceptedAt,
        );
      } catch (error) {
        if (!(error instanceof RedisUnavailableError)) throw error;
        logger.error({ app_id: appId, purpose, reason: error.reason }, 'sms_code_store_failed');
        releaseAt = null;
      }
      // The SMS went out (or may have): the post-acceptance counters see it either way.
      await hooks.afterAccepted?.(checked);
      if (releaseAt === null) return { code: 50001 };
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
      const outcome = await store.verify(codeKey(appId, purpose, phone), hash, nowMs());
      if (outcome === 'consumed') return { code: 0 };
      if (outcome === 'wrong') return { code: 20002 };
      return { code: 20003 };
    },
  });
}
