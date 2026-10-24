// Admin console login use cases (F1-06k; 08 BR-ID-34 and its rules 「首次登录强制改密码」「首次绑定
// 身份验证器」; contract operations adminLogin, adminChangeInitialPassword,
// adminGetTotpBindingSecret, adminBindTotp, adminVerifyTotp, adminLogout; ruling §9.2).
//
// Flow:
//   login(username, password) → a 5-minute ticket for the next step: change_password while the
//     account is on its initial password, else bind_totp while no authenticator is bound (a fresh
//     secret is generated and kept, encrypted, in the ticket), else totp. No admin_token.
//   changeInitialPassword(ticket, new) → replaces the initial password, consumes the ticket and
//     returns a new ticket for the next step (bind_totp for a new account).
//   bindingSecret(ticket) → the pending secret and its otpauth URI (the ticket stays).
//   bindTotp(ticket, code) / verifyTotp(ticket, code) → the admin_token (login complete).
//   logout(principal) → revokes the session.
// Failures: unknown account and wrong password are one answer (10008, a password hash is compared
// for an unknown account too); wrong password, wrong login code and wrong binding code share the
// consecutive-failure counter (5 → locked 30 minutes; the 5th failure itself answers 10009); a
// locked account gets 10009 with locked_until at every step, the right password included; a
// ticket that is expired, used, invalid or for another step is 10001 login_ticket_expired. A
// wrong code, a rejected new password or a lock keeps the ticket usable (restored with its
// original expiry); success consumes it. Login, lock, password change, binding and logout are
// audited (no password, secret, code, ticket or token in any audit row).
// B1-34h: a ticket also stands for the account as read when it was issued — issued before the
// account's voiding instant (disable, authenticator reset, initial password regeneration; the
// issue instant is taken before the account read) or on another row_version than the account now
// has, it is 10001 login_ticket_expired; the login writes are conditional on that row_version,
// and a void that lands right after the final write revokes the new session again.
// B1-34n: binding the authenticator also records a voiding instant (the open instant rounded down
// to the whole second), so a session issued around a reset never passes again after the rebind.
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import type { Clock, FieldCrypto } from '../../platform/index.ts';
// Imported bindings (not copies): the password functions stay those of F1-06c's module.
import {
  encodeBase32,
  generateAdminTotpSecret,
  hashAdminPassword,
  otpauthUri,
  verifyAdminPassword,
} from './bootstrap.ts';
import {
  ADMIN_IDLE_TIMEOUT_SEC,
  ADMIN_TICKET_TTL_MS,
  isLocked,
  later,
  newPasswordShapeOk,
  nextLoginStep,
  type AdminLoginStep,
} from '../domain/login-policy.ts';
import { totpSecretContext, type TotpVerifier } from '../domain/totp.ts';
import type { AccountAudit, AdminAccount, AdminAccounts } from '../infra/admin-accounts.ts';
import { issuedBeforeVoid, type AdminRevocations } from '../infra/admin-revocations.ts';
import type { AdminSessions } from '../infra/admin-sessions.ts';
import type { LoginTickets, TakenTicket, TicketRecord } from '../infra/login-tickets.ts';
import type { AdminTokens } from './admin-tokens.ts';

/** admin_users.status of an account that may sign in (trusted configuration, as in F1-06c). */
export const ADMIN_ACTIVE_STATUS = 'active';

/** Audit actions of this flow (one per event; ruling §9.2 #8). */
export const ADMIN_AUTH_AUDIT = Object.freeze({
  login: 'admin.login',
  locked: 'admin.login_locked',
  passwordChanged: 'admin.initial_password_changed',
  totpBound: 'admin.totp_bound',
  logout: 'admin.logout',
});

export type AdminAuthFailure =
  | { readonly code: 10001 }
  | { readonly code: 10008 }
  | { readonly code: 10009; readonly lockedUntil: Date }
  | { readonly code: 20001 }
  | { readonly code: 20002; readonly reason: 'totp_invalid' | 'totp_bind_invalid' };

export interface LoginStepResult {
  readonly code: 0;
  readonly next: AdminLoginStep;
  readonly ticket: string;
  readonly expiresAt: Date;
}

export interface SessionResult {
  readonly code: 0;
  readonly token: string;
  readonly expiresAt: Date;
  readonly idleTimeoutSec: number;
}

export interface BindingSecretResult {
  readonly code: 0;
  readonly secret: string;
  readonly otpauthUri: string;
}

