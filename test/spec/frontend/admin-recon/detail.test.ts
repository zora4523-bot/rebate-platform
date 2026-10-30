// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  HANDLER,
  ID,
  REF,
  RESOLUTION_REASON,
  SOURCE_NAME,
  STATUS_NAME,
  TYPE_NAME,
  VIEW_GRANTS,
  createServer,
  detailPath,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  mount,
  openDetail,
  settled,
  showsAmount,
  squash,
  textOf,
} from './helpers.ts';

const UNHANDLED = /未处理|尚未处理|暂无处理人|无处理人|暂未处理/;

it(
  '[AC-F1-08e-DETAIL#1] 详情抽屉（已关闭的差错单，只持 fund.view）：读该条详情，显示三项金额、类型、来源、状态、周期、关联单据、创建与结案时刻、处理人与结案原因',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server);
    const drawer = await openDetail(server, REF.union, ID.union);
    await settled(server);
    expect(server.requests('GET', detailPath(ID.union)).length).toBeGreaterThan(0);
    const text = squash(drawer.textContent);
    expect(text).toContain(TYPE_NAME.union_mismatch);
    expect(text).toContain(SOURCE_NAME.R1);
    expect(text).toContain(STATUS_NAME.closed);
    expect(text).toContain('2026-09');
    expect(text).toContain(REF.union);
    expect(showsAmount(textOf(drawer), 1234), '我方已记 12.34').toBe(true);
    expect(showsAmount(textOf(drawer), 1200), '对方 12.00').toBe(true);
    expect(showsAmount(textOf(drawer), 34), '差额 0.34').toBe(true);
    expect(text, 'created_at in Beijing time').toContain('2026-10-2010:00');
    expect(text, 'closed_at in Beijing time').toContain('2026-10-2016:30');
    expect(text, 'handler').toContain(HANDLER.slice(0, 8));
    expect(text, 'resolution.reason').toContain(RESOLUTION_REASON);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-DETAIL#2] 详情抽屉（待处理、handler_id 为 null）：处理人显示未处理类文案，金额按分换算，不显示结案原因',
  async () => {
    const server = createServer();
    await mount(server);
    const drawer = await openDetail(server, REF.ledger, ID.ledger);
    const text = squash(drawer.textContent);
    expect(text).toContain(TYPE_NAME.ledger_mismatch);
    expect(text).toContain(SOURCE_NAME.R3);
    expect(text).toContain(STATUS_NAME.open);
    expect(text).toContain('2026-10-20');
    expect(text).toContain(REF.ledger);
    expect(text, 'created_at in Beijing time').toContain('2026-10-2101:05');
    expect(text).toMatch(UNHANDLED);
    expect(showsAmount(textOf(drawer), 12000), '我方已记 120.00').toBe(true);
    expect(showsAmount(textOf(drawer), 11800), '对方 118.00').toBe(true);
    expect(showsAmount(textOf(drawer), 200), '差额 2.00').toBe(true);
    expect(text).not.toContain(RESOLUTION_REASON);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-DETAIL#3] resolution 没有 reason 键（已调账）：抽屉照常打开、显示处理人，负差额带负号',
  async () => {
    const server = createServer();
    await mount(server);
    const drawer = await openDetail(server, REF.monthEnd, ID.monthEnd);
    const text = squash(drawer.textContent);
    expect(text).toContain(STATUS_NAME.adjusted);
    expect(text).toContain(TYPE_NAME.month_end_unbalanced);
    expect(text, 'handler').toContain(HANDLER.slice(0, 8));
    expect(showsAmount(textOf(drawer), -211), '差额 -2.11').toBe(true);
    expect(text).not.toContain(RESOLUTION_REASON);
  },
  FLOW_TIMEOUT,
);
