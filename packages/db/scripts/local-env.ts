// Connection settings of the local stack (infra/local/compose.yaml, conventions C7).
// Local only: staging and prod get their URLs from the environment, never from here.
import { pgUrl } from '../src/pg-url.ts';
import type { DbRole } from '../src/testing/provision.ts';

export const LOCAL_PG_HOST = '127.0.0.1';
export const LOCAL_PG_PORT = 54329;
export const LOCAL_REDIS_PORT = 63790;
/** Database that holds the application schema in every environment. */
export const APP_DATABASE = 'couli';

/** Local-only password shared by the superuser and the five roles of the dev stack. */
export function localPassword(): string {
  const value = process.env['COULI_DB_LOCAL_PASSWORD'];
  return value === undefined || value === '' ? 'couli_local' : value;
}

export function localAdminUrl(): string {
  return pgUrl(`postgres://postgres@${LOCAL_PG_HOST}:${String(LOCAL_PG_PORT)}/postgres`, {
    password: localPassword(),
  });
}

export function localRoleUrl(role: DbRole): string {
  return pgUrl(`postgres://${role}@${LOCAL_PG_HOST}:${String(LOCAL_PG_PORT)}/${APP_DATABASE}`, {
    password: localPassword(),
  });
}