export interface AdminAuthService {
  login(input: {
    username: string;
    password: string;
    ip: string | null;
  }): Promise<LoginStepResult | AdminAuthFailure>;
  changeInitialPassword(input: {
    ticket: string;
    newPassword: string;
    ip: string | null;
  }): Promise<LoginStepResult | AdminAuthFailure>;
  bindingSecret(input: { ticket: string }): Promise<BindingSecretResult | AdminAuthFailure>;
  bindTotp(input: {
    ticket: string;
    code: string;
    ip: string | null;
  }): Promise<SessionResult | AdminAuthFailure>;
  verifyTotp(input: {
    ticket: string;
    code: string;
    ip: string | null;
  }): Promise<SessionResult | AdminAuthFailure>;
  logout(input: {
    adminId: string;
    appId: string;
    sessionId: string;
    ip: string | null;
  }): Promise<void>;
}

export interface AdminAuthDeps {
  readonly clock: Clock;
  readonly accounts: AdminAccounts;
  readonly tickets: LoginTickets;
  readonly sessions: AdminSessions;
  readonly tokens: AdminTokens;
  /** F1-06b verifier with the durable replay store (admin_users.totp_last_step). */
  readonly totp: TotpVerifier;
  /** Field cipher of the pending and bound TOTP secrets (BR-ID-33). */
  readonly crypto: Pick<FieldCrypto, 'encrypt' | 'decrypt'>;
  /** Issuer shown by authenticator apps (F1-06c: 「Couli Admin」, environment appended off prod). */
  readonly issuer: string;
  /**
   * B1-34h: the per-account voiding instant (disable, authenticator reset, initial password
   * regeneration); a ticket issued before it is 10001 login_ticket_expired. The admin entry always
   * passes it; absent (unit tests of the login flow alone) no ticket is voided this way.
   */
  readonly revocations?: AdminRevocations;
}

const EXPIRED: AdminAuthFailure = Object.freeze({ code: 10001 });
const WRONG_PASSWORD: AdminAuthFailure = Object.freeze({ code: 10008 });
const REJECTED_PASSWORD: AdminAuthFailure = Object.freeze({ code: 20001 });
const locked = (lockedUntil: Date): AdminAuthFailure => ({ code: 10009, lockedUntil });

const target = (account: AdminAccount): string => `admin_users:${account.id}`;

