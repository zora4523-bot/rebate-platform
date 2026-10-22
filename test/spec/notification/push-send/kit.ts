import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { vi } from 'vitest';
import {
  createPushSendCore,
  type PushEvent,
  type PushSendInput,
} from '../../../../apps/api/src/modules/notification/application/push-send.ts';
import type { PushDeliveryChannel } from '../../../../apps/api/src/modules/notification/ports/push-delivery.ts';
import type { PushSessionValidity } from '../../../../apps/api/src/modules/identity/ports/push-session-validity.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

export const NOW = '2032-04-05T06:07:08.123Z';

export function eventOf(input: PushSendInput): PushEvent {
  const { app_id, user_id, code, variant, eventKey, category } = input;
  return { app_id, user_id, code, variant, eventKey, category };
}

export async function seedUser(db: Kysely<DB>, app_id: string) {
  const id = randomUUID();
  await db
    .insertInto('users')
    .values({
      id,
      app_id,
      nickname: 'fixture',
      avatar: 'fixture',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
    })
    .execute();
  return id;
}

export async function seedDevice(db: Kysely<DB>, app_id: string) {
  const id = randomUUID();
  await db
    .insertInto('devices')
    .values({
      id,
      app_id,
      device_hash: createHash('sha256').update(id).digest('hex'),
      id_source: 'idfv',
      platform: 'ios',
      app_version: '1.0.0',
      install_secret_cipher: Buffer.from('fixture-install-material'),
      last_seen_at: new Date(NOW),
    })
    .execute();
  return id;
}

export async function seedSession(
  db: Kysely<DB>,
  owner: { app_id: string; user_id: string },
  options: {
    sid?: string;
    revoked_at?: Date;
    expire_at?: Date;
    noRefresh?: boolean;
    rotated?: boolean;
  } = {},
) {
  const device_id = await seedDevice(db, owner.app_id);
  const sid = options.sid ?? `session-${randomUUID()}`;
  await db
    .insertInto('sessions')
    .values({
      id: randomUUID(),
      app_id: owner.app_id,
      user_id: owner.user_id,
      device_id,
      sid,
      revoked_at: options.revoked_at ?? null,
    })
    .execute();
  if (!options.noRefresh) {
    await db
      .insertInto('refresh_tokens')
      .values({
        id: randomUUID(),
        app_id: owner.app_id,
        sid,
        token_hash: createHash('sha256').update(randomUUID()).digest('hex'),
        expire_at: options.expire_at ?? new Date('2032-05-05T06:07:08.123Z'),
        rotated_at: options.rotated ? new Date(NOW) : null,
      })
      .execute();
  }
  return { sid, device_id };
}

export async function fixture(db: Kysely<DB>, code = 'DEMO_NOTICE') {
  const app_id = `push-suite-${randomUUID()}`;
  const user_id = await seedUser(db, app_id);
  const clock = new FixedClock(NOW);
  const input: PushSendInput = {
    app_id,
    user_id,
    code,
    variant: 'default',
    eventKey: `event-${randomUUID()}`,
    title: '通知标题',
    body: '通知正文',
    route: { name: 'OrderDetail', params: { order_id: 'order-fixture-a' } },
    category: 'service',
  };
  const channel = {
    send: vi.fn<PushDeliveryChannel['send']>().mockResolvedValue({ status: 'accepted' }),
  };
  const sessionValidity = vi
    .fn<PushSessionValidity>()
    .mockImplementation(async (_executor, query) => new Set(query.sids));
  async function registration(overrides: Partial<Insertable<DB['push_tokens']>> = {}) {
    const id = randomUUID();
    const ownerApp = overrides.app_id ?? app_id;
    const device_id = await seedDevice(db, ownerApp);
    const row = {
      id,
      app_id: ownerApp,
      user_id,
      device_id,
      bound_sid: `session-${id}`,
      provider: 'mobpush',
      token: `device-reg-${id}`,
      token_set_at: clock.now(),
      frozen_until: null,
      revoked_at: null,
      ...overrides,
    };
    await db.insertInto('push_tokens').values(row).execute();
    return row;
  }
  async function rows() {
    const inbox = await db
      .selectFrom('inbox_messages')
      .selectAll()
      .where('app_id', '=', app_id)
      .execute();
    const logs = await db
      .selectFrom('notify_logs')
      .selectAll()
      .where('app_id', '=', app_id)
      .execute();
    return { inbox, logs };
  }
  return {
    db,
    app_id,
    user_id,
    input,
    clock,
    channel,
    sessionValidity,
    registration,
    rows,
    async settings(
      values: { service_push: boolean; subscription_push: boolean; marketing_push: boolean },
      owner = { app_id, user_id },
    ) {
      await db
        .insertInto('notification_settings')
        .values({ ...owner, ...values })
        .execute();
    },
    async template(category: PushSendInput['category'], app = app_id, variant = input.variant) {
      await db
        .insertInto('notify_templates')
        .values({
          app_id: app,
          code: input.code,
          variant,
          category,
          channels: ['inbox', 'push'],
        })
        .execute();
    },
    async send(
      overrides: Partial<PushSendInput> = {},
      reader: PushSessionValidity = sessionValidity,
    ) {
      // Deliberately create the skeleton inside each test's call, never in setup hooks.
      const core = createPushSendCore({ clock, channel, sessionValidity: reader });
      const message = { ...input, ...overrides };
      await db.transaction().execute((trx) => core.record(trx, message));
      await core.dispatch(db, eventOf(message));
    },
    binding(id: string) {
      return db
        .selectFrom('push_tokens')
        .selectAll()
        .where('app_id', '=', app_id)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
