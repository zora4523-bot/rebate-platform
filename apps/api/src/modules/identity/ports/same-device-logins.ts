// Identity's side of BR-ID-37 同设备多账号 (task B1-03k §9.2): risk's SameDeviceLoginReader port over
// login_logs, users and user_oauth (identity's tables). For every device_hash the subject logged
// into inside [window_start, window_end] (both closed; rows without a device_hash take no part),
// one row per account on that device: its first login inside the window (earliest created_at,
// then the lowest login_logs id), with the account's status, deleted_reason and, for a merge
// source, the merge target (user_oauth.user_id where merged_from_user_id is the account; the
// earliest such row). Only successful logins are in login_logs, so no method is filtered.
// Reads only through the handle given (the caller's transaction); nothing is written.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import { sql } from 'kysely';
import type { SameDeviceFirstLogin, SameDeviceLoginReader } from '../../risk/index.ts';

interface FirstLoginRow {
  readonly device_hash: string;
  readonly user_id: string;
  readonly first_login_at: Date;
  readonly login_log_id: bigint | string;
  readonly status: string;
  readonly deleted_reason: string | null;
  readonly merged_into_user_id: string | null;
}

/** Query only through the handle passed to read(); identity owns login_logs and merge metadata. */
export function createSameDeviceLoginReader(): SameDeviceLoginReader {
  return {
    async read(handle, input) {
      const { app_id: appId, user_id: userId, window_start: start, window_end: end } = input;
      const result = await sql<FirstLoginRow>`
        WITH subject_devices AS (
          SELECT DISTINCT device_hash
          FROM app.login_logs
          WHERE app_id = ${appId}
            AND user_id = ${userId}
            AND device_hash IS NOT NULL
            AND created_at >= ${start}
            AND created_at <= ${end}
        ),
        firsts AS (
          SELECT DISTINCT ON (l.device_hash, l.user_id)
            l.device_hash, l.user_id, l.created_at, l.id
          FROM app.login_logs l
          JOIN subject_devices d ON d.device_hash = l.device_hash
          WHERE l.app_id = ${appId}
            AND l.created_at >= ${start}
            AND l.created_at <= ${end}
          ORDER BY l.device_hash, l.user_id, l.created_at, l.id
        )
        SELECT
          f.device_hash,
          f.user_id,
          f.created_at AS first_login_at,
          f.id AS login_log_id,
          u.status,
          u.deleted_reason,
          (
            SELECT o.user_id
            FROM app.user_oauth o
            WHERE o.app_id = ${appId} AND o.merged_from_user_id = f.user_id
            ORDER BY o.created_at, o.id
            LIMIT 1
          ) AS merged_into_user_id
        FROM firsts f
        JOIN app.users u ON u.app_id = ${appId} AND u.id = f.user_id
        ORDER BY f.device_hash, f.created_at, f.id`.execute(handle);
      return result.rows.map((row): SameDeviceFirstLogin => ({
        device_hash: row.device_hash,
        user_id: row.user_id,
        first_login_at: row.first_login_at,
        login_log_id: BigInt(row.login_log_id),
        status: row.status,
        deleted_reason: row.deleted_reason,
        merged_into_user_id: row.merged_into_user_id,
      }));
    },
  };
}
