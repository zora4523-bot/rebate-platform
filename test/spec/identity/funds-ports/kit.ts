import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type CompiledQuery, type Kysely, type KyselyPlugin } from 'kysely';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

export const clock = new FixedClock('2026-10-20T00:00:00.000Z');

export async function user(executor: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await executor
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'synthetic-funds-ports',
      avatar: 'https://example.invalid/avatar.png',
      phone_cipher: Buffer.from('synthetic-private-phone'),
      phone_hmac: `synthetic_${id}`,
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return id;
}

export async function realname(
  executor: Kysely<DB>,
  appId: string,
  userId: string,
  status: 'none' | 'verified' | 'failed',
): Promise<void> {
  await executor
    .withSchema('app')
    .insertInto('realname')
    .values({
      id: randomUUID(),
      app_id: appId,
      user_id: userId,
      status,
      ...(status === 'verified'
        ? {
            name_cipher: Buffer.from('synthetic-private-name'),
            id_no_cipher: Buffer.from('synthetic-private-id'),
            id_no_hmac: userId.replaceAll('-', '').repeat(2),
            birth_date_cipher: Buffer.from('synthetic-private-birth-date'),
            provider: 'synthetic',
            verified_at: clock.now(),
          }
        : {}),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}

export async function riskState(
  executor: Kysely<DB>,
  appId: string,
  userId: string,
  state: 'normal' | 'frozen' | 'appealing' | 'banned',
  frozenUntil: Date | null = null,
): Promise<void> {
  await executor
    .withSchema('app')
    .insertInto('user_risk_state')
    .values({
      app_id: appId,
      user_id: userId,
      state,
      frozen_until: frozenUntil,
      reason_category: state === 'normal' ? null : 'other',
      changed_by: 'synthetic-test',
      changed_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}

export function observe(executor: Kysely<DB>) {
  const statements: CompiledQuery[] = [];
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      statements.push(executor.getExecutor().compileQuery(node, queryId));
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  return { executor: executor.withPlugin(plugin), statements };
}

export function normalized(query: CompiledQuery): string {
  return query.sql.replaceAll('"', '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function assertDeduplicated(query: CompiledQuery, ids: readonly string[]): void {
  // Supports parameter arrays (ANY) and individual bind parameters (IN).
  const boundIds = query.parameters.flat().filter((value) => ids.includes(String(value)));
  expect([...boundIds].sort()).toEqual([...new Set(ids)].sort());
}

export function assertReadProjection(query: string, fields: readonly string[]): void {
  const projection = /^select (.*?) from app\.users\b/.exec(query)?.[1];
  expect(projection).toBeDefined();
  expect(projection).not.toContain('*');
  // Allow table aliases, output aliases and SQL-side defaults, but no other source columns.
  const tokens = projection
    ?.replace(/'[^']*'/g, '')
    .replace(/\bas\s+\w+/g, '')
    .replace(/\b\w+\./g, '')
    .match(/[a-z_][a-z_0-9]*/g);
  expect(tokens?.length).toBeGreaterThan(0);
  for (const token of tokens ?? []) {
    expect(['id', 'user_id', 'coalesce', 'null', ...fields]).toContain(token);
  }
}

export async function probeLock(
  executor: Kysely<DB>,
  appId: string,
  id: string,
  strength: 'no key update' | 'key share' = 'no key update',
) {
  return executor.transaction().execute(async (trx) => {
    // Each probe owns its transaction: a NOWAIT failure cannot abort the lock holder.
    const result = await sql<{ id: string }>`
      SELECT id FROM app.users WHERE app_id = ${appId} AND id = ${id}
      FOR ${sql.raw(strength)} NOWAIT
    `.execute(trx);
    return result.rows;
  });
}
