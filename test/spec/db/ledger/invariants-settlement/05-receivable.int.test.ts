import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { account, platform } from '../invariants/kit.ts';
import {
  APP,
  OTHER_APP,
  TIMEOUT,
  clean,
  detailContains,
  differences,
  identifies,
  obligation,
  order,
  person,
  post,
  scenario,
} from './kit.ts';

it(
  '[AC-B2-04z#1] ⑤ 预留不为零：应收1000而非基数800；一分少记、跨日重复核对都报全局差异',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const o = await order(db);
      await post(db, o, o.people[0]!, 400n, 'CREDIT', { date: '2032-06-14' });
      await post(db, o, o.people[1]!, 80n);
      await post(db, o, o.revenue, 520n);
      clean(await check(1n));
      await post(db, o, o.revenue, -1n, 'SETTLE_ADJUST');
      const rows = await check(1n);
      differences(rows, 'global');
      identifies(rows, o);
      detailContains(rows, 999n, 1000n);
      expect(await check(1n, '2032-06-16')).toEqual(rows);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#2] ⑤ 暂缓首次入账：400不写凭证，应收600正常；再少一分必须报',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const held = { ...(await person(db, APP)), status: 'held' as const };
      const direct = await person(db, APP, 'direct', 1000);
      const o = await order(db, { people: [held, direct] });
      await obligation(db, o, held);
      await post(db, o, direct, 80n);
      await post(db, o, o.revenue, 520n);
      clean(await check(1n));
      await post(db, o, o.revenue, -1n, 'SETTLE_ADJUST');
      const rows = await check(1n);
      differences(rows, 'global');
      identifies(rows, o);
      detailContains(rows, 599n, 600n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#3] ⑤ 暂缓期间N降至900、B降至720，按booked基数而非原快照重算360',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const o = await order(db, { values: { booked_n_fen: 900n, booked_base_fen: 720n } });
      await obligation(db, o, o.people[0]!);
      await post(db, o, o.people[1]!, 80n);
      await post(db, o, o.revenue, 520n);
      await post(db, o, o.people[1]!, -8n, 'SETTLE_ADJUST');
      await post(db, o, o.revenue, -52n, 'SETTLE_ADJUST');
      clean(await check(1n)); // 540 = 900 - 360，不是900 - 400。
      await post(db, o, o.revenue, -40n, 'SETTLE_ADJUST');
      const rows = await check(1n);
      differences(rows, 'global');
      detailContains(rows, 500n, 540n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#4] ⑤ done、forfeited、voided义务不再扣缺口，held标记本身不构成义务',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      for (const status of ['done', 'forfeited', 'voided', 'absent'] as const) {
        const p = { ...(await person(db, APP)), status: 'held' as const };
        const o = await order(db, { people: [p] });
        if (status !== 'absent') await obligation(db, o, p, { status });
        if (status === 'done') {
          await post(db, o, p, 400n);
          await post(db, o, o.revenue, 600n);
        } else {
          await post(db, o, o.revenue, 600n);
          await post(db, o, o.revenue, 400n, 'FORFEIT', { keyPerson: p });
        }
      }
      clean(await check(4n));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#5] ⑤ 已补360且义务关闭、全额扣回恢复再扣回的历史均正常',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const released = await order(db, { values: { booked_n_fen: 900n, booked_base_fen: 720n } });
      await obligation(db, released, released.people[0]!, { status: 'done' });
      await post(db, released, released.people[0]!, 360n);
      await post(db, released, released.people[1]!, 72n);
      await post(db, released, released.revenue, 468n);
      const zero = await order(db, {
        values: { rebate_status: 'CLAWED_BACK', booked_n_fen: 0n, booked_base_fen: 0n },
      });
      for (const [kind, sign] of [
        ['CREDIT', 1],
        ['CLAWBACK', -1],
        ['ADMIN_ADJUST', 1],
        ['CLAWBACK', -1],
      ] as const) {
        await post(db, zero, zero.people[0]!, sign === 1 ? 400n : -400n, kind, {
          subType: kind === 'ADMIN_ADJUST' ? 'RESTORE' : 'FULL',
        });
        await post(db, zero, zero.revenue, sign === 1 ? 600n : -600n, kind, {
          subType: kind === 'ADMIN_ADJUST' ? 'RESTORE' : 'FULL',
        });
      }
      clean(await check(2n));
      await post(db, zero, zero.revenue, 1n, 'ADMIN_ADJUST', { subType: 'RESTORE' });
      const rows = await check(2n);
      differences(rows, 'global');
      identifies(rows, zero);
      detailContains(rows, 1n, 0n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#6] ⑤ 同一用户不同角色分别截零再求和，超额50不能抵销另一角色缺口60',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const self = await person(db, APP);
      const direct = { ...self, role: 'direct' as const, ratio: 1000 };
      const o = await order(db, { people: [self, direct] });
      await obligation(db, o, self, { kind: 'deferred' });
      await obligation(db, o, direct, { kind: 'deferred' });
      // 历史已完成义务不能与当前open义务连接成双份。
      await obligation(db, o, direct, { kind: 'deferred', status: 'done' });
      await post(db, o, self, 450n);
      await post(db, o, direct, 20n);
      await post(db, o, o.revenue, 470n);
      clean(await check(1n)); // 940 = 1000 - (0 + 60)。
      await post(db, o, o.revenue, 50n, 'SETTLE_ADJUST');
      const rows = await check(1n);
      differences(rows, 'global');
      detailContains(rows, 990n, 940n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#7] ⑤ 两个未履约受益人都参与待补记，未入账人不能被分录内连接丢掉',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const o = await order(db);
      for (const p of o.people) await obligation(db, o, p);
      await post(db, o, o.revenue, 520n);
      clean(await check(1n));
      await post(db, o, o.revenue, 80n, 'SETTLE_ADJUST');
      const rows = await check(1n);
      differences(rows, 'global');
      detailContains(rows, 600n, 520n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#8] ⑤ 应收等式独立于净额上限；跨两人合计801超过B800一分必须报',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const o = await order(db);
      await post(db, o, o.people[0]!, 700n);
      await post(db, o, o.people[1]!, 100n);
      await post(db, o, o.revenue, 200n);
      clean(await check(1n));
      await post(db, o, o.people[1]!, 1n, 'SETTLE_ADJUST');
      await post(db, o, o.revenue, -1n, 'SETTLE_ADJUST');
      const rows = await check(1n);
      differences(rows, 'global');
      identifies(rows, o);
      detailContains(rows, 801n, 800n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#9] ⑤ 缺凭证也要检查；非CREDITED和非CLAWED_BACK不进入检查行数',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      for (const rebate_status of ['WAITING', 'ESTIMATED', 'VOID', 'UNATTRIBUTED'])
        await order(db, { values: { rebate_status } });
      const bad = await order(db);
      const zero = await order(db, {
        values: { rebate_status: 'CLAWED_BACK', booked_n_fen: 0n, booked_base_fen: 0n },
      });
      expect(zero.id).not.toBe(bad.id);
      const rows = await check(2n);
      differences(rows, 'global');
      identifies(rows, bad);
      detailContains(rows, 0n, 1000n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#10] ⑤ 只认订单类凭证与应收科目，RECON_FIX、奖励及非应收对方不能填平一分',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const o = await order(db);
      await post(db, o, o.people[0]!, 400n);
      await post(db, o, o.revenue, 599n);
      const baseline = await check(1n);
      differences(baseline, 'global');
      await post(db, o, o.revenue, 1n, 'ADMIN_ADJUST', { subType: 'RECON_FIX' });
      await post(db, o, o.revenue, 1n, 'REWARD');
      const cash = await platform(db, 'CASH');
      await post(db, o, o.revenue, 1n, 'CREDIT', { counter: cash });
      const rows = await check(1n);
      differences(rows, 'global');
      identifies(rows, o);
      detailContains(rows, 999n, 1000n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#11] ⑤ 坏账扣回减少受益人净额，归平台正差不增加受益人净额',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const o = await order(db, { values: { booked_n_fen: 1000n, booked_base_fen: 100n } });
      await post(db, o, o.people[0]!, 400n);
      await post(db, o, o.revenue, 600n);
      const debt = await platform(db, 'BAD_DEBT:taobao');
      await post(db, o, debt, -300n, 'CLAWBACK', { keyPerson: o.people[0]! });
      await post(db, o, o.revenue, 300n, 'SETTLE_ADJUST', { keyPerson: o.people[0]! });
      clean(await check(1n)); // 净额100，即使用户现金账户仍有400。
      await post(db, o, o.people[0]!, 1n, 'SETTLE_ADJUST');
      await post(db, o, o.revenue, -1n, 'SETTLE_ADJUST');
      const rows = await check(1n);
      differences(rows, 'global');
      detailContains(rows, 101n, 100n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#12] ⑤ app_id、平台和子订单隔离，另一单相反差额不能冲抵',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const a = await order(db, { sub: 'same-sub' });
      const b = await order(db, { app: OTHER_APP, platform: 'jd', sub: 'same-sub' });
      await post(db, a, a.revenue, 999n);
      await post(db, b, b.revenue, 1001n);
      const rows = await check(2n);
      differences(rows, 'global');
      const aRows = rows.filter((r) => r.app_id === APP);
      const bRows = rows.filter((r) => r.app_id === OTHER_APP);
      identifies(aRows, a);
      identifies(bRows, b);
      detailContains(aRows, 999n, 1000n);
      detailContains(bRows, 1001n, 1000n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#13] ⑤ 大于2^53金额的一分差与按快照比例向下取整的尾分均精确',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const p = await person(db, APP, 'self', 3333);
      const small = await order(db, {
        people: [p],
        values: { booked_n_fen: 10n, booked_base_fen: 7n },
      });
      await obligation(db, small, p);
      await post(db, small, small.revenue, 8n); // floor(7 * 3333 / 10000) = 2。
      const big = await order(db, {
        values: { booked_n_fen: 9007199254740993n, booked_base_fen: 9007199254740993n },
      });
      await post(db, big, big.revenue, 9007199254740993n);
      clean(await check(2n));
      await post(db, big, big.revenue, -1n, 'SETTLE_ADJUST');
      const rows = await check(2n);
      differences(rows, 'global');
      identifies(rows, big);
      detailContains(rows, '9007199254740992', '9007199254740993');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#14] ⑤ 改派红冲与改派入账计入净额，不把历史旧收款人重复计入上限',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const o = await order(db, { values: { booked_n_fen: 500n, booked_base_fen: 400n } });
      const old = await account(db);
      const oldPerson = { account: old, role: 'self' as const, ratio: 5000 };
      await post(db, o, oldPerson, 400n);
      await post(db, o, oldPerson, -400n, 'REASSIGN_REV');
      await post(db, o, o.people[0]!, 400n, 'REASSIGN_CREDIT');
      await post(db, o, o.revenue, 100n);
      clean(await check(1n));
      await post(db, o, o.people[0]!, 1n, 'REASSIGN_CREDIT');
      await post(db, o, o.revenue, -1n, 'SETTLE_ADJUST');
      const rows = await check(1n);
      differences(rows, 'global');
      detailContains(rows, 401n, 400n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#22] ⑤ 外应用相同order_key的凭证不能填平本应用缺口',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const o = await order(db);
      await post(db, o, o.revenue, 999n);
      const foreignRevenue = await platform(db, 'COMMISSION_REVENUE', OTHER_APP);
      const foreignReceivable = await platform(db, 'UNION_RECEIVABLE:taobao', OTHER_APP);
      await post(db, { ...o, app: OTHER_APP, receivable: foreignReceivable }, foreignRevenue, 1n);
      const rows = await check(1n);
      differences(rows, 'global');
      identifies(rows, o);
      detailContains(rows, 999n, 1000n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#23] ⑤ 同受益人在另一订单的open义务不能替本单减待补记',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const p = await person(db, APP);
      const bad = await order(db, { people: [p] });
      const held = await order(db, { people: [p] });
      await obligation(db, held, p);
      await post(db, held, held.revenue, 600n);
      await post(db, bad, bad.revenue, 600n);
      const rows = await check(2n);
      differences(rows, 'global');
      identifies(rows, bad);
      detailContains(rows, 600n, 1000n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#24] ⑤ 大整数待补记乘比例不能溢出bigint或经浮点丢一分',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      const p = await person(db, APP);
      const o = await order(db, {
        people: [p],
        values: { booked_n_fen: 9007199254740993n, booked_base_fen: 9007199254740993n },
      });
      await obligation(db, o, p, { kind: 'deferred' });
      await post(db, o, o.revenue, 4503599627370497n);
      clean(await check(1n)); // 应得floor(B/2)=4503599627370496。
      await post(db, o, o.revenue, -1n, 'SETTLE_ADJUST');
      const rows = await check(1n);
      differences(rows, 'global');
      identifies(rows, o);
      detailContains(rows, '4503599627370496', '4503599627370497');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#25] ⑤ 正常空集合返回零检查哨兵行',
  async () => {
    await scenario(createTestDatabase, '05', async ({ check }) => {
      clean(await check(0n));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#26] ⑤ 核对日次日已入账的调整与当前booked金额一致时不报，少一分仍报',
  async () => {
    await scenario(createTestDatabase, '05', async ({ db, check }) => {
      // BR-FUND-19⑤按订单booked金额复核；细则未定义历史booked快照。
      // 模拟16日01:00核对15日：16日00:00至01:00的调整已提交，当前N=900、B=720。
      // 保守保持同一读取快照的订单与凭证口径，不能仅将凭证截到15日再比当前booked。
      const o = await order(db, { values: { booked_n_fen: 900n, booked_base_fen: 720n } });
      await post(db, o, o.people[0]!, 400n, 'CREDIT', { date: '2032-06-15' });
      await post(db, o, o.people[1]!, 80n, 'CREDIT', { date: '2032-06-15' });
      await post(db, o, o.revenue, 520n, 'CREDIT', { date: '2032-06-15' });
      await post(db, o, o.people[0]!, -40n, 'SETTLE_ADJUST', { date: '2032-06-16' });
      await post(db, o, o.people[1]!, -8n, 'SETTLE_ADJUST', { date: '2032-06-16' });
      await post(db, o, o.revenue, -52n, 'SETTLE_ADJUST', { date: '2032-06-16' });
      clean(await check(1n, '2032-06-15'));
      // 分录只追加：追加同会计日的一分负调整，制造次日净额少一分的破坏数据。
      await post(db, o, o.revenue, -1n, 'SETTLE_ADJUST', { date: '2032-06-16' });
      const rows = await check(1n, '2032-06-15');
      differences(rows, 'global');
      identifies(rows, o);
      detailContains(rows, 899n, 900n);
    });
  },
  TIMEOUT,
);
