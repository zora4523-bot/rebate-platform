// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  OTHER_PLATFORMS,
  PLATFORM_NAME,
  SYNCS,
  createServer,
  limits,
  rejected,
} from './fixtures.ts';
import {
  END,
  FLOW_TIMEOUT,
  REUSED,
  START,
  SUBMITTED,
  assertPlainWrite,
  assertWindowBody,
  choosePlatform,
  fieldError,
  fillTime,
  freshText,
  mountList,
  openSyncDialog,
  prepareWindow,
  settled,
  snapshotText,
  submit,
  syncDialog,
  textbox,
} from './helpers.ts';

it(
  '[AC-F1-07eb-WINDOW#1] 打开【手动同步】才读 limits；按时间窗提交的 body 恰为 platform 与带时区的北京时间 from / to（无 order_nos、无身份字段），无动态码、无 Idempotency-Key，提示已提交',
  async () => {
    const { server } = await mountList();
    expect(server.limitReads(), 'limits are not read before the dialog opens').toEqual([]);
    await openSyncDialog();
    await waitFor(() => expect(server.limitReads().length).toBeGreaterThan(0));
    await settled(server);
    expect(server.posts()).toEqual([]);
    const dialog = await prepareWindow(
      server,
      PLATFORM_NAME.pdd,
      '2026-10-21 00:00',
      '2026-10-22 00:00',
    );
    expect(server.posts(), 'nothing is sent before 【提交同步】').toEqual([]);
    const before = snapshotText();
    await submit(dialog);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    const sent = server.posts()[0]!;
    assertPlainWrite(sent);
    assertWindowBody(sent, 'pdd', '2026-10-21T00:00:00+08:00', '2026-10-22T00:00:00+08:00');
    await waitFor(() => expect(freshText(before)).toMatch(SUBMITTED));
    expect(freshText(before)).not.toMatch(REUSED);
    expect(server.created()).toHaveLength(1);
    expect(server.posts()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-WINDOW#2] 对话框的平台只取 limits 列出的平台',
  async () => {
    const server = createServer({
      limits: limits().filter((one) => one.platform !== 'jd'),
    });
    await mountList(server);
    const dialog = await openSyncDialog();
    await waitFor(() => expect(server.limitReads().length).toBeGreaterThan(0));
    await settled(server);
    const offered = await choosePlatform(dialog, PLATFORM_NAME.taobao);
    expect(offered.some((text) => PLATFORM_NAME.pdd.test(text))).toBe(true);
    expect(offered.some((text) => PLATFORM_NAME.taobao.test(text))).toBe(true);
    expect(offered.filter((text) => OTHER_PLATFORMS.test(text))).toEqual([]);
    expect(server.posts()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-WINDOW#3] 开始时间早于 limits 的 earliest_from：前端拦下或收 20001 [from]，都在开始时间旁提示、不建同步、不显示成功',
  async () => {
    const { server } = await mountList();
    const dialog = await prepareWindow(
      server,
      PLATFORM_NAME.pdd,
      '2026-07-01 00:00',
      '2026-07-02 00:00',
    );
    const before = snapshotText();
    await submit(dialog);
    await settled(server);
    await waitFor(() =>
      expect(fieldError(textbox(syncDialog(), START)), 'a hint next to the start time').not.toBe(
        '',
      ),
    );
    await settled(server);
    expect(server.created()).toEqual([]);
    expect(freshText(before)).not.toMatch(SUBMITTED);
    expect(freshText(before)).not.toMatch(REUSED);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-WINDOW#4] 开始时间不早于结束时间：前端拦下或收 20001 [from, to]，都在时间旁提示、不建同步、不显示成功',
  async () => {
    const { server } = await mountList();
    const dialog = await prepareWindow(
      server,
      PLATFORM_NAME.pdd,
      '2026-10-21 00:00',
      '2026-10-21 00:00',
    );
    const before = snapshotText();
    await submit(dialog);
    await settled(server);
    await waitFor(() => {
      const shown = syncDialog();
      expect(
        `${fieldError(textbox(shown, START))}${fieldError(textbox(shown, END))}`,
        'a hint next to the time window',
      ).not.toBe('');
    });
    await settled(server);
    expect(server.created()).toEqual([]);
    expect(freshText(before)).not.toMatch(SUBMITTED);
    expect(freshText(before)).not.toMatch(REUSED);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-WINDOW#5] 输入合规而服务端回 20001 data.fields=[from]（earliest_from 已随时钟前移）：开始时间旁提示，对话框不关、不显示成功、不自动重发',
  async () => {
    const { server } = await mountList();
    server.once('POST', SYNCS, () => rejected(['from']));
    const dialog = await prepareWindow(
      server,
      PLATFORM_NAME.taobao,
      '2026-10-21 00:00',
      '2026-10-22 00:00',
    );
    const before = snapshotText();
    await submit(dialog);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    assertWindowBody(
      server.posts()[0]!,
      'taobao',
      '2026-10-21T00:00:00+08:00',
      '2026-10-22T00:00:00+08:00',
    );
    await waitFor(() =>
      expect(fieldError(textbox(syncDialog(), START)), 'a hint next to the start time').not.toBe(
        '',
      ),
    );
    expect(server.posts()).toHaveLength(1);
    expect(server.created()).toEqual([]);
    expect(freshText(before)).not.toMatch(SUBMITTED);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-WINDOW#6] 本段不做订单状态筛选：按时间窗提交（京东、跨天时间窗）的 body 恰为 platform 与 from / to，不带 status_filter（也无 order_nos、无身份字段）',
  async () => {
    const { server } = await mountList();
    await prepareWindow(server, PLATFORM_NAME.jd, '2026-10-19 00:30', '2026-10-20 12:00');
    expect(server.posts(), 'nothing is sent before 【提交同步】').toEqual([]);
    const before = snapshotText();
    await submit(syncDialog());
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    const sent = server.posts()[0]!;
    assertPlainWrite(sent);
    expect(sent.body, 'no status filter in this part').not.toHaveProperty('status_filter');
    assertWindowBody(sent, 'jd', '2026-10-19T00:30:00+08:00', '2026-10-20T12:00:00+08:00');
    await waitFor(() => expect(freshText(before)).toMatch(SUBMITTED));
    expect(server.created()).toHaveLength(1);
    expect(server.posts()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-WINDOW#7] 服务端回 20001 data.fields=[from, to] 后改结束时间再提交：时间旁提示、不自动重发；再次提交才建同步，两次 body 都恰为 platform 与 from / to、不带 status_filter',
  async () => {
    const { server } = await mountList();
    server.once('POST', SYNCS, () => rejected(['from', 'to']));
    await prepareWindow(server, PLATFORM_NAME.taobao, '2026-10-21 00:00', '2026-10-22 00:00');
    const before = snapshotText();
    await submit(syncDialog());
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    await waitFor(() => {
      const shown = syncDialog();
      expect(
        `${fieldError(textbox(shown, START))}${fieldError(textbox(shown, END))}`,
        'a hint next to the time window',
      ).not.toBe('');
    });
    expect(server.posts(), 'no automatic resend').toHaveLength(1);
    expect(server.created()).toEqual([]);
    expect(freshText(before)).not.toMatch(SUBMITTED);

    await fillTime(textbox(syncDialog(), END), '2026-10-23 00:00');
    const again = snapshotText();
    await submit(syncDialog());
    await waitFor(() => expect(server.posts()).toHaveLength(2));
    await settled(server);
    const [first, second] = server.posts();
    for (const sent of [first!, second!]) {
      assertPlainWrite(sent);
      expect(sent.body, 'no status filter in this part').not.toHaveProperty('status_filter');
    }
    assertWindowBody(first!, 'taobao', '2026-10-21T00:00:00+08:00', '2026-10-22T00:00:00+08:00');
    assertWindowBody(second!, 'taobao', '2026-10-21T00:00:00+08:00', '2026-10-23T00:00:00+08:00');
    expect(server.created()).toHaveLength(1);
    await waitFor(() => expect(freshText(again)).toMatch(SUBMITTED));
  },
  FLOW_TIMEOUT,
);
