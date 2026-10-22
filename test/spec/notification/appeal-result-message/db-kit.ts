import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createAppealResultMessageHandler,
  type AppealResultMessagePayload,
} from '../../../../apps/api/src/modules/notification/application/appeal-result-message.ts';
import type { ReceivedEvent } from '../../../../apps/api/src/modules/platform/index.ts';
import { event, NOW, payload } from './fixtures.ts';

import { openSuite, failInsert, type Suite } from '../risk-state-message/db-kit.ts';
export { openSuite, failInsert, type Suite };

export async function fixture(suite: Suite) {
  const appId = `appeal-message-${randomUUID()}`;
  const userId = randomUUID();
  await suite.db
    .insertInto('users')
    .values({
      id: userId,
      app_id: appId,
      nickname: 'fixture',
      avatar: 'fixture',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
    })
    .execute();
  const clock = new FixedClock(NOW);
  return {
    db: suite.db,
    appId,
    userId,
    clock,
    event(extra: Partial<AppealResultMessagePayload> = {}) {
      return event(payload({ app_id: appId, user_id: userId, target_id: userId, ...extra }));
    },
    // Create the SUT in the test body, not a setup hook: every case fails on the skeleton.
    async deliver(received: ReceivedEvent) {
      const handler = createAppealResultMessageHandler({
        clock,
      });
      await suite.db.transaction().execute((trx) => handler(received, trx));
    },
    async rows(db: Kysely<DB> = suite.db) {
      const inbox = await db
        .selectFrom('inbox_messages')
        .selectAll()
        .where('app_id', '=', appId)
        .execute();
      const logs = await db
        .selectFrom('notify_logs')
        .selectAll()
        .where('app_id', '=', appId)
        .execute();
      return { inbox, logs };
    },
    async template(variant: string, overrides: Partial<Insertable<DB['notify_templates']>> = {}) {
      await suite.db
        .insertInto('notify_templates')
        .values({
          app_id: appId,
          code: 'APPEAL_RESULT',
          variant,
          category: 'service',
          channels: ['inbox'],
          route: null,
          title_override: null,
          body_override: null,
          ...overrides,
        })
        .execute();
    },
    async log(received: ReceivedEvent) {
      await suite.db
        .insertInto('notify_logs')
        .values({
          id: randomUUID(),
          app_id: appId,
          user_id: userId,
          code: 'APPEAL_RESULT',
          channel: 'inbox',
          dedupe_key: `appeal.resolved:${received.eventId}`,
          planned_at: clock.now(),
          sent_at: clock.now(),
          status: 'success',
        })
        .execute();
    },
  };
}
