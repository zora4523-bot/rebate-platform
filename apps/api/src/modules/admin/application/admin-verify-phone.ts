// Registering or changing an admin account's verify phone (B1-34i; 08 BR-ID-45, BR-ID-33; contract
// CT-24o adminSendMyVerifyPhoneCode, adminChangeMyVerifyPhone, adminSendAdminVerifyPhoneCode,
// adminChangeAdminVerifyPhone). The admin request check has verified the admin_token (and, on the
// super admin's routes, refused any account that is not a super admin); the controller has checked
// the totp-tier step-up of the sends; the route schema has checked the bodies' shape.
//
//   send (the holder's own, or a super admin's for an ordinary account): the target is judged
//     (super route: unknown → 20001 admin_id; the caller itself or a super admin → 10403); the
//     phone is normalised (BR-ID-05; else 20001 phone_invalid) and must differ from the current
//     verify phone (else 20001 phone); at most one send per target account every 60 seconds by the
//     Clock (42901, the sms step-up tier's limit); a fresh 6-digit code becomes the account's only
//     pending code (the earlier one is void) — recorded before the SMS goes out with only the new
//     phone's blind index and the code's keyed hash (BR-ID-33) — then goes to the new phone through
//     identity's SmsSender port with the admin step-up template (purpose step_up). A super admin's
//     send is audited (admin_verify_phone_code_send) before the SMS goes out. A definite rejection
//     by the provider withdraws the code and frees the slot (50001); an unknown outcome counts as
//     sent. The current verify phone stays in force until a change succeeds.
//   change: the phone is normalised as for sending; the super route also needs a non-blank reason
//     (20001 reason); then, under the target row's lock, the pending code for this account and
//     phone is checked: a wrong code → 20002 (never counted towards the login lock; the 5th wrong
//     try voids the pending code); none pending, expired, used, replaced or voided → 20003; a
//     verified code replaces the verify phone (field cipher + blind index, BR-ID-33) and writes the
//     audit row (admin_verify_phone_change: masked phones before and after, who made it, the
//     reason on the super route). Sessions stay.
//
// Pure module (no decorators, erasable syntax).
import { randomInt } from 'node:crypto';
import type { Clock, FieldCrypto } from '../../platform/index.ts';
import { isAdminId } from '../domain/admin-view.ts';
import {
  STEP_UP_SMS_CODE_DIGITS,
  STEP_UP_SMS_CODE_TTL_MS,
  STEP_UP_SMS_RESEND_MS,
  maskVerifyPhone,
  retryAfterSeconds,
  verifyPhoneContext,
} from '../domain/step-up-policy.ts';
import {
  VERIFY_PHONE_CODE_MAX_WRONG,
  normalizeVerifyPhone,
  verifyPhoneCodeContext,
} from '../domain/verify-phone-policy.ts';
import type { AdminProfile, AdminProfiles } from '../infra/admin-profiles.ts';
import type {
  AdminVerifyPhoneWrites,
  VerifyPhoneRefusal,
} from '../infra/admin-verify-phone-writes.ts';
import type { VerifyPhoneCodes } from '../infra/verify-phone-codes.ts';
import { toAccountView, type AdminAccountView } from './admin-accounts-read.ts';
import { reasonOk } from './admin-accounts-write.ts';
import type { AdminSmsSender } from './admin-step-up.ts';

