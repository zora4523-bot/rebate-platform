// SMS login (规划/08 BR-ID-01 细则「受限会话」, BR-ID-04, BR-ID-05, BR-ID-12 login_merge, BR-ID-31,
// BR-INV-06, BR-INV-09; 04 §6.1 POST /v1/auth/login/sms). Signature ① and the device-source check
// ③ already ran at the registration point; the controller passes the verified app and device.
//
// login(command), in order (orchestrator ruling B1-02j §9.2):
//   1. the session scope of this request (sessionScope: X-Platform, X-Channel, X-App-Version):
//      deletion_only makes it a restricted login, decided before any business step and never
//      changed afterwards. A failed version read rejects (never read as "no minimum");
//   2. normalize_phone → 20001 phone_invalid (no code consumed);
//   3. verifyAndConsume (login purpose) → 20002 / 20003. The code is consumed here, outside and
//      before the PG transaction: a later rollback (10405, 44001, 50001, a thrown error) does not
//      bring it back;
//   4. one READ COMMITTED transaction: the account by phone blind index (status <> deleted;
//      cooling-off counts as existing), then
//      - restricted, no account → 10405 no_account, nothing written, no token; the minimum in the
//        answer is read again after the rollback (the current value, null when removed);
//      - restricted, account → deletion_only session; invite_code ignored (ignored_existing_user
//        when one was sent);
//      - full, no account → the phone blocklist port (B1-03d; 44001) → registration.register (B1-02i,
//        device_hash from the device row): 0 → is_new_user; 44001 / 50001 → that answer, all
//        rolled back; phone_taken (a concurrent first login won) → log in the winner's account,
//        is_new_user=false, ignored_existing_user when a code was sent;
//      - full, account → a normal login, ignored_existing_user when a code was sent;
//   5. on success, in the same transaction: the two login-page consent records (privacy,
//      agreement; version from the request, client_at = consent_at, server_at = Clock), then
//      login_merge of this installation's device-level current states, one login_logs row
//      (method sms, the HMAC of the device id), the first-App-login review port (BR-INV-09: App
//      platforms, landing-bound user, no login_logs before this one), then createSession.
// Any non-zero answer after step 3 and any thrown error roll the whole transaction back: no
// consent, no login log, no session. A banned user logs in like anyone else (BR-ID-31: no 10006).
//
// Nothing logged identifies the person: no phone in any form, no code, no token, no device id, no
// IP, no invite code.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  isVersionGatedPlatform,
  type Clock,
  type FieldCrypto,
  type RootLogger,
} from '../../platform/index.ts';
import {
  LOGIN_LOGS_DEVICE_ID_CONTEXT,
  LOGIN_MERGE_CHANNEL,
  LOGIN_PAGE_CHANNEL,
  LOGIN_PAGE_TYPES,
  SMS_LOGIN_METHOD,
  loginMergeCopies,
  normalizeInviteCode,
} from '../domain/login.ts';
import { normalize_phone } from '../domain/normalize-phone.ts';
import { PHONE_BLIND_INDEX_CONTEXT } from '../domain/registration.ts';
import {
  deviceConsentRecords,
  insertConsentRecords,
  userConsentRecords,
  type NewConsentRecord,
} from '../infra/consent-records.ts';
import { deviceHashOf, findAccountByPhone, type LoginAccount } from '../infra/login-accounts.ts';
import { hasLoginLog, insertLoginLog } from '../infra/login-logs.ts';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  type TokenService,
} from './access-tokens.ts';
import type { InviteBindResult, RegistrationService } from './registration.ts';
import { sessionScope, type MinimumVersionReader } from './session-scope.ts';
import { createSession } from './sessions.ts';
import type { SmsCodeService } from './sms-codes.ts';

export { LOGIN_LOGS_DEVICE_ID_CONTEXT } from '../domain/login.ts';

/** Body is contract-validated; app/device/IP come from the verified request, never its body. */
export interface SmsLoginCommand {
  readonly body: Schema<'LoginBySmsRequest'>;
  readonly app_id: string;
  readonly device_id: string;
  readonly platform: ClientPlatform;
  readonly channel?: string;
  readonly version?: string;
  readonly client_ip: string;
}

export type SmsLoginResult =
  | { readonly code: 0; readonly data: Schema<'LoginData'> }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly ['phone']; readonly reason: 'phone_invalid' };
    }
  | { readonly code: 20002 | 20003 | 50001 }
  | { readonly code: 44001; readonly data?: { readonly risk_msg_code: string } }
  | {
      readonly code: 10405;
      readonly data: {
        readonly reason: 'no_account';
        readonly min_supported_version: string | null;
      };
    };

/** B1-11 supplies the review; identity selects landing-bound users with no login_logs.
 * Invoke on App platforms only, in the same transaction as the first successful login log.
 * This port cannot create a relationship. Absence means no work (no landing binds exist yet).
 */
export interface FirstAppLoginReview {
  review(
    trx: Transaction<DB>,
    input: {
      readonly app_id: string;
      readonly user_id: string;
      /** blindIndex(verifiedDevice.deviceId, 'login_logs.device_id').
       * Implementation exports LOGIN_LOGS_DEVICE_ID_CONTEXT from identity/index.ts.
       * Test-stage skeletons cannot declare initialized constants.
       */
      readonly device_id_hash: string;
    },
  ): Promise<void>;
}

