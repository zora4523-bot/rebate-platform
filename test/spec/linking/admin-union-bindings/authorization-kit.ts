import { randomBytes, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import {
  createUnionBindings,
  createUnionAuthReads,
  type UnionBindingExchangeInput,
  type UnionBindingExchangeResult,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { createIdempotency } from '../../../../apps/api/src/modules/platform/index.ts';
import { activatePddBinding } from '../../../../apps/api/src/modules/linking/application/pdd-authority.ts';
import type { Scenario } from './kit.ts';

/** Only the upstream credential exchange is synthetic; the transaction and writes are real. */
export async function authorization(s: Scenario, accountId: string) {
  const deviceId = randomUUID();
  await s.h.db
    .insertInto('devices')
    .values({
      id: deviceId,
      app_id: s.appId,
      device_hash: randomBytes(32).toString('hex'),
      id_source: 'idfv',
      install_secret_cipher: Buffer.from('synthetic-unused'),
      platform: 'ios',
      app_version: '2.0.0',
      last_seen_at: s.f.clock.now(),
    })
    .execute();
  const exchange = vi
    .fn<(input: UnionBindingExchangeInput) => Promise<UnionBindingExchangeResult>>()
    .mockResolvedValue({ kind: 'bound', relationId: `new-${randomUUID()}` });
  const logger = { warn: vi.fn() };
  const config = { configValue: async () => null };
  const reads = createUnionAuthReads({
    db: s.h.db,
    config,
    appEnv: 'test',
    pids: { getActivePid: async () => null },
  });
  const service = createUnionBindings({
    db: s.h.db,
    clock: s.f.clock,
    logger,
    reads,
    exchanger: { exchange },
    callerContext: { current: async () => ({ appId: s.appId, userId: s.userId, deviceId }) },
    idempotency: createIdempotency({ db: s.h.db, clock: s.f.clock, logger }),
  });
  const bind = async () => {
    const state = randomUUID();
    await s.h.db
      .insertInto('union_auth_sessions')
      .values({
        state,
        app_id: s.appId,
        user_id: s.userId,
        device_id: deviceId,
        platform: 'taobao',
        mode: 'bind',
        client: 'ios',
        expire_at: new Date(s.f.clock.now().getTime() + 600_000),
        auth_methods: ['web_code'],
        auth_app_refs: { web_code: 'synthetic/issued-app/web_code' },
      })
      .execute();
    return service.bind({
      platform: 'taobao',
      body: { state, auth_method: 'web_code', code: 'synthetic-code' },
      idempotencyKey: randomUUID(),
      traceId: randomUUID(),
    });
  };
  const pdd = () =>
    s.h.db.transaction().execute((trx) =>
      activatePddBinding(trx, s.f.clock, {
        appId: s.appId,
        userId: s.userId,
        accountId,
        custom: `synthetic-${s.userId}`,
      }),
    );
  return { bind, pdd, exchange };
}
