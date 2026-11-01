import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ORDER_PATH, OUR_ADZONE, OUR_SLOT, rowOf, win } from '../taobao-orders/kit.ts';
import {
  assemble,
  configured,
  ctx,
  dataokePaths,
  fakeUpstream,
  logText,
  outcome,
  pidDatabase,
  pidRow,
  stubHttp,
  succeeded,
  type LogEntry,
} from './kit.ts';

// D10-530 wiring, review r1 S1: when the order slot reader that union.module.ts assembles over the
// database handle cannot read union_pids (a connection reset), listOrders of the registry's Taobao
// adapter rejects, so the order sync retries that window. The failure is never turned into an
// empty page, never logged as taobao_order_no_slots, and no 大淘客 order request follows it. Same
// assembly as wiring.test.ts (full Nest resolution, credentials stubbed, in-memory transports);
// a file of its own because the rule test files already committed for this task stay unchanged.

vi.mock('../../../../apps/api/src/modules/platform/config/taobao-startup.ts', async (original) => ({
  ...(await original<
    typeof import('../../../../apps/api/src/modules/platform/config/taobao-startup.ts')
  >()),
  openTaobaoCredentials: async () => async () => ({
    appKey: 'fake-switches-taobao-key',
    appSecret: 'swit-swit-swit-swit-swit',
  }),
}));
vi.mock(
  '../../../../apps/api/src/modules/platform/config/dataoke-startup.ts',
  async (original) => ({
    ...(await original<
      typeof import('../../../../apps/api/src/modules/platform/config/dataoke-startup.ts')
    >()),
    openDataokeCredentials: async () => async () => ({
      appKey: 'fake-switches-dataoke-key',
      appSecret: 'dtks-dtks-dtks-dtks-dtks',
    }),
  }),
);

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => expect.fail('network access is forbidden')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function warnings(logs: readonly LogEntry[]): LogEntry[] {
  return logs.filter((entry) => entry.level === 'warn');
}

it('[AC-B1-04zn#20] 推广位读者读 union_pids 失败（连接重置）时，经注册表拿到的淘宝适配器 listOrders 必须 reject：不当成空页返回、不写 taobao_order_no_slots、不发大淘客订单请求', async () => {
  const upstream = fakeUpstream({ orders: [rowOf(1, OUR_ADZONE)] });
  stubHttp(upstream);
  const database = pidDatabase([pidRow({ pid: OUR_SLOT })]);
  const app = await assemble(configured(), { db: database.db });
  try {
    const adapter = app.registry.get('taobao');
    // The reader is assembled: a first call reads union_pids and keeps our slot's order.
    const page = await succeeded(() => adapter.listOrders(win, {}, ctx), 'listOrders');
    expect(page.items.map((order) => order.order_id)).toEqual([rowOf(1).trade_id]);
    expect(database.statements).toHaveLength(1);
    expect(dataokePaths(upstream)).toEqual([ORDER_PATH]);
    const before = app.logs.length;

    const reset = Object.assign(new Error('FAKE_UNION_PIDS_CONNECTION_RESET'), {
      code: 'ECONNRESET',
    });
    database.fail(reset);
    const result = await outcome(() => adapter.listOrders(win, {}, ctx));
    expect(result, 'a failed union_pids read must not become an empty page').not.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(result, 'listOrders must reject when union_pids cannot be read').toBeInstanceOf(Error);
    expect(result).not.toMatchObject({ code: 'adapter_unimplemented' });
    // The read was attempted once more, and nothing was requested after it failed.
    expect(database.statements).toHaveLength(2);
    expect(dataokePaths(upstream)).toEqual([ORDER_PATH]);
    expect(logText(warnings(app.logs.slice(before)))).not.toContain('taobao_order_no_slots');
  } finally {
    await app.close();
    await database.db.destroy();
  }
});
