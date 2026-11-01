import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaobaoOrderWarning } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  ctx as convertCtx,
  identity as convertIdentity,
  req as convertReq,
} from '../taobao-convert/kit.ts';
import {
  FOREIGN_ADZONE,
  OUR_ADZONE,
  OUR_SLOT,
  RETIRED_ADZONE,
  RETIRED_SLOT,
  rowOf,
  win,
} from '../taobao-orders/kit.ts';
import { couliItemId, query as searchQuery } from '../taobao-search/kit.ts';
import {
  APP,
  CONVERT_VARIABLE,
  DATAOKE_GATEWAY,
  OTHER_APP,
  SEARCH_VARIABLE,
  assemble,
  configured,
  ctx,
  dataokePaths,
  endpoints,
  fakeUpstream,
  logText,
  observeTaobao,
  pidDatabase,
  pidRow,
  refused,
  stubHttp,
  succeeded,
  type LogEntry,
} from './kit.ts';

// D10-530 wiring: union.module.ts hands the configured switches to taobaoLive when taobao is live,
// and assembles the order slot reader over the optional database handle when the 大淘客 order
// source is injected. Full Nest resolution of UnionModule, credentials stubbed (an already-tested
// startup boundary, B1-04k / B1-04e), every HTTPS transport an in-memory fake.

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

it('[AC-B1-04zn#14] 端到端：staging + 淘宝 / 大淘客凭据 + taobao live + TAOBAO_SEARCH_SOURCE=dataoke 时 searchItems 去大淘客搜索；缺省或 official 仍 adapter_unimplemented', async () => {
  const upstream = fakeUpstream();
  stubHttp(upstream);
  // The module must use the passed config, not the ambient environment.
  vi.stubEnv(SEARCH_VARIABLE, 'dataoke');
  for (const extra of [{}, { [SEARCH_VARIABLE]: 'official' }]) {
    const app = await assemble(configured(extra));
    try {
      await refused(
        () => app.registry.get('taobao').searchItems(searchQuery, ctx),
        'adapter_unimplemented',
      );
    } finally {
      await app.close();
    }
  }
  expect(upstream.dataokeTransport).not.toHaveBeenCalled();
  expect(upstream.topTransport).not.toHaveBeenCalled();

  const app = await assemble(configured({ [SEARCH_VARIABLE]: 'dataoke' }));
  try {
    const page = await succeeded(
      () => app.registry.get('taobao').searchItems(searchQuery, ctx),
      'searchItems',
    );
    expect(dataokePaths(upstream)).toEqual(['/api/goods/get-dtk-search-goods']);
    expect(new URL(upstream.dataokeTransport.mock.calls[0]![0].url).origin).toBe(DATAOKE_GATEWAY);
    expect(page.items.map((item) => item.item_id)).toEqual([couliItemId(1), couliItemId(2)]);
    // The search switch alone leaves convert as it was.
    await refused(
      () => app.registry.get('taobao').convert(convertReq, convertIdentity, convertCtx),
      'adapter_unimplemented',
    );
    expect(dataokePaths(upstream)).toHaveLength(1);
  } finally {
    await app.close();
  }
});

