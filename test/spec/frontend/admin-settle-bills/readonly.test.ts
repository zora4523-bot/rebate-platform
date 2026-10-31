// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BATCH, BILL, VIEW_GRANTS, createServer, snapshot } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  WRITE_ACTIONS,
  actions,
  assertNoStepUp,
  click,
  idRows,
  listed,
  main,
  mount,
  openBill,
  openItems,
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
  '[AC-F1-08d-READONLY#1] 只持 fund.view：列表与已出账账单详情（两个待确认批次）都没有可用的确认 / 定时 / 驳回 / 补充批次 / 上传等写入口；点了也只发三个 GET，不弹动态码',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server, { snapshot: snapshot(VIEW_GRANTS) });
    await listed(BILL.issued);
    expect(usable(main(), WRITE_ACTIONS), 'no usable write on the list').toEqual([]);
    await openBill(server, BILL.issued, BATCH.issuedTaobao);
    expect(usable(document.body, WRITE_ACTIONS), 'no usable write on the detail').toEqual([]);
    await pressWrites();
    await openItems(server, BATCH.issuedTaobao);
    expect(usable(document.body, WRITE_ACTIONS), 'no usable write with the items').toEqual([]);
    await pressWrites();
    await settled(server);
    expect(server.others(), 'only the three GETs of CT-24z').toEqual([]);
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-READONLY#2] 只持 fund.view 看结算中的账单（PARTIAL 被开关停下、CONFIRMED 定时）：没有可用的【继续执行】【撤销定时】【发起补充批次】等写入口；点了也只发三个 GET',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server, {
      snapshot: snapshot(VIEW_GRANTS),
      route: `settle-bills/${BILL.settling}`,
    });
    await waitFor(() => expect(server.billReads(BILL.settling).length).toBeGreaterThan(0));
    await settled(server);
    for (const id of [BATCH.partial, BATCH.scheduled])
      await waitFor(() => expect(idRows(id), id.slice(0, 8)).toHaveLength(1));
    expect(usable(document.body, WRITE_ACTIONS), 'no usable write on the detail').toEqual([]);
    await pressWrites();
    await settled(server);
    expect(server.others(), 'only the three GETs of CT-24z').toEqual([]);
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);
