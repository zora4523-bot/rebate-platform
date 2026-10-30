// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { FILTER_PARAMS, LIST_PARAMS, NO, createServer, samples } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  LABEL,
  RESET,
  action,
  choose,
  click,
  dateField,
  extraParams,
  fill,
  fillDate,
  listed,
  mount,
  openList,
  query,
  rowsOf,
  scope,
  settle,
  settled,
  tabsNamed,
  textbox,
} from './helpers.ts';

const ALL = samples().map((item) => item.out_biz_no);

it(
  '[AC-F1-08a-FILTER#1] 审核方式 + 收款方式 + 申请时间区间：【查询】带 review_mode / payout_channel / created_from / created_to（带时区偏移、结束日整天包含），从第 1 页起，只列命中的行',
  async () => {
    const server = createServer();
    await mount(server);
    await openList(server, NO.pending);
    await settled(server);
    const before = server.reads().length;
    await choose(scope(), LABEL.reviewMode, /^人工审核$/);
    await choose(scope(), LABEL.channel, /^(?:银行卡|bank_card)/);
    await fillDate(dateField('from'), '2026-10-01');
    await fillDate(dateField('to'), '2026-10-15');
    await query();
    // The table read of the query (the page may also send count reads with other parameters).
    const filtered = () =>
      server
        .reads()
        .slice(before)
        .filter((read) => read.query['review_mode'] !== undefined);
    await waitFor(() => expect(filtered().length).toBeGreaterThan(0));
    await settled(server);
    const sent = filtered().at(-1)!;
    expect(sent.query).toMatchObject({ review_mode: 'manual', payout_channel: 'bank_card' });
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent, LIST_PARAMS)).toEqual([]);
    // Application time: from the start of 10-01 (Beijing) to the end of 10-15 (created_to is
    // exclusive, so anything after 10-15 00:00 up to 10-16 00:00 covers the whole end day).
    const from = Date.parse(sent.query['created_from'] ?? '');
    const to = Date.parse(sent.query['created_to'] ?? '');
    expect(from, 'created_from').toBe(Date.parse('2026-10-01T00:00:00+08:00'));
    expect(to, 'created_to after 10-15 00:00').toBeGreaterThan(
      Date.parse('2026-10-15T00:00:00+08:00'),
    );
    expect(to, 'created_to not after 10-16 00:00').toBeLessThanOrEqual(
      Date.parse('2026-10-16T00:00:00+08:00'),
    );
    await waitFor(() => expect(listed(ALL)).toEqual([NO.manualPaid]));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-FILTER#2] 提现单号精确筛选：【查询】带 out_biz_no，只列该单',
  async () => {
    const server = createServer();
    await mount(server);
    await openList(server, NO.pending);
    await settled(server);
    const before = server.reads().length;
    await fill(textbox(scope(), LABEL.outBizNo), NO.rejected);
    await query();
    const filtered = () =>
      server
        .reads()
        .slice(before)
        .filter((read) => read.query['out_biz_no'] !== undefined);
    await waitFor(() => expect(filtered().length).toBeGreaterThan(0));
    await settled(server);
    const sent = filtered().at(-1)!;
    expect(sent.query['out_biz_no']).toBe(NO.rejected);
    for (const name of ['review_mode', 'payout_channel', 'created_from', 'created_to'])
      expect(sent.query[name], `no ${name}`).toBeUndefined();
    await waitFor(() => expect(listed(ALL)).toEqual([NO.rejected]));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-FILTER#3] 【重置】清空筛选：表格以不带筛选参数的请求重新读取，之后的请求不再带已清空的条件，七张单重新列出',
  async () => {
    const server = createServer();
    await mount(server);
    await openList(server, NO.pending);
    await choose(scope(), LABEL.reviewMode, /^人工审核$/);
    await fill(textbox(scope(), LABEL.outBizNo), NO.manualPaid);
    await query();
    await waitFor(() => expect(listed(ALL)).toEqual([NO.manualPaid]));
    await settled(server);
    const before = server.reads().length;
    await click(action(scope(), RESET));
    await settle();
    await settled(server);
    // Some pages list again on 【重置】, others wait for 【查询】.
    if (rowsOf(scope(), [NO.pending]).length === 0) {
      await query();
      await settled(server);
    }
    await waitFor(() => expect(listed(ALL)).toEqual(ALL));
    expect(textbox(scope(), LABEL.outBizNo).value).toBe('');
    const after = server.reads().slice(before);
    expect(
      after.some((sent) => FILTER_PARAMS.every((name) => sent.query[name] === undefined)),
      'an unfiltered list read after 【重置】',
    ).toBe(true);
    for (const sent of after) {
      expect(sent.query['out_biz_no'], 'out_biz_no cleared').toBeUndefined();
      expect(sent.query['review_mode'], 'review_mode cleared').toBeUndefined();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-FILTER#4] 筛选已改未应用：改了审核方式与提现单号、未点【查询】时不发列表请求，列表仍是旧结果；点【查询】后才带新条件请求',
  async () => {
    const server = createServer();
    await mount(server);
    await openList(server, NO.pending);
    await settled(server);
    const before = server.reads().length;
    await choose(scope(), LABEL.reviewMode, /^人工审核$/);
    await fill(textbox(scope(), LABEL.outBizNo), NO.rejected);
    await settle();
    await settled(server);
    expect(server.reads().length, 'no list read before 【查询】').toBe(before);
    expect(listed(ALL), 'the old result stays').toEqual(ALL);
    await query();
    await waitFor(() =>
      expect(
        server
          .reads()
          .slice(before)
          .some(
            (read) =>
              read.query['review_mode'] === 'manual' && read.query['out_biz_no'] === NO.rejected,
          ),
      ).toBe(true),
    );
    await settled(server);
    await waitFor(() => expect(listed(ALL)).toEqual([NO.rejected]));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-FILTER#5] 状态页签：「待审」带 display_status=pending_review 只列待审单（含已通过待执行），「驳回」只列驳回单，「全部」重新列出全部',
  async () => {
    const server = createServer();
    await mount(server);
    await openList(server, NO.pending);
    await settled(server);
    const tab = (name: string): HTMLElement => {
      const found = tabsNamed(name, scope());
      expect(found.length, `a status tab ${name}`).toBeGreaterThan(0);
      return found[0]!;
    };
    let before = server.reads().length;
    await click(tab('待审'));
    await waitFor(() =>
      expect(
        server
          .reads()
          .slice(before)
          .some((read) => read.query['display_status'] === 'pending_review'),
        'a read with display_status=pending_review',
      ).toBe(true),
    );
    await settled(server);
    await waitFor(() => expect(listed(ALL)).toEqual([NO.pending, NO.approved]));

    before = server.reads().length;
    await click(tab('驳回'));
    await waitFor(() =>
      expect(
        server
          .reads()
          .slice(before)
          .some(
            (read) =>
              read.query['display_status'] === 'rejected' || read.query['status'] === 'REJECTED',
          ),
        'a read of the rejected withdrawals',
      ).toBe(true),
    );
    await settled(server);
    await waitFor(() => expect(listed(ALL)).toEqual([NO.rejected]));

    await click(tab('全部'));
    await settled(server);
    await waitFor(() => expect(listed(ALL)).toEqual(ALL));
  },
  FLOW_TIMEOUT,
);