it('[AC-B1-04zn#15] 端到端：TAOBAO_CONVERT_SOURCE=dataoke 时 convert 经大淘客转链；缺省或 baichuan 仍 adapter_unimplemented', async () => {
  const upstream = fakeUpstream();
  stubHttp(upstream);
  vi.stubEnv(CONVERT_VARIABLE, 'dataoke');
  for (const extra of [{}, { [CONVERT_VARIABLE]: 'baichuan' }]) {
    const app = await assemble(configured(extra));
    try {
      await refused(
        () => app.registry.get('taobao').convert(convertReq, convertIdentity, convertCtx),
        'adapter_unimplemented',
      );
    } finally {
      await app.close();
    }
  }
  expect(upstream.dataokeTransport).not.toHaveBeenCalled();

  const app = await assemble(configured({ [CONVERT_VARIABLE]: 'dataoke' }));
  try {
    const result = await succeeded(
      () => app.registry.get('taobao').convert(convertReq, convertIdentity, convertCtx),
      'convert',
    );
    expect(result.kind).toBe('url');
    expect(dataokePaths(upstream)).toEqual(['/api/tb-service/get-privilege-link']);
    expect(new URL(upstream.dataokeTransport.mock.calls[0]![0].url).origin).toBe(DATAOKE_GATEWAY);
    // The convert switch alone leaves searchItems as it was.
    await refused(
      () => app.registry.get('taobao').searchItems(searchQuery, ctx),
      'adapter_unimplemented',
    );
    expect(dataokePaths(upstream)).toHaveLength(1);
    expect(upstream.topTransport).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B1-04zn#16] 开关值在 taobao live 时原样交给适配器；没有大淘客凭据时照常启动、不告警、两个端口仍 adapter_unimplemented；taobao replay / demo 不受影响', async () => {
  const upstream = fakeUpstream();
  stubHttp(upstream);
  const observed = observeTaobao();
  const switches = { [CONVERT_VARIABLE]: 'dataoke', [SEARCH_VARIABLE]: 'dataoke' };
  const app = await assemble(configured(switches, false));
  try {
    expect(observed).toHaveBeenCalledTimes(1);
    const options = observed.mock.calls[0]![0];
    expect(options.orderSource).toBeUndefined();
    expect(options.searchSource).toBe('dataoke');
    expect(options.convertSource).toBe('dataoke');
    const adapter = app.registry.get('taobao');
    await refused(() => adapter.searchItems(searchQuery, ctx), 'adapter_unimplemented');
    await refused(
      () => adapter.convert(convertReq, convertIdentity, convertCtx),
      'adapter_unimplemented',
    );
    await refused(() => adapter.listOrders(win, {}, ctx), 'adapter_unimplemented');
    expect(warnings(app.logs)).toEqual([]);
  } finally {
    await app.close();
  }
  for (const mode of ['replay', 'demo'] as const) {
    const dormant = await assemble(configured(switches), { endpoints: endpoints(mode) });
    await dormant.close();
  }
  expect(observed).toHaveBeenCalledTimes(1);
  expect(upstream.dataokeTransport).not.toHaveBeenCalled();
  expect(upstream.topTransport).not.toHaveBeenCalled();
});

it('[AC-B1-04zn#17] 端到端：有数据库句柄与大淘客订单源时装配推广位读者，listOrders 按 ctx.appId 读 union_pids 的全部淘宝推广位（含 retired），只留这些推广位的订单', async () => {
  const upstream = fakeUpstream({
    orders: [rowOf(1, OUR_ADZONE), rowOf(2, FOREIGN_ADZONE), rowOf(3, RETIRED_ADZONE)],
  });
  stubHttp(upstream);
  const database = pidDatabase([
    pidRow({ pid: OUR_SLOT }),
    pidRow({ pid: RETIRED_SLOT, status: 'retired', pid_scene: 'share' }),
    pidRow({ app_id: OTHER_APP, pid: `mm_1000000002_3000000002_${FOREIGN_ADZONE}` }),
    pidRow({ platform: 'pdd', pid: `synthetic-pdd-${FOREIGN_ADZONE}`, pid_scene: 'query' }),
  ]);
  const app = await assemble(configured(), { db: database.db });
  try {
    const adapter = app.registry.get('taobao');
    const ours = await succeeded(() => adapter.listOrders(win, {}, ctx), 'listOrders');
    expect(ours.items.map((order) => order.order_id)).toEqual([
      rowOf(1).trade_id,
      rowOf(3).trade_id,
    ]);
    expect(database.statements).toHaveLength(1);
    const theirs = await succeeded(
      () => adapter.listOrders(win, {}, { ...ctx, appId: OTHER_APP }),
      'listOrders',
    );
    expect(theirs.items.map((order) => order.order_id)).toEqual([rowOf(2).trade_id]);
    // Read again on every call, bound to the calling app.
    expect(database.statements).toHaveLength(2);
    expect(database.statements.map((statement) => statement.parameters)).toEqual([
      expect.arrayContaining([APP, 'taobao']),
      expect.arrayContaining([OTHER_APP, 'taobao']),
    ]);
    expect(dataokePaths(upstream)).toEqual([
      '/api/tb-service/get-order-details',
      '/api/tb-service/get-order-details',
    ]);
    // Each page with orders of other slots: one warn log, without order numbers, amounts or PIDs.
    const slotWarnings = warnings(app.logs).filter((entry) =>
      entry.text.includes('taobao_order_foreign_slot'),
    );
    expect(slotWarnings).toHaveLength(2);
    for (const marker of [
      String(rowOf(1).trade_id),
      String(rowOf(2).trade_id),
      String(rowOf(3).trade_id),
      '88.80',
      '7.99',
      OUR_SLOT,
      RETIRED_SLOT,
      FOREIGN_ADZONE,
    ]) {
      expect(logText(warnings(app.logs))).not.toContain(marker);
    }
  } finally {
    await app.close();
    await database.db.destroy();
  }
});

it('[AC-B1-04zn#18] 推广位读者只在有数据库句柄且有大淘客订单源时生效：缺一项照常启动、listOrders 仍 adapter_unimplemented 且不读库；两项齐全才可用', async () => {
  const upstream = fakeUpstream({ orders: [rowOf(1, OUR_ADZONE)] });
  stubHttp(upstream);
  const database = pidDatabase([pidRow({ pid: OUR_SLOT })]);
  try {
    const noDatabase = await assemble(configured());
    try {
      await refused(
        () => noDatabase.registry.get('taobao').listOrders(win, {}, ctx),
        'adapter_unimplemented',
      );
    } finally {
      await noDatabase.close();
    }
    const noSource = await assemble(configured({}, false), { db: database.db });
    try {
      await refused(
        () => noSource.registry.get('taobao').listOrders(win, {}, ctx),
        'adapter_unimplemented',
      );
    } finally {
      await noSource.close();
    }
    expect(database.statements).toHaveLength(0);
    expect(upstream.dataokeTransport).not.toHaveBeenCalled();

    const both = await assemble(configured(), { db: database.db });
    try {
      const page = await succeeded(
        () => both.registry.get('taobao').listOrders(win, {}, ctx),
        'listOrders',
      );
      expect(page.items.map((order) => order.order_id)).toEqual([rowOf(1).trade_id]);
      expect(database.statements).toHaveLength(1);
    } finally {
      await both.close();
    }
  } finally {
    await database.db.destroy();
  }
});

it('[AC-B1-04zn#19] 订单告警写一条 warn 日志：平铺字段，只带事件码与计数，不带订单号、金额或推广位', async () => {
  const upstream = fakeUpstream();
  stubHttp(upstream);
  const observed = observeTaobao();
  const database = pidDatabase([pidRow({ pid: OUR_SLOT })]);
  const app = await assemble(configured(), { db: database.db });
  try {
    expect(observed).toHaveBeenCalledTimes(1);
    const hook = observed.mock.calls[0]![0].orderWarn;
    expect(hook).toBeTypeOf('function');
    const before = app.logs.length;
    const event = {
      event: 'taobao_order_foreign_slot',
      count: 3,
      trade_id: 'FAKE_TRADE_ID_MUST_NOT_LOG',
      alipay_total_price: '88.80',
      pid: OUR_SLOT,
    } as TaobaoOrderWarning;
    hook!(event);
    const added = app.logs.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.level).toBe('warn');
    const fields = added[0]!.args[0];
    expect(fields).toBeTypeOf('object');
    const values = Object.values(fields as Record<string, unknown>);
    for (const value of values) expect(['string', 'number']).toContain(typeof value);
    expect(values).toContain('taobao_order_foreign_slot');
    expect(values).toContain(3);
    for (const marker of ['FAKE_TRADE_ID_MUST_NOT_LOG', '88.80', OUR_SLOT]) {
      expect(logText(added)).not.toContain(marker);
    }

    hook!({ event: 'taobao_order_no_slots' });
    const noSlots = app.logs.slice(before + 1);
    expect(noSlots).toHaveLength(1);
    expect(noSlots[0]!.level).toBe('warn');
    expect(Object.values(noSlots[0]!.args[0] as Record<string, unknown>)).toContain(
      'taobao_order_no_slots',
    );
  } finally {
    await app.close();
    await database.db.destroy();
  }
});
