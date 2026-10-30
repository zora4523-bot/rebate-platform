// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DAY, LEDGER_GRANTS, LIST, SUPER, createServer, dailySnapshots } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  WRITE_ACTIONS,
  actions,
  assertNoStepUp,
  click,
  dayRow,
  fillRange,
  listed,
  main,
  mount,
  nextPageNear,
  query,
  settle,
  settled,
  usable,
} from './helpers.ts';

/** Presses every write-named control of the page (a disabled one does nothing). */
async function pressWrites(): Promise<void> {
  for (const node of actions(document.body, WRITE_ACTIONS)) {
    await click(node);
    await settle();
  }
}

it(
  '[AC-F1-08ga-READONLY#1] 持 fund.view 与 fund.cash_entry：页面没有可用的【录入企业支付宝余额】【录入联盟回款】【导出】等写入口；点了、筛选、翻页也只发 GET /admin/v1/asset-snapshots，不弹动态码',
  async () => {
    const server = createServer(dailySnapshots(205), { permissions: LEDGER_GRANTS });
    await mount(server);
    await listed(DAY.latest);
    expect(usable(main(), WRITE_ACTIONS), 'no usable write on the page').toEqual([]);
    await pressWrites();
    await nextPageNear(dayRow(DAY.latest));
    await settled(server);
    await waitFor(() =>
      expect(server.reads().some((read) => read.query['page'] === '2')).toBe(true),
    );
    await fillRange('2026-10-01', '2026-10-29');
    await query();
    await settled(server);
    expect(usable(document.body, WRITE_ACTIONS), 'no usable write after paging').toEqual([]);
    await pressWrites();
    await settled(server);
    expect(server.others(), 'only GET /admin/v1/asset-snapshots').toEqual([]);
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(server.requests('GET', LIST).length).toBeGreaterThan(0);
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-READONLY#2] 超管：同样没有可用的录入 / 导出入口；点了也只发 GET /admin/v1/asset-snapshots，不弹动态码',
  async () => {
    const server = createServer();
    await mount(server, { snapshot: SUPER });
    await listed(DAY.latest);
    await settled(server);
    expect(usable(document.body, WRITE_ACTIONS), 'no usable write for a super admin').toEqual([]);
    await pressWrites();
    await settled(server);
    expect(server.others(), 'only GET /admin/v1/asset-snapshots').toEqual([]);
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);
