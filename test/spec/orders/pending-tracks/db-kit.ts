import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import * as linking from '../../../../apps/api/src/modules/linking/index.ts';
import * as orders from '../../../../apps/api/src/modules/orders/index.ts';
import { fixture as orderFixture } from '../list-detail/kit.ts';
import { at, capture, START } from './kit.ts';

export async function store(db: Kysely<DB>) {
  const result = await capture(() => linking.createPendingAttemptStore(db));
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  return result.value;
}

export async function fixture(db: Kysely<DB>) {
  const base = await orderFixture(db);
  const { subject, clock, config, settings } = base;
  clock.set(START);
  settings.set('attr.track_complete_tolerance_sec', 120);
  async function link(patch: Partial<Insertable<DB['links']>> = {}) {
    const row = {
      link_id: randomUUID(),
      ...subject,
      platform: 'jd',
      scene: 'h5',
      pid_scene: 'self_buy',
      product_key: 'jd:i_12345',
      expire_at: at(60 * 24 * 10),
      created_at: clock.now(),
      updated_at: clock.now(),
      ...patch,
    };
    await db.insertInto('links').values(row).execute();
    return row.link_id;
  }
  async function open(
    minute: number,
    patch: Partial<Insertable<DB['link_open_attempts']>> = {},
    log: Partial<Insertable<DB['link_logs']>> | false = {},
  ) {
    const row = {
      attempt_id: randomUUID().replace(/^(.{14})4/, '$17'),
      ...subject,
      link_id: patch.link_id ?? (await link()),
      opened_at: at(minute),
      jump_reported_at: null,
      dismissed_at: null,
      created_at: at(minute),
      updated_at: at(minute),
      ...patch,
    };
    await db.insertInto('link_open_attempts').values(row).execute();
    if (log !== false) {
      const linked = await db
        .selectFrom('links')
        .select('platform')
        .where('link_id', '=', row.link_id)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('link_logs')
        .values({
          app_id: row.app_id,
          user_id: row.user_id,
          opener_user_id: row.user_id,
          link_id: row.link_id,
          platform: linked.platform,
          pid_scene: 'self_buy',
          event: 'open',
          result_code: 0,
          no_rebate: false,
          created_at: row.opened_at,
          ...log,
        })
        .execute();
    }
    return row;
  }
  async function report(attemptId: string, minute: number) {
    // 没有上报入口：这里只准备已采信的夹具，不模拟或测试上报协议。
    await db
      .updateTable('link_open_attempts')
      .set({ jump_reported_at: at(minute) })
      .where('attempt_id', '=', attemptId)
      .execute();
  }
  async function service() {
    const attempts = await store(db);
    const listForUser = vi.spyOn(attempts, 'listForUser');
    const dismiss = vi.spyOn(attempts, 'dismiss');
    const result = await capture(() => orders.createPendingTracks({ db, clock, config, attempts }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw result.error;
    return { q: result.value, attempts, listForUser, dismiss };
  }
  async function saved() {
    return db.selectFrom('link_open_attempts').selectAll().orderBy('attempt_id').execute();
  }
  async function complete(
    linkId: string,
    minute: number,
    patch: Partial<Insertable<DB['orders']>> = {},
  ) {
    return base.seed({
      link_id: linkId,
      attr_at: at(minute),
      paid_at: at(minute, 1000),
      source_match: 'exact',
      ...patch,
    });
  }
  return { ...base, link, open, report, service, saved, complete };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function expected(
  a: { attempt_id: string; link_id: string; opened_at: unknown },
  platform = 'jd',
  claim = false,
  dismissed = false,
) {
  return {
    link_id: a.link_id,
    attempt_id: a.attempt_id,
    platform,
    jumped_at: (a.opened_at as Date).toISOString(),
    show_claim_entry: claim,
    dismissed,
  };
}
