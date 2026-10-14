// Values and pure rules of the admin console login (08 BR-ID-34; orchestrator ruling F1-06k §9.2).
// Pure module (no decorators, erasable syntax, no I/O).
import { BlockList, isIP } from 'node:net';

/** `instant` plus `ms` as a new Date (the Clock's instant is never modified). */
export function later(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

/** Consecutive failures (wrong password, wrong login code, wrong binding code) that lock. */
export const ADMIN_LOCK_THRESHOLD = 5;
/** Lock duration (BR-ID-34: 30 minutes). */
export const ADMIN_LOCK_MS = 30 * 60 * 1000;
/** Lifetime of a login ticket (ruling §9.2 #2: 5 minutes). */
export const ADMIN_TICKET_TTL_MS = 5 * 60 * 1000;
/** Absolute lifetime of an admin_token (BR-ID-34: 8 hours). */
export const ADMIN_TOKEN_TTL_SEC = 8 * 60 * 60;
/** Idle timeout of an admin session (BR-ID-34: 30 minutes without a checked request). */
export const ADMIN_IDLE_TIMEOUT_SEC = 30 * 60;
/** Audience of every admin_token (02 §12.1). */
export const ADMIN_TOKEN_AUDIENCE = 'admin';
/** Issuer of every admin_token. */
export const ADMIN_TOKEN_ISSUER = 'couli-admin';

/** New password composition (ruling §9.2 #4; server-defined, BR-ID-34 fixes none). */
export const ADMIN_PASSWORD_MIN_LENGTH = 10;
export const ADMIN_PASSWORD_MAX_LENGTH = 128;

/** The steps a login ticket can be issued for (contract enum admin_login_step). */
export type AdminLoginStep = 'totp' | 'change_password' | 'bind_totp';

/** Account state the first step reads to choose the next step. */
export interface AdminStepState {
  readonly passwordMustChange: boolean;
  readonly totpBound: boolean;
}

/** Initial password first, then the binding, then the dynamic code (BR-ID-34 细则). */
export function nextLoginStep(state: AdminStepState): AdminLoginStep {
  if (state.passwordMustChange) return 'change_password';
  return state.totpBound ? 'totp' : 'bind_totp';
}

/** True while `lockedUntil` lies after `now` (a lock that has ended counts as none). */
export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

/**
 * Length and the account name only; «differs from the initial password» needs the stored hash and
 * is checked by the use case. Characters are counted as code points.
 */
export function newPasswordShapeOk(newPassword: string, loginName: string): boolean {
  const length = [...newPassword].length;
  return (
    length >= ADMIN_PASSWORD_MIN_LENGTH &&
    length <= ADMIN_PASSWORD_MAX_LENGTH &&
    newPassword !== loginName
  );
}

/** Loopback sources, the only ones allowed in local / test without ADMIN_IP_ALLOWLIST. */
const LOOPBACK = Object.freeze(['127.0.0.0/8', '::1']);

/**
 * The admin whitelist (BR-ID-34; 02 §12.5) over the validated ADMIN_IP_ALLOWLIST items, or the
 * loopback addresses when there is none. An IPv4-mapped IPv6 address is judged as its IPv4 form.
 */
export function createIpAllowlist(
  entries: readonly string[] | null,
): (ip: string | undefined) => boolean {
  const list = new BlockList();
  for (const entry of entries ?? LOOPBACK) {
    const slash = entry.indexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const type = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    if (slash === -1) list.addAddress(address, type);
    else list.addSubnet(address, Number(entry.slice(slash + 1)), type);
  }
  return (ip) => {
    if (typeof ip !== 'string') return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    const address = mapped === null ? ip : mapped[1]!;
    const family = isIP(address);
    if (family === 0) return false;
    return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };
}
