// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ALL_GRANTS, ID, NO, createServer, detailRoute } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  WRITE,
  assertReadOnly,
  detailShown,
  main,
  mount,
  openDetail,
  openList,
  otherWithdrawalRequests,
  settled,
  usable,
} from './helpers.ts';

it(
  '[AC-F1-08a-READONLY#1] 审核列表（账号持 withdraw.review、payout.execute、payout.manual_entry、export 等全部写权限点）：没有可点的【批量通过】【批量手动打款】【批量自动打款】【导出】等写入口，点任何一个都不发 GET 以外的请求',
  async () => {
    const server = createServer(undefined, { permissions: ALL_GRANTS });
    await mount(server);
    await openList(server, NO.pending);
    await settled(server);
    await assertReadOnly(server);
    expect(otherWithdrawalRequests(server), 'only the list and detail reads').toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-READONLY#2] 提现单详情（待审核、已通过待执行、微信等用户确认三种状态，全部写权限点）：没有可点的【审核通过】【驳回】【执行打款】【手动成功】【撤销微信转账】【重新计算】，只发 GET 列表 / 详情',
  async () => {
    const cases = [
      { id: ID.pending, number: NO.pending },
      { id: ID.approved, number: NO.approved },
      { id: ID.paying, number: NO.paying },
    ];
    for (const { id, number } of cases) {
      const server = createServer(undefined, { permissions: ALL_GRANTS });
      await mount(server, { route: detailRoute(id) });
      await detailShown(server, id, number);
      expect(usable(main(), WRITE), `${number}: no usable write entry`).toEqual([]);
      await assertReadOnly(server);
      expect(otherWithdrawalRequests(server), `${number}: only the two reads`).toEqual([]);
      cleanup();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-READONLY#3] 列表进详情一路（列表 → 【详情】 → 详情）只请求 GET /admin/v1/withdrawals 与 GET /admin/v1/withdrawals/{id}，不请求打款、导出、自动到账设置、风险标签重算或查看全量',
  async () => {
    const server = createServer(undefined, { permissions: ALL_GRANTS });
    await mount(server);
    await openDetail(server, NO.failed, ID.failed);
    await settled(server);
    expect(otherWithdrawalRequests(server)).toEqual([]);
    expect(server.writes()).toEqual([]);
    expect(server.detailReads().every((read) => read.path.endsWith(ID.failed))).toBe(true);
  },
  FLOW_TIMEOUT,
);