export interface VerifyPhoneCaller {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export type VerifyPhoneRefused =
  /** 20001 with data.fields (and data.reason=phone_invalid for a phone that is not one). */
  | {
      readonly kind: 'fields';
      readonly fields: readonly string[];
      readonly reason?: 'phone_invalid';
    }
  /** 10403 admin_permission_denied. */
  | { readonly kind: 'forbidden' }
  /** 10001: the caller's own account is gone. */
  | { readonly kind: 'expired' };

export type VerifyPhoneSendAnswer =
  | { readonly kind: 'sent'; readonly resendAfterSec: number; readonly expiresInSec: number }
  | { readonly kind: 'limited'; readonly retryAfterSec: number }
  | { readonly kind: 'failed' }
  | VerifyPhoneRefused;

export type VerifyPhoneCodeRefused = { readonly kind: 'wrong' } | { readonly kind: 'gone' };

export type MyVerifyPhoneAnswer =
  | { readonly kind: 'ok'; readonly masked: string; readonly setAt: Date }
  | VerifyPhoneCodeRefused
  | VerifyPhoneRefused;

export type AdminVerifyPhoneAnswer =
  | { readonly kind: 'ok'; readonly account: AdminAccountView }
  | VerifyPhoneCodeRefused
  | VerifyPhoneRefused;

export interface AdminVerifyPhoneService {
  sendMine(caller: VerifyPhoneCaller, phone: string): Promise<VerifyPhoneSendAnswer>;
  sendFor(
    caller: VerifyPhoneCaller,
    adminId: string,
    phone: string,
  ): Promise<VerifyPhoneSendAnswer>;
  changeMine(caller: VerifyPhoneCaller, phone: string, code: string): Promise<MyVerifyPhoneAnswer>;
  changeFor(
    caller: VerifyPhoneCaller,
    adminId: string,
    body: { readonly phone: string; readonly code: string; readonly reason: string },
  ): Promise<AdminVerifyPhoneAnswer>;
}

export interface AdminVerifyPhoneDeps {
  readonly clock: Clock;
  readonly profiles: AdminProfiles;
  readonly codes: VerifyPhoneCodes;
  readonly sender: AdminSmsSender;
  readonly writes: AdminVerifyPhoneWrites;
  readonly crypto: Pick<FieldCrypto, 'encrypt' | 'decrypt' | 'blindIndex'>;
}

const fields = (...names: string[]): VerifyPhoneRefused => ({ kind: 'fields', fields: names });
const PHONE_INVALID: VerifyPhoneRefused = Object.freeze({
  kind: 'fields',
  fields: Object.freeze(['phone']),
  reason: 'phone_invalid',
});
const FORBIDDEN: VerifyPhoneRefused = Object.freeze({ kind: 'forbidden' });
const EXPIRED: VerifyPhoneRefused = Object.freeze({ kind: 'expired' });
const FAILED: VerifyPhoneSendAnswer = Object.freeze({ kind: 'failed' });
/** Bound on drawing a code whose hash differs from the pending and replaced ones. */
const CODE_DRAWS = 16;

interface Account {
  readonly appId: string;
  readonly adminId: string;
}

export function createAdminVerifyPhoneService(deps: AdminVerifyPhoneDeps): AdminVerifyPhoneService {
  const { clock, profiles, codes, sender, writes, crypto } = deps;

  const phoneHmac = (account: Account, phone: string): string =>
    crypto.blindIndex(phone, verifyPhoneContext(account));
  const codeHash = (account: Account, code: string): string =>
    crypto.blindIndex(code, verifyPhoneCodeContext(account));
  const stored = (account: Account, cipher: Buffer): string =>
    crypto.decrypt(cipher.toString('utf8'), verifyPhoneContext(account));

  /** The target of the super admin's route: an ordinary account of the app, not the caller. */
  const ordinaryTarget = async (
    caller: VerifyPhoneCaller,
    adminId: string,
  ): Promise<AdminProfile | VerifyPhoneRefused> => {
    if (!isAdminId(adminId)) return fields('admin_id');
    const profile = await profiles.byId(caller.appId, adminId);
    if (profile === undefined) return fields('admin_id');
    if (profile.isSuper || profile.id === caller.adminId) return FORBIDDEN;
    return profile;
  };

  const send = async (
    caller: VerifyPhoneCaller,
    target: AdminProfile,
    input: string,
    audited: boolean,
  ): Promise<VerifyPhoneSendAnswer> => {
    const account: Account = { appId: target.appId, adminId: target.id };
    const phone = normalizeVerifyPhone(input);
    if (phone === null) return PHONE_INVALID;
    if (target.verifyPhoneCipher !== null && stored(account, target.verifyPhoneCipher) === phone) {
      return fields('phone');
    }
    const nowMs = clock.now().getTime();
    const slot = await codes.reserve(account.appId, account.adminId, nowMs, STEP_UP_SMS_RESEND_MS);
    if (slot.kind === 'limited') {
      return { kind: 'limited', retryAfterSec: retryAfterSeconds(slot.retryAfterMs) };
    }
    const free = async (): Promise<VerifyPhoneSendAnswer> => {
      try {
        await codes.release(account.appId, account.adminId, slot.reservation);
      } catch {
        // The slot then lapses by itself after the 60 seconds.
      }
      return FAILED;
    };
    const withdraw = async (hash: string): Promise<VerifyPhoneSendAnswer> => {
      try {
        await codes.revoke(account.appId, account.adminId, hash, nowMs);
      } catch {
        // A code nobody received only lapses with its record.
      }
      return await free();
    };

    let code = '';
    let hash = '';
    try {
      const known = await codes.knownHashes(account.appId, account.adminId);
      for (let draw = 0; draw < CODE_DRAWS && (hash === '' || known.has(hash)); draw += 1) {
        code = String(randomInt(0, 10 ** STEP_UP_SMS_CODE_DIGITS)).padStart(
          STEP_UP_SMS_CODE_DIGITS,
          '0',
        );
        hash = codeHash(account, code);
      }
      if (known.has(hash)) return await free();
      // The record first (repo hard rule 3): nothing is sent when this write fails.
      await codes.store(
        account.appId,
        account.adminId,
        { phone: phoneHmac(account, phone), hash },
        nowMs,
        nowMs + STEP_UP_SMS_CODE_TTL_MS,
      );
    } catch {
      return await free();
    }
    if (audited) {
      try {
        await writes.auditSend({
          appId: caller.appId,
          actor: caller.adminId,
          ip: caller.ip,
          adminId: account.adminId,
          masked: maskVerifyPhone(phone),
        });
      } catch {
        return await withdraw(hash);
      }
    }
    let delivery: 'accepted' | 'rejected' | 'unknown';
    try {
      delivery = await sender.send({ app_id: account.appId, phone, purpose: 'step_up', code });
    } catch {
      // The port: a thrown error counts as sent (outcome unknown).
      delivery = 'unknown';
    }
    if (delivery === 'rejected') return await withdraw(hash);
    return {
      kind: 'sent',
      resendAfterSec: STEP_UP_SMS_RESEND_MS / 1000,
      expiresInSec: STEP_UP_SMS_CODE_TTL_MS / 1000,
    };
  };

  const change = async (
    caller: VerifyPhoneCaller,
    account: Account,
    phone: string,
    code: string,
    reason: string | null,
  ) => {
    const cipher = crypto.encrypt(phone, verifyPhoneContext(account));
    const hmac = phoneHmac(account, phone);
    return await writes.change({
      appId: account.appId,
      actor: caller.adminId,
      ip: caller.ip,
      adminId: account.adminId,
      bySuper: reason !== null,
      reason,
      phone: { cipher, hmac, masked: maskVerifyPhone(phone) },
      maskedOf: (old) => maskVerifyPhone(stored(account, old)),
      verify: () =>
        codes.check(
          account.appId,
          account.adminId,
          { phone: hmac, hash: codeHash(account, code) },
          clock.now().getTime(),
          VERIFY_PHONE_CODE_MAX_WRONG,
        ),
    });
  };

  const refusalOf = (reason: VerifyPhoneRefusal): VerifyPhoneCodeRefused | VerifyPhoneRefused =>
    reason === 'unknown'
      ? fields('admin_id')
      : reason === 'forbidden'
        ? FORBIDDEN
        : { kind: reason };

  return {
    async sendMine(caller, phone) {
      const profile = await profiles.byId(caller.appId, caller.adminId);
      if (profile === undefined) return EXPIRED;
      return await send(caller, profile, phone, false);
    },

    async sendFor(caller, adminId, phone) {
      const target = await ordinaryTarget(caller, adminId);
      if ('kind' in target) return target;
      return await send(caller, target, phone, true);
    },

    async changeMine(caller, input, code) {
      const phone = normalizeVerifyPhone(input);
      if (phone === null) return PHONE_INVALID;
      const account: Account = { appId: caller.appId, adminId: caller.adminId };
      const result = await change(caller, account, phone, code, null);
      if (result.kind === 'refused') {
        return result.reason === 'unknown' ? EXPIRED : refusalOf(result.reason);
      }
      return { kind: 'ok', masked: maskVerifyPhone(phone), setAt: result.setAt };
    },

    async changeFor(caller, adminId, body) {
      if (!reasonOk(body.reason)) return fields('reason');
      if (!isAdminId(adminId)) return fields('admin_id');
      const phone = normalizeVerifyPhone(body.phone);
      if (phone === null) return PHONE_INVALID;
      const account: Account = { appId: caller.appId, adminId };
      const result = await change(caller, account, phone, body.code, body.reason);
      if (result.kind === 'refused') return refusalOf(result.reason);
      return { kind: 'ok', account: toAccountView(result.row, clock.now(), crypto) };
    },
  };
}
