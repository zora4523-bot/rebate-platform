// B2-04ze: the factory ports app.module hands to SettlementModule.forWorker, run on a real database
// (D10-443, task brief §9.3 / §9.5): content's reader keeps the switches as they are (credit.enabled
// unset is not on; settle.auto.enabled unset is not off), and the BeneficiaryGate's pieces are
// identity's users lock and state readers, risk's state reader and B1-03zc's minors reader on the
// caller's transaction (users of another app or unknown ids are not answered).
import { createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  FAKE_CRYPTO,
  OTHER,
  SCAN_NOW,
  TAOBAO,
  TIMEOUT,
  capturedPorts,
  member,
  setConfig,
  withDatabase,
} from './kit.ts';

it(
  '[AC-B2-04ze#27] 配置端口照现状：credit.enabled.<platform> 未设时不是 on、设为 true 后为 true；settle.auto.enabled 未设时不是 off',
  async () => {
    const ports = await capturedPorts('worker');
    expect(ports, 'no ports captured on the worker entry').not.toBeNull();
    if (ports === null) return;
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(SCAN_NOW);
      const unset = await ports.config(db, clock).get(APP, `credit.enabled.${TAOBAO}`);
      expect(unset === true || unset === 'on').toBe(false);
      const auto = await ports.config(db, clock).get(APP, 'settle.auto.enabled');
      expect([undefined, null, true, 'on']).toContain(auto);

      await setConfig(db, APP, `credit.enabled.${TAOBAO}`, true);
      expect(await ports.config(db, clock).get(APP, `credit.enabled.${TAOBAO}`)).toBe(true);
      // Another app's setting does not leak.
      const other = await ports.config(db, clock).get(OTHER, `credit.enabled.${TAOBAO}`);
      expect(other === true || other === 'on').toBe(false);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#28] 闸门端口是真实读口：在调用方事务内锁本 app 的用户行、读注销状态与风控状态（无风控行 = normal），未知 id 与别的 app 的用户不返回；未成年人读口对无实名的用户返回空集',
  async () => {
    const ports = await capturedPorts('worker');
    expect(ports, 'no ports captured on the worker entry').not.toBeNull();
    if (ports === null) return;
    await withDatabase(createTestDatabase, async (db) => {
      const mine = await member(db, APP);
      const foreign = await member(db, OTHER);
      const ghost = randomUUID();
      const ids = [mine, foreign, ghost];
      await db.transaction().execute(async (trx) => {
        const locked = await ports.lockUsers(trx, { appId: APP, userIds: ids });
        expect([...locked]).toStrictEqual([mine]);

        const deletion = await ports.deletionStatus(db).read(trx, { app_id: APP, user_ids: ids });
        expect([...deletion.entries()]).toStrictEqual([[mine, 'none']]);

        const risk = await ports.riskState(db).read(trx, { appId: APP, userIds: ids });
        expect([...risk.keys()]).toStrictEqual([mine]);
        expect(risk.get(mine)?.state).toBe('normal');

        const realname = await ports.realnameStatus(db).read(trx, { appId: APP, userIds: ids });
        expect([...realname.entries()]).toStrictEqual([[mine, 'none']]);

        const minors = await ports
          .minors(FAKE_CRYPTO)
          .read(trx, { appId: APP, userIds: ids, at: new Date(SCAN_NOW) });
        expect([...minors]).toStrictEqual([]);
      });

      const ledger = ports.ledger(new FixedClock(SCAN_NOW));
      expect([
        typeof ledger.openUserAccount,
        typeof ledger.lockBalances,
        typeof ledger.post,
      ]).toStrictEqual(['function', 'function', 'function']);
    });
  },
  TIMEOUT,
);
