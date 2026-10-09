// BR-ID-37 同设备多账号: the ranking of one subject on every device it logged into inside the
// window, from identity's first-login rows (task B1-03k §9.2). Pure: no clock, no I/O.
//
// Per device_hash, each account is ranked by its first successful login inside the window; ties
// on the instant break on the login_logs id (orchestrator ruling). With the merge tombstone dedupe
// on, an account with status 'deleted' and deleted_reason 'merged' whose merge target also has a
// row on the same device (same window, since every row given is inside it) is not counted: the
// target stands for it, and the target's key is the earlier of its own and the source's
// (instant, id). Each device is judged on its own. A target that is itself a merged tombstone
// present on the device hands on further (cycles stop where they close).
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only.

export interface SameDeviceLoginRow {
  readonly device_hash: string;
  readonly user_id: string;
  readonly first_login_at: Date;
  readonly login_log_id: bigint;
  readonly status: string;
  readonly deleted_reason: string | null;
  readonly merged_into_user_id: string | null;
}

export interface SameDeviceRank {
  readonly device_hash: string;
  readonly rank: number;
}

interface Key {
  readonly at: number;
  readonly id: bigint;
}

function earlier(a: Key, b: Key): boolean {
  return a.at < b.at || (a.at === b.at && a.id < b.id);
}

function isMergedTombstone(row: SameDeviceLoginRow): boolean {
  return row.status === 'deleted' && row.deleted_reason === 'merged';
}

/** The account that stands for `user` on one device (itself unless absorbed by a target). */
function representative(
  user: string,
  rows: ReadonlyMap<string, SameDeviceLoginRow>,
  dedupe: boolean,
): string {
  if (!dedupe) return user;
  const seen = new Set<string>([user]);
  let current = user;
  for (;;) {
    const row = rows.get(current);
    if (row === undefined || !isMergedTombstone(row)) return current;
    const target = row.merged_into_user_id;
    if (target === null || seen.has(target) || !rows.has(target)) return current;
    seen.add(target);
    current = target;
  }
}

/** Ranks (1-based) of `subject` on each device it takes part in, sorted by device_hash. */
export function rankSameDeviceAccounts(
  rows: readonly SameDeviceLoginRow[],
  subject: string,
  dedupe: boolean,
): SameDeviceRank[] {
  const byDevice = new Map<string, Map<string, SameDeviceLoginRow>>();
  for (const row of rows) {
    let device = byDevice.get(row.device_hash);
    if (device === undefined) {
      device = new Map();
      byDevice.set(row.device_hash, device);
    }
    const known = device.get(row.user_id);
    if (
      known === undefined ||
      earlier(
        { at: row.first_login_at.getTime(), id: row.login_log_id },
        { at: known.first_login_at.getTime(), id: known.login_log_id },
      )
    ) {
      device.set(row.user_id, row);
    }
  }
  const ranks: SameDeviceRank[] = [];
  for (const [deviceHash, device] of byDevice) {
    if (!device.has(subject)) continue;
    const keys = new Map<string, Key>();
    for (const [user, row] of device) {
      const rep = representative(user, device, dedupe);
      const key = { at: row.first_login_at.getTime(), id: row.login_log_id };
      const held = keys.get(rep);
      if (held === undefined || earlier(key, held)) keys.set(rep, key);
    }
    if (!keys.has(subject)) continue;
    const ordered = [...keys].sort(([, a], [, b]) => (earlier(a, b) ? -1 : earlier(b, a) ? 1 : 0));
    const rank = ordered.findIndex(([user]) => user === subject) + 1;
    ranks.push({ device_hash: deviceHash, rank });
  }
  return ranks.sort((a, b) =>
    a.device_hash < b.device_hash ? -1 : a.device_hash > b.device_hash ? 1 : 0,
  );
}

/** BR-ID-37 risk.device_login_accounts_limit: a safe positive integer, else null. */
export function parseAccountsLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** risk.merge_tombstone_dedupe: only a JSON boolean, else null. */
export function parseDedupe(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