export function createAdminAuthService(deps: AdminAuthDeps): AdminAuthService {
  const { clock, accounts, tickets, sessions, tokens, totp, crypto } = deps;

  // A password hash of the production format, compared for unknown accounts so that they cost
  // the same as known ones (one answer, 10008). Made once per process, on first use.
  let decoy: Promise<string> | undefined;
  const decoyHash = (): Promise<string> => {
    decoy ??= hashAdminPassword(encodeBase32(generateAdminTotpSecret()));
    return decoy;
  };

  const lockAudit = (account: AdminAccount, ip: string | null, until: Date): AccountAudit => ({
    action: ADMIN_AUTH_AUDIT.locked,
    target: target(account),
    before: null,
    after: { locked_until: until.toISOString() },
    ip,
  });
  const loginAudit = (account: AdminAccount, ip: string | null, via: string): AccountAudit => ({
    action: ADMIN_AUTH_AUDIT.login,
    target: target(account),
    before: null,
    after: { via },
    ip,
  });

  /** A failure that counts towards the lock; null when it only counted. */
  const countFailure = async (
    account: AdminAccount,
    ip: string | null,
  ): Promise<AdminAuthFailure | null> => {
    const outcome = await accounts.recordFailure(account, (until) => lockAudit(account, ip, until));
    if (outcome.kind === 'locked' || outcome.kind === 'already_locked') {
      return locked(outcome.lockedUntil);
    }
    return null;
  };

  /**
   * Issues the ticket of the next step (a bind ticket carries a fresh, encrypted secret).
   * `issuedAtMs` is the Clock instant before `account` was read (B1-34h review r1 S1): a voiding
   * change committed after that read voids the ticket even when the ticket is stored later; the
   * ticket also carries the row_version it was issued on, which every later step requires.
   */
  const issueStep = async (
    account: AdminAccount,
    next: AdminLoginStep,
    issuedAtMs: number,
  ): Promise<LoginStepResult> => {
    const expiresAt = later(clock.now(), ADMIN_TICKET_TTL_MS);
    let secretCipher: string | undefined;
    if (next === 'bind_totp') {
      const raw = Buffer.from(generateAdminTotpSecret());
      try {
        secretCipher = crypto.encrypt(
          encodeBase32(raw),
          totpSecretContext({ appId: account.appId, adminId: account.id }),
        );
      } finally {
        raw.fill(0);
      }
    }
    const ticket = await tickets.issue(next, {
      adminId: account.id,
      appId: account.appId,
      expiresAtMs: expiresAt.getTime(),
      issuedAtMs,
      rowVersion: account.rowVersion,
      ...(secretCipher === undefined ? {} : { secretCipher }),
    });
    return { code: 0, next, ticket, expiresAt };
  };

  /**
   * Issues the admin_token. A voiding change whose instant falls after `openedAtMs` (the read the
   * login write was conditional on) may have committed just after that write: the session is then
   * revoked again and the step answers 10001 (B1-34h review r1 S1). A void written after this
   * check is later than the token's iat, so the request check refuses the token itself.
   */
  const issueSession = async (
    account: AdminAccount,
    openedAtMs: number,
  ): Promise<SessionResult | AdminAuthFailure> => {
    const { token, claims } = await tokens.issue({ adminId: account.id, appId: account.appId });
    const now = clock.now();
    const expiresAt = later(now, claims.expiresAt * 1000 - now.getTime());
    await sessions.create(claims.sessionId, {
      adminId: account.id,
      appId: account.appId,
      expiresAtMs: expiresAt.getTime(),
      lastSeenMs: now.getTime(),
    });
    if (await voidedSince(account, openedAtMs)) {
      await sessions.revoke(claims.sessionId);
      return EXPIRED;
    }
    return { code: 0, token, expiresAt, idleTimeoutSec: ADMIN_IDLE_TIMEOUT_SEC };
  };

  /** True when the account voided its credentials after `sinceMs` (B1-34h). */
  async function voidedSince(
    account: { readonly appId: string; readonly id: string },
    sinceMs: number,
  ): Promise<boolean> {
    if (deps.revocations === undefined) return false;
    const at = await deps.revocations.voidedAt({ appId: account.appId, adminId: account.id });
    return issuedBeforeVoid(sinceMs, at);
  }

  /**
   * The ticket no longer stands for `account` as just read: voided after it was issued, or the
   * account changed since (row_version; absent on a ticket from before B1-34h). Checked after the
   * account read, so a change committed between the two is caught by one or the other.
   */
  const stale = async (record: TicketRecord, account: AdminAccount): Promise<boolean> =>
    record.rowVersion !== account.rowVersion ||
    (await voidedSince(account, record.issuedAtMs ?? 0));

  /**
   * Takes the ticket for `step` and loads its account. Expired, missing, foreign-step tickets and
   * accounts that cannot continue are 10001 (the ticket is not put back); a locked account is
   * 10009 with the ticket put back.
   */
  const open = async (
    step: AdminLoginStep,
    ticket: string,
  ): Promise<
    { taken: TakenTicket; account: AdminAccount; openedAtMs: number } | AdminAuthFailure
  > => {
    const taken = await tickets.take(step, ticket);
    if (taken === undefined) return EXPIRED;
    const openedAtMs = clock.now().getTime();
    if (taken.record.expiresAtMs <= openedAtMs) return EXPIRED;
    const account = await accounts.byId(taken.record.appId, taken.record.adminId);
    if (account === undefined || account.status !== ADMIN_ACTIVE_STATUS) return EXPIRED;
    if (await stale(taken.record, account)) return EXPIRED;
    if (isLocked(account.lockedUntil, clock.now())) {
      await tickets.restore(taken);
      return locked(account.lockedUntil!);
    }
    return { taken, account, openedAtMs };
  };

  /** A wrong code: count it, keep the ticket usable, answer 20002 (or 10009 when it locked). */
  const wrongCode = async (
    taken: TakenTicket,
    account: AdminAccount,
    ip: string | null,
    reason: 'totp_invalid' | 'totp_bind_invalid',
  ): Promise<AdminAuthFailure> => {
    const lock = await countFailure(account, ip);
    await tickets.restore(taken);
    return lock ?? { code: 20002, reason };
  };

  /** A conditional write that matched nothing: locked (ticket kept) or no longer applicable. */
  const notWritten = async (
    taken: TakenTicket,
    outcome: { kind: 'locked'; lockedUntil: Date } | { kind: 'conflict' },
  ): Promise<AdminAuthFailure> => {
    if (outcome.kind === 'conflict') return EXPIRED;
    await tickets.restore(taken);
    return locked(outcome.lockedUntil);
  };

  return {
    async login({ username, password, ip }) {
      const readAtMs = clock.now().getTime();
      const account = await accounts.byLoginName(username);
      if (account === undefined) {
        await verifyAdminPassword(password, await decoyHash());
        return WRONG_PASSWORD;
      }
      if (isLocked(account.lockedUntil, clock.now())) return locked(account.lockedUntil!);
      const matches = await verifyAdminPassword(password, account.passwordHash);
      if (account.status !== ADMIN_ACTIVE_STATUS) return WRONG_PASSWORD;
      if (!matches) return (await countFailure(account, ip)) ?? WRONG_PASSWORD;
      return await issueStep(
        account,
        nextLoginStep({
          passwordMustChange: account.passwordMustChange,
          totpBound: account.totpBoundAt !== null && account.totpSecretCipher !== null,
        }),
        readAtMs,
      );
    },

    async changeInitialPassword({ ticket, newPassword, ip }) {
      const opened = await open('change_password', ticket);
      if ('code' in opened) return opened;
      const { taken, account, openedAtMs } = opened;
      if (!account.passwordMustChange) return EXPIRED;
      if (
        !newPasswordShapeOk(newPassword, account.loginName) ||
        (await verifyAdminPassword(newPassword, account.passwordHash))
      ) {
        await tickets.restore(taken);
        return REJECTED_PASSWORD;
      }
      const hash = await hashAdminPassword(newPassword);
      const outcome = await accounts.changeInitialPassword(account, hash, {
        action: ADMIN_AUTH_AUDIT.passwordChanged,
        target: target(account),
        before: { must_change: true },
        after: { must_change: false },
        ip,
      });
      if (outcome.kind !== 'written') return await notWritten(taken, outcome);
      return await issueStep(
        account,
        nextLoginStep({
          passwordMustChange: false,
          totpBound: account.totpBoundAt !== null && account.totpSecretCipher !== null,
        }),
        // The password change does not move row_version: the next ticket stands on the same read.
        openedAtMs,
      );
    },

    async bindingSecret({ ticket }) {
      const record = await tickets.peek('bind_totp', ticket);
      if (record === undefined || record.secretCipher === undefined) return EXPIRED;
      if (record.expiresAtMs <= clock.now().getTime()) return EXPIRED;
      const account = await accounts.byId(record.appId, record.adminId);
      if (
        account === undefined ||
        account.status !== ADMIN_ACTIVE_STATUS ||
        account.passwordMustChange ||
        account.totpBoundAt !== null ||
        (await stale(record, account))
      ) {
        return EXPIRED;
      }
      if (isLocked(account.lockedUntil, clock.now())) return locked(account.lockedUntil!);
      const secret = crypto.decrypt(
        record.secretCipher,
        totpSecretContext({ appId: account.appId, adminId: account.id }),
      );
      return { code: 0, secret, otpauthUri: otpauthUri(deps.issuer, account.loginName, secret) };
    },

    async bindTotp({ ticket, code, ip }) {
      const opened = await open('bind_totp', ticket);
      if ('code' in opened) return opened;
      const { taken, account, openedAtMs } = opened;
      const cipher = taken.record.secretCipher;
      if (cipher === undefined || account.passwordMustChange || account.totpBoundAt !== null) {
        return EXPIRED;
      }
      const secretCipher = Buffer.from(cipher, 'utf8');
      const ok = await totp.verify({
        appId: account.appId,
        adminId: account.id,
        secretCipher,
        code,
      });
      if (!ok) return await wrongCode(taken, account, ip, 'totp_bind_invalid');
      // B1-34n: the binding voids what the account was issued before it (a session of a login
      // that interleaved with the authenticator reset, refused so far only for the missing
      // binding). Recorded before the bind write, so a failing Redis binds nothing (50001), at the
      // open instant rounded down to the whole second: this step's own check (issued from
      // openedAtMs on) and its admin_token (iat no earlier than that second) are not voided.
      await deps.revocations?.voidBefore(
        { appId: account.appId, adminId: account.id },
        Math.floor(openedAtMs / 1000) * 1000,
      );
      const outcome = await accounts.bindTotp(account, secretCipher, [
        {
          action: ADMIN_AUTH_AUDIT.totpBound,
          target: target(account),
          before: { totp_bound: false },
          after: { totp_bound: true },
          ip,
        },
        loginAudit(account, ip, 'bind_totp'),
      ]);
      if (outcome.kind !== 'written') return await notWritten(taken, outcome);
      return await issueSession(account, openedAtMs);
    },

    async verifyTotp({ ticket, code, ip }) {
      const opened = await open('totp', ticket);
      if ('code' in opened) return opened;
      const { taken, account, openedAtMs } = opened;
      if (account.totpSecretCipher === null || account.totpBoundAt === null) return EXPIRED;
      const ok = await totp.verify({
        appId: account.appId,
        adminId: account.id,
        secretCipher: account.totpSecretCipher,
        code,
      });
      if (!ok) return await wrongCode(taken, account, ip, 'totp_invalid');
      const outcome = await accounts.completeLogin(account, [loginAudit(account, ip, 'totp')]);
      if (outcome.kind !== 'written') return await notWritten(taken, outcome);
      return await issueSession(account, openedAtMs);
    },

    async logout({ adminId, appId, sessionId, ip }) {
      await sessions.revoke(sessionId);
      const account = await accounts.byId(appId, adminId);
      if (account === undefined) return;
      await accounts.appendAudit(account, {
        action: ADMIN_AUTH_AUDIT.logout,
        target: target(account),
        before: null,
        after: null,
        ip,
      });
    },
  };
}
