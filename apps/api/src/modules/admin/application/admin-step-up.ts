// Admin step-up and the signed-in account's permissions (F1-06l; 08 BR-ID-34 「后台 step-up 分两
// 档」; contract operations adminSendStepUpSms, adminStepUp, adminGetMyPermissions; ruling §9.2
// #2–#4). The caller is the principal the admin token check verified (account active and not
// locked, session live); nothing here trusts the request body for identity.
//
//   sendSms: an account without a verify phone → 10003 (sms, verify_phone_missing), nothing sent;
//     else one 6-digit code to the registered verify phone through identity's SmsSender port
//     (purpose step_up), at most one per account every 60 seconds by the Clock (42901 with
//     Retry-After); the code is valid 300 seconds and replaces any earlier one. The code is
//     recorded before the SMS goes out (failing that: nothing sent, slot freed, 50001); a definite
//     rejection by the provider withdraws the new code and frees the slot (50001); an unknown
//     outcome (or a thrown error) counts as sent.
//   stepUp: tier=totp accepts only the authenticator code (F1-06b verifier with the PG replay
//     store, shared with the login step); tier=sms accepts only the latest SMS code sent, once
//     (none pending, or a replaced, used or expired code → 20003, not counted; never a fallback
//     to the authenticator code);
//     tier=sms without a verify phone → 10003 (sms, verify_phone_missing). A wrong code of either
//     tier is 20002 and counts towards the login-failure lock (F1-06k's counter: the 5th sets the
//     lock and still answers 20002; afterwards the token check answers 10001). Success issues a
//     step_up_token bound to the account, the admin session and the tier (5 minutes).
//   me: the account, its permission points (every point for a super admin) with their step-up
//     annotation, and its verify phone masked (BR-ID-33) or null.
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import { randomInt } from 'node:crypto';
import type { Clock, FieldCrypto } from '../../platform/index.ts';
import {
  grantedPermissions,
  type AdminPermissionDefinition,
  type AdminStepUpTier,
} from '../domain/permission-catalog.ts';
import {
  STEP_UP_SMS_CODE_DIGITS,
  STEP_UP_SMS_CODE_TTL_MS,
  STEP_UP_SMS_RESEND_MS,
  maskVerifyPhone,
  retryAfterSeconds,
  verifyPhoneContext,
} from '../domain/step-up-policy.ts';
import type { TotpVerifier } from '../domain/totp.ts';
import type { AdminAccount, AdminAccounts } from '../infra/admin-accounts.ts';
import type { AdminProfile, AdminProfiles } from '../infra/admin-profiles.ts';
import type { StepUpSmsCodes } from '../infra/step-up-sms-codes.ts';
import { ADMIN_ACTIVE_STATUS, ADMIN_AUTH_AUDIT } from './admin-login.ts';
import type { AdminStepUpGrant, AdminStepUpTokens } from './permission-guard.ts';

/** identity's SmsSender port as this module uses it (purpose step_up only). */
export interface AdminSmsSender {
  send(message: {
    readonly app_id: string;
    readonly phone: string;
    readonly purpose: 'step_up';
    readonly code: string;
  }): Promise<'accepted' | 'rejected' | 'unknown'>;
}

/**
 * The sender of an entry without identity's: every send is a definite rejection, so sending
 * answers 50001 and keeps neither the code nor the 60-second slot (a thrown error would count as
 * sent).
 */
export const NO_SMS_SENDER: AdminSmsSender = Object.freeze({
  send: () => Promise.resolve('rejected' as const),
});

/** The verified admin principal of the request. */
export interface AdminCaller {
  readonly appId: string;
  readonly adminId: string;
  readonly sessionId: string;
  readonly ip: string | null;
}

export type SendStepUpSmsResult =
  | { readonly code: 0; readonly resendAfterSec: number; readonly expiresInSec: number }
  | { readonly code: 10001 }
  | { readonly code: 10003 }
  | { readonly code: 42901; readonly retryAfterSec: number }
  | { readonly code: 50001 };

