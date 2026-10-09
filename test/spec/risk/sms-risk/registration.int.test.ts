import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRegistrationService,
  type RegistrationCommand,
} from '../../../../apps/api/src/modules/identity/application/registration.ts';
import { createSmsRiskPorts } from '../../../../apps/api/src/modules/identity/application/sms-risk-ports.ts';
import { REGISTER_METHODS } from '../../../../apps/api/src/modules/identity/domain/registration.ts';
import { closeSuite, openSuite } from './http-kit.ts';
import { hash, IP, phone, withRisk } from './kit.ts';

let suite: Awaited<ReturnType<typeof openSuite>>;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});

it.each(REGISTER_METHODS)(
  '[AC-B1-03g#7] register_method=%s 的第五个新号也计 IP，记录来自真实建号服务',
  async (method) => {
    await withRisk(suite.server, async (f) => {
      const risk = f.service();
      const ports = createSmsRiskPorts({
        risk,
        devices: { deviceHashOf: async () => null },
        logger: f.options.logger,
      });
      const registration = createRegistrationService({
        clock: f.clock,
        config: f.options.config,
        crypto: suite.kit.crypto,
        logger: f.options.logger,
        sensitiveWords: { matches: () => false },
        ...ports.registration,
      });
      for (let i = 0; i < 4; i++) await f.registered(risk);
      expect(await risk.admit(f.request())).toEqual({ code: 0 });
      const command: RegistrationCommand = {
        app_id: f.app,
        register_method: method,
        client_ip: IP,
        phone: method === 'sms' || method === 'h5_landing' ? phone() : null,
        ...(method === 'h5_landing' || method === 'admin'
          ? {}
          : { device_hash: hash(), device_id: randomUUID() }),
      };
      const created = await suite.kit.db
        .transaction()
        .execute((trx) => registration.register(trx, command));
      expect(created).toMatchObject({ code: 0 });
      expect(await risk.admit(f.request())).toEqual({ code: 42901, retryAfterSec: 3601 });
    });
  },
);

it('[AC-B1-03g#7] afterRegistered 在提交前计数；外层回滚接受保守多计', async () => {
  await withRisk(suite.server, async (f) => {
    const risk = f.service();
    const ports = createSmsRiskPorts({
      risk,
      devices: { deviceHashOf: async () => null },
      logger: f.options.logger,
    });
    const registration = createRegistrationService({
      clock: f.clock,
      config: f.options.config,
      crypto: suite.kit.crypto,
      logger: f.options.logger,
      sensitiveWords: { matches: () => false },
      ...ports.registration,
    });
    for (let i = 0; i < 4; i++) await f.registered(risk);
    const rollback = new Error('fixture rollback');
    await expect(
      suite.kit.db.transaction().execute(async (trx) => {
        expect(
          await registration.register(trx, {
            app_id: f.app,
            phone: phone(),
            register_method: 'h5_landing',
            client_ip: IP,
          }),
        ).toMatchObject({ code: 0 });
        expect(await risk.admit(f.request())).toEqual({ code: 42901, retryAfterSec: 3601 });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(
      await suite.kit.db
        .withSchema('app')
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', f.app)
        .execute(),
    ).toEqual([]);
    expect(await risk.admit(f.request())).toEqual({ code: 42901, retryAfterSec: 3601 });
  });
});
