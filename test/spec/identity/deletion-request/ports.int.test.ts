// B1-15d assembly of the two ports (ruling D10-97, brief §9.2 #2): app.module's own in-flight port
// answers "none" until B2-05 (an application succeeds); a missing in-flight or balance port answers
// 50001 and writes nothing — the application is never let through unchecked. One app per test.
import { expect, it } from 'vitest';
import {
  deletion,
  failed,
  openFixture,
  requests,
  seedBalance,
  user,
  type PortMode,
} from './kit.ts';

it('[AC-B1-15d#36] app.module 装配的在途端口如实答「无在途」、余额走 ledger：申请成功，快照为账上余额', async () => {
  const f = await openFixture('assembled');
  try {
    const u = await user(f);
    await seedBalance(f, u.appId, u.uid, 2_500n);
    expect((await deletion(await u.apply({ stepUp: await u.mint() }))).status).toBe('cooling');
    const rows = await requests(f, u.appId, u.uid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.balance_snapshot_fen).toBe(2_500n);
  } finally {
    await f.close();
  }
}, 180_000);

it.each(['no_in_flight', 'no_balance'] as const satisfies readonly PortMode[])(
  '[AC-B1-15d#37] 缺注入（%s）→ 申请 50001、不建单',
  async (mode) => {
    const f = await openFixture(mode);
    try {
      const u = await user(f);
      await failed(await u.apply({ stepUp: await u.mint() }), 500, 50001);
      expect(await requests(f, u.appId, u.uid)).toEqual([]);
    } finally {
      await f.close();
    }
  },
  180_000,
);
