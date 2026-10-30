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
  freshText,
  mount,
  openDiffs,
  periodField,
  query,
  rowsOf,
  scope,
  settle,
  settled,
  snapshotText,
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
    // The table read of the query (the page may also send count reads with other parameters).
    const filtered = () =>
      server
        .reads()
        .slice(before)
        .filter((read) => read.query['type'] !== undefined);
    await waitFor(() => expect(filtered().length).toBeGreaterThan(0));
    await settled(server);
    const sent = filtered().at(-1)!;
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
    const filtered = () =>
      server
        .reads()
        .slice(before)
        .filter((read) => read.query['ref_id'] !== undefined);
    await waitFor(() => expect(filtered().length).toBeGreaterThan(0));
    await settled(server);
    const sent = filtered().at(-1)!;
    expect(sent.query['ref_id']).toBe(REF.union);
    for (const name of ['type', 'source', 'status', 'period_from', 'period_to'])
      expect(sent.query[name], `no ${name}`).toBeUndefined();
    await waitFor(() => expect(rowsOf(scope(), [REF.ledger])).toEqual([]));
    expect(rowsOf(scope(), [REF.union])).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-FILTER#3] 【重置】清空筛选：表格以不带筛选参数的请求重新读取，之后的请求不再带已清空的条件，六条差错单重新列出',
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
    const after = server.reads().slice(before);
    // The table is read again without any filter (count reads with their own parameters aside)…
    expect(
      after.some((sent) => FILTER_PARAMS.every((name) => sent.query[name] === undefined)),
      'an unfiltered list read after 【重置】',
    ).toBe(true);
    // …and no read after 【重置】 still carries the cleared conditions.
    for (const sent of after) {
      expect(sent.query['ref_id'], 'ref_id cleared').toBeUndefined();
      expect(sent.query['status'], 'status cleared').not.toBe('written_off');
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-FILTER#4] 周期起大于周期止（日值）：周期字段旁有提示，或发出的请求收 20001 [period_from, period_to] 后给出提示',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.ledger);
    await settled(server);
    const reads = server.reads().length;
    // Day values (YYYY-MM-DD): a date picker takes them as well as a plain input.
    await fillPeriod(periodField('from'), '2026-10-31');
    await fillPeriod(periodField('to'), '2026-10-01');
    await settle();
    const before = snapshotText();
    await query();
    await settled(server);
    // The exact text sent for the period is not fixed here: only that a reversed range went out
    // (the fake server answers it with 20001 [period_from, period_to]).
    const sentRange = (): boolean =>
      server
        .reads()
        .slice(reads)
        .some((read) => {
          const { period_from: from, period_to: to } = read.query;
          return from !== undefined && to !== undefined && from > to;
        });
    await waitFor(() => {
      const nextToFields = `${fieldError(periodField('from'))} ${fieldError(periodField('to'))}`;
      const told = nextToFields.trim() !== '' || (sentRange() && freshText(before) !== '');
      expect(told, 'a notice next to the period fields, or after the 20001 of the range').toBe(
        true,
      );
    });
  },
  FLOW_TIMEOUT,
);
