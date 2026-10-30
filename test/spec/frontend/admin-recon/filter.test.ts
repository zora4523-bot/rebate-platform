// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { FILTER_PARAMS, LIST_PARAMS, REF, createServer, diffs } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  LABEL,
  RESET,
  action,
  choose,
  click,
  extraParams,
  fieldError,
  fill,
  fillPeriod,
  mount,
  openDiffs,
  periodField,
  query,
  rowsOf,
  scope,
  settle,
  settled,
  textbox,
} from './helpers.ts';

it(
  '[AC-F1-08e-FILTER#1] 类型 + 来源 + 状态 + 周期区间筛选：【查询】带 type / source / status / period_from / period_to，从第 1 页起，只列命中的行',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.ledger);
    await settled(server);
    const before = server.reads().length;
    await choose(scope(), LABEL.type, /^账实不符$/);
    await choose(scope(), LABEL.source, /^内部日终$/);
    await choose(scope(), LABEL.status, /^待处理$/);
    await fillPeriod(periodField('from'), '2026-10-01');
    await fillPeriod(periodField('to'), '2026-10-31');
    await query();
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(before));
    await settled(server);
    const sent = server.reads().at(-1)!;
    expect(sent.query).toMatchObject({
      type: 'ledger_mismatch',
      source: 'R3',
      status: 'open',
      period_from: '2026-10-01',
      period_to: '2026-10-31',
    });
    expect(sent.query['ref_id']).toBeUndefined();
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent, LIST_PARAMS)).toEqual([]);
    await waitFor(() => expect(rowsOf(scope(), [REF.channel])).toEqual([]));
    expect(rowsOf(scope(), [REF.ledger])).toHaveLength(1);
    for (const ref of [REF.union, REF.appeal, REF.monthEnd, REF.settle])
      expect(rowsOf(scope(), [ref]), ref).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-FILTER#2] 关联单据号精确筛选：【查询】带 ref_id，只列该单据的差错单',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.ledger);
    await settled(server);
    const before = server.reads().length;
    await fill(textbox(scope(), LABEL.ref), REF.union);
    await query();
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(before));
    await settled(server);
    const sent = server.reads().at(-1)!;
    expect(sent.query['ref_id']).toBe(REF.union);
    for (const name of ['type', 'source', 'status', 'period_from', 'period_to'])
      expect(sent.query[name], `no ${name}`).toBeUndefined();
    await waitFor(() => expect(rowsOf(scope(), [REF.ledger])).toEqual([]));
    expect(rowsOf(scope(), [REF.union])).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-FILTER#3] 【重置】清空筛选：之后的列表请求不带任何筛选参数，六条差错单重新列出',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.ledger);
    await choose(scope(), LABEL.status, /^已核销$/);
    await fill(textbox(scope(), LABEL.ref), REF.settle);
    await query();
    await waitFor(() => expect(rowsOf(scope(), [REF.ledger])).toEqual([]));
    await settled(server);
    const before = server.reads().length;
    await click(action(scope(), RESET));
    await settle();
    await settled(server);
    // Some pages list again on 【重置】, others wait for 【查询】.
    if (rowsOf(scope(), [REF.ledger]).length === 0) {
      await query();
      await settled(server);
    }
    for (const item of diffs())
      await waitFor(() => expect(rowsOf(scope(), [item.ref_id]), item.ref_id).toHaveLength(1));
    expect(textbox(scope(), LABEL.ref).value).toBe('');
    for (const sent of server.reads().slice(before))
      expect(FILTER_PARAMS.filter((name) => sent.query[name] !== undefined)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-FILTER#4] 周期起大于周期止：在周期字段旁提示（前端拦下或服务端 20001 [period_from, period_to] 都可），不显示错误的结果',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.ledger);
    await settled(server);
    await fillPeriod(periodField('from'), '2026-10');
    await fillPeriod(periodField('to'), '2026-09');
    await query();
    await settled(server);
    await waitFor(() =>
      expect(
        `${fieldError(periodField('from'))} ${fieldError(periodField('to'))}`.trim(),
        'an error next to the period fields',
      ).not.toBe(''),
    );
    // Either nothing was sent, or the range as typed (the server answered 20001).
    for (const sent of server.reads().filter((read) => read.query['period_from'] !== undefined))
      expect(sent.query).toMatchObject({ period_from: '2026-10', period_to: '2026-09' });
  },
  FLOW_TIMEOUT,
);