export interface SmsLoginOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  readonly versions: MinimumVersionReader;
  readonly sms: Pick<SmsCodeService, 'verifyAndConsume'>;
  readonly registration: RegistrationService;
  readonly tokens: TokenService;
  readonly firstAppLoginReview?: FirstAppLoginReview;
  /** B1-03d, only before creating an account; absent means no block. No plaintext phone. */
  readonly phoneBlocklist?: (
    trx: Transaction<DB>,
    input: { readonly app_id: string; readonly phone_hmac: string },
  ) => Promise<{ readonly code: 44001; readonly data?: { readonly risk_msg_code: string } } | null>;
}

export interface SmsLoginService {
  /** Scope → normalize → consume SMS → lookup → register/existing branch.
   * Own the PG transaction: registration, login consents/merge, growth review, log and session.
   * SMS consumption remains effective even when the PG transaction rejects or rolls back.
   * Pass login_method=sms when the session primitive supports the registered schema field.
   */
  login(command: SmsLoginCommand): Promise<SmsLoginResult>;
}

type SessionScope = 'full' | 'deletion_only';

/** An answer that ends the transaction with a rollback (thrown out of the callback). */
class LoginAbort extends Error {
  readonly result: SmsLoginResult | 'no_account';
  constructor(result: SmsLoginResult | 'no_account') {
    super('identity: sms login rolled back');
    this.name = 'LoginAbort';
    this.result = result;
  }
}

const IGNORED_EXISTING_USER: InviteBindResult = Object.freeze({
  result: 'ignored_existing_user',
  code: null,
});

/** A Date at `ms` without constructing one from the wall clock (the Clock rule of apps/api). */
function instantAt(like: Date, ms: number): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

interface Signed {
  readonly user_id: string;
  readonly is_new_user: boolean;
  readonly invite_bind?: InviteBindResult;
  readonly tokens: Schema<'TokenPair'>;
}

