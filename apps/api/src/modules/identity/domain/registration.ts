// Account creation rules (规划/08 BR-ID-04, BR-ID-05 细则「同设备注册上限的计数」, BR-INV-01,
// BR-INV-14, BR-ATTR-06; 规划/04 §3.2 users, device_registrations). Pure TypeScript: no Nest, no
// data access, no randomness, no clock reads (the caller passes the instant).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import { user_level, type UserLevel } from '@couli/contracts-ts';

/** Field-encryption context of users.phone_cipher (ruling §9.5 #6). */
export const PHONE_CIPHER_CONTEXT = 'users.phone';
/**
 * Blind-index context of users.phone_hmac (ruling §9.5 #6). risk needs the same value for its
 * phone blocklist; it cannot import identity, so B1-03d moves the constant to platform then.
 */
export const PHONE_BLIND_INDEX_CONTEXT = 'users.phone';
/** users.avatar of a new account: the default-avatar identifier (MVP has only it, OPS-13). */
export const DEFAULT_AVATAR = 'avatar:default';
/** Default nickname: this prefix + the last 4 characters of the user id (BR-ID-04 细则). */
export const DEFAULT_NICKNAME_PREFIX = '用户';

/** BR-INV-01: 32 characters without 0 / O / 1 / I, length 6, at most 5 candidates per account. */
export const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const INVITE_CODE_LENGTH = 6;
export const INVITE_CODE_CANDIDATES = 5;
/** BR-ATTR-06: 8 characters of [0-9a-z]; the retry bound is the agent's choice (ruling §9.3 #4). */
export const ATTR_CODE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export const ATTR_CODE_LENGTH = 8;
export const ATTR_CODE_CANDIDATES = 5;

/** BR-ID-05: the same-device limit counts registrations of the sliding 30×24 hours. */
export const DEVICE_REGISTER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Configuration keys read at registration, with the 08 defaults used when one is missing. */
export const MERGE_TOMBSTONE_DEDUPE_KEY = 'risk.merge_tombstone_dedupe';
export const DEFAULT_MERGE_TOMBSTONE_DEDUPE = true;
export const DEVICE_REGISTER_LIMIT_KEY = 'risk.device_register_limit';
export const DEFAULT_DEVICE_REGISTER_LIMIT = 3;
export const DEFAULT_LEVEL_KEY = 'level.default';
export const DEFAULT_USER_LEVEL: UserLevel = 'L1';

/** users.register_method (BR-ID-04 细则). */
export const REGISTER_METHODS = [
  'sms',
  'wechat',
  'apple',
  'huawei',
  'h5_landing',
  'admin',
] as const;
export type RegisterMethod = (typeof REGISTER_METHODS)[number];
/**
 * Methods of the app (SMS login, third-party first login): the account is created on a device, so
 * the caller is expected to pass the device_hash of its device row and the same-device limit
 * applies. The landing page (h5_landing) and admin have no device.
 */
export const DEVICE_REGISTER_METHODS: ReadonlySet<RegisterMethod> = new Set([
  'sms',
  'wechat',
  'apple',
  'huawei',
]);
/** Methods whose sign-up is the phone number itself: a phone is required. */
export const PHONE_REGISTER_METHODS: ReadonlySet<RegisterMethod> = new Set(['sms', 'h5_landing']);

const INVITE_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
const ATTR_CODE = /^[0-9a-z]{8}$/;

export function isInviteCode(value: unknown): value is string {
  return typeof value === 'string' && INVITE_CODE.test(value);
}

export function isAttrCode(value: unknown): value is string {
  return typeof value === 'string' && ATTR_CODE.test(value);
}

export function isRegisterMethod(value: unknown): value is RegisterMethod {
  return (REGISTER_METHODS as readonly unknown[]).includes(value);
}

/** «用户» + the last 4 characters of the lower-case canonical UUID (ruling §9.5 #9). */
export function defaultNickname(userId: string): string {
  return DEFAULT_NICKNAME_PREFIX + userId.toLowerCase().slice(-4);
}

/** risk.merge_tombstone_dedupe: a JSON boolean; anything else is refused (null). */
export function parseMergeTombstoneDedupe(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** risk.device_register_limit: a positive integer; anything else is refused (null). */
export function parseDeviceRegisterLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** level.default: one of the user_level values; anything else is refused (null). */
export function parseDefaultLevel(value: unknown): UserLevel | null {
  return (user_level as readonly unknown[]).includes(value) ? (value as UserLevel) : null;
}

/** One registration source record (device_registrations) as the count needs it. */
export interface DeviceRegistrationRecord {
  readonly app_id: string;
  readonly device_hash: string;
  readonly user_id: string;
  readonly created_at: Date;
  readonly merged_into_user_id: string | null;
}

/**
 * The same-device count of BR-ID-05 细则「同设备注册上限的计数」 at `now` (the injected Clock):
 * the records of this app and device_hash with created_at > now − 30×24 h: the lower bound is
 * open (a record leaves the window once now − window reaches it) and there is no upper bound (a
 * record newer than `now` still counts). Tombstones of deletion, banning and merging count like any record.
 * With `mergeTombstoneDedupe` on, a merge source whose target's record is also among those
 * records is not counted (the pair counts once, through the target); several sources merged into
 * the same such target all go with it. A source whose target registered elsewhere, or whose
 * target's record has left the window, counts as usual.
 */
export function countDeviceRegistrations(
  records: readonly DeviceRegistrationRecord[],
  scope: { readonly app_id: string; readonly device_hash: string },
  now: Date,
  mergeTombstoneDedupe: boolean,
): number {
  const since = now.getTime() - DEVICE_REGISTER_WINDOW_MS;
  const inWindow = records.filter(
    (record) =>
      record.app_id === scope.app_id &&
      record.device_hash === scope.device_hash &&
      record.created_at.getTime() > since,
  );
  if (!mergeTombstoneDedupe) return inWindow.length;
  const present = new Set(inWindow.map((record) => record.user_id));
  return inWindow.filter((record) => {
    const target = record.merged_into_user_id;
    return target === null || target === record.user_id || !present.has(target);
  }).length;
}

/**
 * Words of a sensitive-word list file: one word per line, surrounding whitespace trimmed, blank
 * lines and lines starting with `#` ignored.
 */
export function parseSensitiveWordList(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Case-insensitive substring match of a candidate against the words (BR-INV-01). */
export function createSensitiveWordMatcher(
  words: readonly string[],
): (candidate: string) => boolean {
  const upper = words.map((word) => word.toUpperCase()).filter((word) => word.length > 0);
  return (candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    const text = candidate.toUpperCase();
    return upper.some((word) => text.includes(word));
  };
}
