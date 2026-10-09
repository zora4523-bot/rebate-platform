import { randomBytes } from 'node:crypto';
import { sql, type RootOperationNode } from 'kysely';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/events.ts';
import {
  createRiskStateService,
  type SetRiskState,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { seedUser, type Kit } from '../../identity/registration/kit.ts';
export { openKit, closeKit } from '../../identity/registration/kit.ts';
export type { Kit } from '../../identity/registration/kit.ts';

export async function fixture(kit: Kit) {
  const app_id = `risk_${randomBytes(10).toString('hex')}`;
  const user_id = await seedUser(kit.db, app_id);
  const now = await sql<{ now: Date }>`SELECT now() AS now`.execute(kit.db);
  const clock = new FixedClock(now.rows[0]!.now);
  const queries: RootOperationNode[] = [];
  const db = kit.db.withPlugin({
    transformQuery(args) {
      queries.push(args.node);
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  // No subscriptions needed: the actual platform bus still writes event_log in the transaction.
  const queue = { send: vi.fn(async () => null) };
  const events = createEventBus({ clock, queue, subscriptions: [] });
  const publish = vi.spyOn(events, 'publish');
  const command: SetRiskState = {
    app_id,
    user_id,
    state: 'banned',
    reason: 'private fixture reason and rule details',
    reason_category: 'malicious_rights',
    frozen_until: null,
    changed_by: 'fixture_operator',
  };
  return {
    db,
    clock,
    events,
    publish,
    queries,
    command,
    subject: { app_id, user_id },
    service: () => createRiskStateService({ db, clock, events }),
    rows: () => db.selectFrom('user_risk_state').selectAll().where('app_id', '=', app_id).execute(),
    eventRows: () =>
      db
        .selectFrom('event_log')
        .selectAll()
        .where('app_id', '=', app_id)
        .where('name', '=', 'risk.state_changed')
        .execute(),
  };
}
