// Pure rules of a login (规划/08 BR-ID-04, BR-ID-12 login_merge, BR-INV-02 邀请码规范化, BR-INV-06):
// no Nest, no data access, no clock reads (the caller passes the instant).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.

/** Blind-index context of login_logs.device_id_hash (orchestrator ruling B1-02j §9.2). */
export const LOGIN_LOGS_DEVICE_ID_CONTEXT = 'login_logs.device_id';

/** login_logs.method of an SMS login (04 §3.2). */
export const SMS_LOGIN_METHOD = 'sms';

/** consent_records.channel of the two records written by a login page (BR-ID-04). */
export const LOGIN_PAGE_CHANNEL = 'login_page';
/** consent_records.channel of a device-level record copied to the user at login (BR-ID-12). */
export const LOGIN_MERGE_CHANNEL = 'login_merge';
/** The two consent types a login page records, in insertion order (BR-ID-04). */
export const LOGIN_PAGE_TYPES = Object.freeze(['privacy', 'agreement'] as const);
/**
 * Types that never take part in login_merge (BR-ID-12): ai_third_party is consented again by
 * user_id (BR-AI-13, C-23); labor_agreement only has user-level records (BR-WDR-31).
 */
export const LOGIN_MERGE_EXCLUDED_TYPES: ReadonlySet<string> = new Set([
  'ai_third_party',
  'labor_agreement',
]);

const INVITE_REMOVED = /[\s\u200B-\u200D\uFEFF]/gu;

/**
 * BR-INV-02 【规范化】: NFKC → remove every Unicode whitespace and the zero-width characters
 * U+200B–U+200D, U+FEFF → upper case. An empty result (or no code) means none was sent: undefined.
 * No format check here (the binding port does it, BR-INV-02 order).
 */
export function normalizeInviteCode(input: string | undefined): string | undefined {
  if (typeof input !== 'string') return undefined;
  const text = input.normalize('NFKC').replace(INVITE_REMOVED, '').toUpperCase();
  return text === '' ? undefined : text;
}

/** One consent record as far as login_merge reads it. */
export interface ConsentState {
  readonly id: bigint | number | string;
  readonly type: string;
  readonly version: number;
  readonly accepted: boolean;
  readonly client_at: Date;
  readonly server_at: Date;
}

function idOrder(a: ConsentState['id'], b: ConsentState['id']): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * The current state of each type (BR-ID-12): the record with the latest server_at; equal
 * server_at → the later inserted one (larger id), the order an insert-only table gives them.
 */
export function currentStates<T extends ConsentState>(records: readonly T[]): Map<string, T> {
  const current = new Map<string, T>();
  for (const record of records) {
    const held = current.get(record.type);
    if (held === undefined) {
      current.set(record.type, record);
      continue;
    }
    const byTime = record.server_at.getTime() - held.server_at.getTime();
    if (byTime > 0 || (byTime === 0 && idOrder(record.id, held.id) > 0)) {
      current.set(record.type, record);
    }
  }
  return current;
}

/**
 * The device-level current states login_merge copies to the user (BR-ID-12): the user has no
 * record of the type, or the device's version is higher, or the versions are equal and the
 * device's server_at is later. Excluded types never take part.
 */
export function loginMergeCopies<T extends ConsentState>(
  deviceRecords: readonly T[],
  userRecords: readonly ConsentState[],
): T[] {
  const user = currentStates(userRecords);
  const copies: T[] = [];
  for (const device of currentStates(deviceRecords).values()) {
    if (LOGIN_MERGE_EXCLUDED_TYPES.has(device.type)) continue;
    const held = user.get(device.type);
    if (
      held === undefined ||
      device.version > held.version ||
      (device.version === held.version && device.server_at.getTime() > held.server_at.getTime())
    ) {
      copies.push(device);
    }
  }
  return copies.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}
