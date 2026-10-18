import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createUnionSyncAccess,
  type UnionEndpoint,
} from '../../../../apps/api/src/modules/union/index.ts';
import { capture } from '../attribution/kit.ts';

export const at = (iso: string) => new FixedClock(iso).now();
export const CREATED = '2026-09-01T01:02:03.000Z';
export const START = '2026-10-01T02:03:04.000Z';
export const BOUND = '2026-10-02T03:04:05.000Z';
export const RELEASED = '2026-10-03T04:05:06.000Z';
export const COOLDOWN = '2026-10-04T05:06:07.000Z';
export const NOW = '2026-10-17T17:30:00.000Z';
export const endpoint = (mode: UnionEndpoint['mode'] = 'demo'): UnionEndpoint => ({
  platform: 'pdd',
  mode,
  baseUrl: mode === 'demo' ? null : 'https://example.invalid',
  quotaKey: 'synthetic-pdd',
});

export async function built<T>(action: () => T | Promise<T>): Promise<T> {
  const result = await capture(action);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  return result.value;
}

export async function access(db: Kysely<DB>, mode: UnionEndpoint['mode'] = 'demo') {
  const logger = { error: vi.fn() };
  const port = await built(() =>
    createUnionSyncAccess({ db, endpoints: [endpoint(mode)], breaker: () => 'closed', logger }),
  );
  return { port, logger };
}

export async function account(
  db: Kysely<DB>,
  patch: Partial<Insertable<DB['union_accounts']>> = {},
) {
  const row = {
    id: randomUUID(),
    app_id: `wiring-${randomUUID()}`,
    platform: 'pdd',
    account_name: 'synthetic',
    status: 'pending',
    auth_status: 'active',
    sync_start_at: at(START),
    created_at: at(CREATED),
    updated_at: at(BOUND),
    ...patch,
  };
  await db.insertInto('union_accounts').values(row).execute();
  return row;
}

export async function user(
  db: Kysely<DB>,
  appId: string,
  patch: Partial<Insertable<DB['users']>> = {},
) {
  const row = {
    id: randomUUID(),
    app_id: appId,
    nickname: 'synthetic',
    avatar: '',
    invite_code: randomUUID().slice(0, 8),
    attr_code: 'abcd1234',
    level: 'member',
    status: 'normal',
    register_method: 'synthetic',
    created_at: at(CREATED),
    updated_at: at(BOUND),
    ...patch,
  };
  await db.insertInto('users').values(row).execute();
  return row;
}

export async function pid(
  db: Kysely<DB>,
  acc: Awaited<ReturnType<typeof account>>,
  patch: Partial<Insertable<DB['union_pids']>> = {},
) {
  const row = {
    id: randomUUID(),
    app_id: acc.app_id,
    platform: acc.platform,
    union_account_id: acc.id,
    pid: 'slot-ours',
    pid_scene: 'share',
    status: 'active',
    site_id: acc.platform === 'taobao' ? 'site-ours' : null,
    hjy_ignore_confirmed_at: at(RELEASED),
    hjy_ignore_evidence_path: 'synthetic/evidence',
    created_at: at(CREATED),
    updated_at: at(BOUND),
    ...patch,
  };
  await db.insertInto('union_pids').values(row).execute();
  return row;
}
