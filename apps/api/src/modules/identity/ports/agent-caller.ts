// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports. Read-only; logs nothing (no phone number or raw device ID can leak).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface AgentCallerReader {
  /** BR-AI-12 / B1-02x: current phone_hmac IS NOT NULL; absent or foreign user => false. */
  phoneBound(appId: string, userId: string): Promise<boolean>;
  /** B1-02x: stored device_hash; absent, foreign or revoked device => null. */
  deviceHash(appId: string, deviceId: string): Promise<string | null>;
}

export interface AgentCallerReaderOptions {
  readonly db: Kysely<DB>;
}

/**
 * Read-only, uncached caller context for the stream entry (BR-AI-12 / B1-02x §9).
 * Device identity follows infra/login-accounts.ts deviceHashOf and SMS risk: devices.device_hash,
 * also copied into login_logs.device_hash and device_registrations.device_hash. Guest devices
 * need no user or registration record. LOGIN_LOGS_DEVICE_ID_CONTEXT hashes the separate
 * login_logs.device_id_hash field; do not hash the device ID or rehash the stored device_hash.
 * This port additionally excludes revoked devices as required by B1-02x §9.
 */
export function createAgentCallerReader(options: AgentCallerReaderOptions): AgentCallerReader {
  const { db } = options;
  return {
    async phoneBound(appId, userId) {
      const row = await db
        .selectFrom('users')
        .select('phone_hmac')
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .executeTakeFirst();
      return row !== undefined && row.phone_hmac !== null;
    },
    async deviceHash(appId, deviceId) {
      const row = await db
        .selectFrom('devices')
        .select('device_hash')
        .where('app_id', '=', appId)
        .where('id', '=', deviceId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return row?.device_hash ?? null;
    },
  };
}