export function createSmsLoginService(options: SmsLoginOptions): SmsLoginService {
  const { db, clock, crypto, logger, versions, sms, registration, tokens } = options;

  /** Login-page consents, login_merge, login log, first-App-login review and the session. */
  async function signIn(
    trx: Transaction<DB>,
    command: SmsLoginCommand,
    account: LoginAccount,
    scope: SessionScope,
  ): Promise<Schema<'TokenPair'>> {
    const { app_id: appId, device_id: deviceId, body } = command;
    const userId = account.id;
    const now = clock.now();
    // consent_at is a contract date-time (client clock), stored as reported.
    const clientAt = instantAt(now, Date.parse(body.consent_at));
    // BR-ID-04: two user-level records of the login page, version as reported by the client.
    await insertConsentRecords(
      trx,
      LOGIN_PAGE_TYPES.map((type): NewConsentRecord => ({
        app_id: appId,
        subject_type: 'user',
        user_id: userId,
        device_id: null,
        type,
        version: body.legal_versions[type],
        channel: LOGIN_PAGE_CHANNEL,
        accepted: true,
        client_at: clientAt,
        server_at: now,
      })),
    );
    // BR-ID-12 login_merge: this installation's device-level current states.
    const copies = loginMergeCopies(
      await deviceConsentRecords(trx, appId, deviceId),
      await userConsentRecords(trx, appId, userId),
    );
    await insertConsentRecords(
      trx,
      copies.map((record): NewConsentRecord => ({
        app_id: appId,
        subject_type: 'user',
        user_id: userId,
        device_id: null,
        type: record.type,
        version: record.version,
        channel: LOGIN_MERGE_CHANNEL,
        accepted: record.accepted,
        client_at: record.client_at,
        server_at: now,
      })),
    );
    const deviceIdHash = crypto.blindIndex(deviceId, LOGIN_LOGS_DEVICE_ID_CONTEXT);
    const firstLogin = !(await hasLoginLog(trx, appId, userId));
    await insertLoginLog(trx, {
      app_id: appId,
      user_id: userId,
      device_id_hash: deviceIdHash,
      ip: command.client_ip,
      method: SMS_LOGIN_METHOD,
      created_at: now,
    });
    // BR-INV-09: only an App login, only a landing-bound user, only the first login log.
    const review = options.firstAppLoginReview;
    if (
      review !== undefined &&
      firstLogin &&
      isVersionGatedPlatform(command.platform) &&
      account.parent_bind_source === 'landing'
    ) {
      await review.review(trx, { app_id: appId, user_id: userId, device_id_hash: deviceIdHash });
    }
    // TODO(规划/11 §2.3): sessions.login_method='sms' — blocked on the sessions.login_method column (04 §3.2, not in db/schema.sql yet)
    const session = await createSession(
      trx,
      { uid: userId, app_id: appId, device_id: deviceId, scp: scope },
      { clock, tokens },
    );
    const issuedSeconds = Math.floor(now.getTime() / 1000);
    return {
      session_scope: session.session_scope,
      access_token: session.access_token,
      access_expires_at: instantAt(
        now,
        (issuedSeconds + ACCESS_TOKEN_TTL_SECONDS) * 1000,
      ).toISOString(),
      refresh_token: session.refresh_token,
      refresh_expires_at: instantAt(now, now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
    };
  }

  /** Step 4: the branch of the account lookup, then signIn. Throws LoginAbort to roll back. */
  async function inTransaction(
    trx: Transaction<DB>,
    command: SmsLoginCommand,
    phone: string,
    phoneHmac: string,
    inviteCode: string | undefined,
    scope: SessionScope,
  ): Promise<Signed> {
    const appId = command.app_id;
    const existing = await findAccountByPhone(trx, appId, phoneHmac);
    const ignored = inviteCode === undefined ? {} : { invite_bind: IGNORED_EXISTING_USER };
    if (existing !== undefined) {
      return {
        user_id: existing.id,
        is_new_user: false,
        ...ignored,
        tokens: await signIn(trx, command, existing, scope),
      };
    }
    // BR-ID-01 受限登录: no account is created, bound or merged.
    if (scope === 'deletion_only') throw new LoginAbort('no_account');
    const blocklist = options.phoneBlocklist;
    if (blocklist !== undefined) {
      const blocked = await blocklist(trx, { app_id: appId, phone_hmac: phoneHmac });
      if (blocked !== null) throw new LoginAbort(blocked);
    }
    const deviceHash = await deviceHashOf(trx, appId, command.device_id);
    if (deviceHash === undefined) {
      throw new Error('identity: an SMS login needs the device row of the verified device');
    }
    const registered = await registration.register(trx, {
      app_id: appId,
      phone,
      register_method: 'sms',
      ...(command.channel === undefined ? {} : { channel: command.channel }),
      device_hash: deviceHash,
      device_id: command.device_id,
      ...(inviteCode === undefined ? {} : { invite_code: inviteCode }),
      client_ip: command.client_ip,
    });
    if ('outcome' in registered) {
      // BR-ID-04 细则「并发的首次登录」: the earlier request created the account; log it in.
      const winner = await findAccountByPhone(trx, appId, phoneHmac);
      if (winner === undefined) {
        throw new Error('identity: phone_taken without a visible account');
      }
      logger.info({ app_id: appId }, 'sms_login_concurrent_first_login');
      return {
        user_id: winner.id,
        is_new_user: false,
        ...ignored,
        tokens: await signIn(trx, command, winner, scope),
      };
    }
    if (registered.code === 44001) throw new LoginAbort({ code: 44001 });
    if (registered.code !== 0) throw new LoginAbort({ code: 50001 });
    const account: LoginAccount = { id: registered.user_id, parent_bind_source: null };
    return {
      user_id: registered.user_id,
      is_new_user: true,
      ...(registered.invite_bind === undefined ? {} : { invite_bind: registered.invite_bind }),
      tokens: await signIn(trx, command, account, scope),
    };
  }

  return {
    async login(command) {
      const appId = command.app_id;
      const scope = await sessionScope(
        {
          appId,
          platform: command.platform,
          ...(command.channel === undefined ? {} : { channel: command.channel }),
          ...(command.version === undefined ? {} : { version: command.version }),
        },
        versions,
      );
      const normalized = normalize_phone(command.body.phone);
      if (normalized.code !== 0) {
        return { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } };
      }
      const phone = normalized.phone;
      const verified = await sms.verifyAndConsume({
        app_id: appId,
        phone,
        purpose: 'login',
        code: command.body.code,
      });
      if (verified.code !== 0) return { code: verified.code };
      const phoneHmac = crypto.blindIndex(phone, PHONE_BLIND_INDEX_CONTEXT);
      const inviteCode = normalizeInviteCode(command.body.invite_code);
      let signed: Signed;
      try {
        signed = await db
          .transaction()
          .setIsolationLevel('read committed')
          .execute((trx) => inTransaction(trx, command, phone, phoneHmac, inviteCode, scope));
      } catch (error) {
        if (!(error instanceof LoginAbort)) throw error;
        if (error.result !== 'no_account') {
          logger.info({ app_id: appId, code: error.result.code }, 'sms_login_refused');
          return error.result;
        }
        // The minimum as it is now (null once removed), read after the rollback.
        const minimum =
          command.channel === undefined
            ? null
            : await versions.minSupportedVersion(appId, command.platform, command.channel);
        logger.info({ app_id: appId, code: 10405 }, 'sms_login_restricted_no_account');
        return { code: 10405, data: { reason: 'no_account', min_supported_version: minimum } };
      }
      logger.info(
        {
          app_id: appId,
          user_id: signed.user_id,
          is_new_user: signed.is_new_user,
          session_scope: signed.tokens.session_scope,
        },
        'sms_login_succeeded',
      );
      return {
        code: 0,
        data: {
          user_id: signed.user_id,
          is_new_user: signed.is_new_user,
          tokens: signed.tokens,
          ...(signed.invite_bind === undefined ? {} : { invite_bind: signed.invite_bind }),
        },
      };
    },
  };
}