export type StepUpResult =
  | { readonly code: 0; readonly grant: AdminStepUpGrant }
  | { readonly code: 10001 }
  /** sms tier without a registered verify phone. */
  | { readonly code: 10003 }
  | { readonly code: 20002 }
  | { readonly code: 20003 };

export interface AdminMe {
  readonly admin_id: string;
  readonly username: string;
  readonly is_super: boolean;
  readonly verify_phone_masked: string | null;
  readonly permissions: readonly {
    readonly key: string;
    readonly step_up_tier: AdminStepUpTier | null;
    readonly step_up_operations: AdminPermissionDefinition['operations'];
  }[];
}

export type AdminMeResult = { readonly code: 0; readonly me: AdminMe } | { readonly code: 10001 };

export interface AdminStepUpService {
  sendSms(caller: AdminCaller): Promise<SendStepUpSmsResult>;
  stepUp(caller: AdminCaller, tier: AdminStepUpTier, code: string): Promise<StepUpResult>;
  me(caller: AdminCaller): Promise<AdminMeResult>;
}

export interface AdminStepUpDeps {
  readonly clock: Clock;
  readonly accounts: AdminAccounts;
  readonly profiles: AdminProfiles;
  /** F1-06b verifier with the durable replay store (admin_users.totp_last_step). */
  readonly totp: TotpVerifier;
  readonly smsCodes: StepUpSmsCodes;
  readonly sender: AdminSmsSender;
  readonly tokens: AdminStepUpTokens;
  /** Field cipher: the verify phone, and the keyed hash (blind index) of SMS codes. */
  readonly crypto: Pick<FieldCrypto, 'decrypt' | 'blindIndex'>;
}

const EXPIRED = Object.freeze({ code: 10001 as const });
const PHONE_MISSING = Object.freeze({ code: 10003 as const });
const WRONG = Object.freeze({ code: 20002 as const });
const CODE_GONE = Object.freeze({ code: 20003 as const });
const SEND_FAILED = Object.freeze({ code: 50001 as const });
/** Bound on drawing a code whose hash differs from the pending and replaced ones. */
const CODE_DRAWS = 16;

const codeContext = (caller: AdminCaller): string =>
  `admin_step_up.sms_code:${caller.appId}:${caller.adminId}`;

export function createAdminStepUpService(deps: AdminStepUpDeps): AdminStepUpService {
  const { clock, accounts, profiles, totp, smsCodes, sender, tokens, crypto } = deps;

  const activeProfile = async (caller: AdminCaller): Promise<AdminProfile | undefined> => {
    const profile = await profiles.byId(caller.appId, caller.adminId);
    return profile?.status === ADMIN_ACTIVE_STATUS ? profile : undefined;
  };

  const verifyPhone = (caller: AdminCaller, cipher: Buffer): string =>
    crypto.decrypt(cipher.toString('utf8'), verifyPhoneContext(caller));

  const hashOf = (caller: AdminCaller, code: string): string =>
    crypto.blindIndex(code, codeContext(caller));

  /** A wrong code: one more consecutive failure (F1-06k counter); still 20002 when it locks. */
  const wrongCode = async (account: AdminAccount, caller: AdminCaller): Promise<StepUpResult> => {
    await accounts.recordFailure(account, (until) => ({
      action: ADMIN_AUTH_AUDIT.locked,
      target: `admin_users:${account.id}`,
      before: null,
      after: { locked_until: until.toISOString() },
      ip: caller.ip,
    }));
    return WRONG;
  };

  const issue = async (caller: AdminCaller, tier: AdminStepUpTier): Promise<StepUpResult> => ({
    code: 0,
    grant: await tokens.issue({
      appId: caller.appId,
      adminId: caller.adminId,
      sessionId: caller.sessionId,
      tier,
    }),
  });

  return {
    async sendSms(caller) {
      const profile = await activeProfile(caller);
      if (profile === undefined) return EXPIRED;
      if (profile.verifyPhoneCipher === null) return PHONE_MISSING;
      const phone = verifyPhone(caller, profile.verifyPhoneCipher);
      const nowMs = clock.now().getTime();
      const slot = await smsCodes.reserve(
        caller.appId,
        caller.adminId,
        nowMs,
        STEP_UP_SMS_RESEND_MS,
      );
      if (slot.kind === 'limited') {
        return { code: 42901, retryAfterSec: retryAfterSeconds(slot.retryAfterMs) };
      }
      const free = async (): Promise<SendStepUpSmsResult> => {
        try {
          await smsCodes.release(caller.appId, caller.adminId, slot.reservation);
        } catch {
          // The slot then lapses by itself after the 60 seconds.
        }
        return SEND_FAILED;
      };
      let code = '';
      let hash = '';
      try {
        const known = await smsCodes.knownHashes(caller.appId, caller.adminId);
        for (let draw = 0; draw < CODE_DRAWS && (hash === '' || known.has(hash)); draw += 1) {
          code = String(randomInt(0, 10 ** STEP_UP_SMS_CODE_DIGITS)).padStart(
            STEP_UP_SMS_CODE_DIGITS,
            '0',
          );
          hash = hashOf(caller, code);
        }
        if (known.has(hash)) return await free();
        // The record first (repo hard rule 3): the new code becomes current and the previous one
        // is void before the SMS can reach anyone; nothing is sent when this write fails.
        await smsCodes.store(
          caller.appId,
          caller.adminId,
          hash,
          nowMs,
          nowMs + STEP_UP_SMS_CODE_TTL_MS,
        );
      } catch {
        return await free();
      }
      let delivery: 'accepted' | 'rejected' | 'unknown';
      try {
        delivery = await sender.send({ app_id: caller.appId, phone, purpose: 'step_up', code });
      } catch {
        // The port: a thrown error counts as sent (outcome unknown).
        delivery = 'unknown';
      }
      if (delivery === 'rejected') {
        // Never delivered: withdraw the new code (the previous one stays void) and the slot.
        try {
          await smsCodes.revoke(caller.appId, caller.adminId, hash, nowMs);
        } catch {
          // A code nobody received only lapses with its record.
        }
        return await free();
      }
      return {
        code: 0,
        resendAfterSec: STEP_UP_SMS_RESEND_MS / 1000,
        expiresInSec: STEP_UP_SMS_CODE_TTL_MS / 1000,
      };
    },

    async stepUp(caller, tier, code) {
      const account = await accounts.byId(caller.appId, caller.adminId);
      if (account === undefined || account.status !== ADMIN_ACTIVE_STATUS) return EXPIRED;
      if (tier === 'sms') {
        const profile = await activeProfile(caller);
        if (profile === undefined) return EXPIRED;
        if (profile.verifyPhoneCipher === null) return PHONE_MISSING;
        const check = await smsCodes.check(
          caller.appId,
          caller.adminId,
          hashOf(caller, code),
          clock.now().getTime(),
        );
        if (check === 'ok') return await issue(caller, 'sms');
        if (check === 'wrong') return await wrongCode(account, caller);
        return CODE_GONE;
      }
      const ok =
        account.totpSecretCipher !== null &&
        account.totpBoundAt !== null &&
        (await totp.verify({
          appId: account.appId,
          adminId: account.id,
          secretCipher: account.totpSecretCipher,
          code,
        }));
      if (!ok) return await wrongCode(account, caller);
      return await issue(caller, 'totp');
    },

    async me(caller) {
      const profile = await activeProfile(caller);
      if (profile === undefined) return EXPIRED;
      const ticked = profile.isSuper
        ? []
        : await profiles.permissionKeys(caller.appId, caller.adminId);
      return {
        code: 0,
        me: {
          admin_id: profile.id,
          username: profile.loginName,
          is_super: profile.isSuper,
          verify_phone_masked:
            profile.verifyPhoneCipher === null
              ? null
              : maskVerifyPhone(verifyPhone(caller, profile.verifyPhoneCipher)),
          permissions: grantedPermissions(profile.isSuper, ticked).map((entry) => ({
            key: entry.key,
            step_up_tier: entry.step_up_tier,
            step_up_operations: entry.operations,
          })),
        },
      };
    },
  };
}
