// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  JD_ACCOUNT,
  JD_NAME,
  PDD_NAME,
  PENDING_JD_ID,
  PENDING_TAOBAO_ID,
  PID,
  PIDS,
  PID_FIELDS,
  SITE,
  TAOBAO_NAME,
  createServer,
  failure,
  pidUrl,
} from './fixtures.ts';
import {
  CONFLICT,
  FLOW_TIMEOUT,
  LABEL,
  assertVerified,
  assertWrite,
  choose,
  click,
  dialog,
  fieldError,
  fill,
  hasRow,
  mount,
  openEdit,
  row,
  settle,
  stepUp,
  stepUpOpen,
  submit,
  textbox,
  textboxes,
  verify,
} from './helpers.ts';

const EDIT = /修改/;

it(
  '[AC-F1-10gb-EDIT#1] 修改待确认行：带出原值，PATCH 只发改动的字段、expected_row_version 与原因',
  async () => {
    const { server } = await mount();
    const form = await openEdit(PID.pendingJd);
    expect(textbox(form, LABEL.pid).value).toBe(PID.pendingJd);
    await fill(textbox(form, LABEL.pid), '4003');
    await fill(textbox(form, LABEL.reason), '登记时推广位填错');
    const modal = await stepUp(form);
    expect(server.requests('PATCH')).toEqual([]);
    await verify(modal);
    await waitFor(() => expect(server.requests('PATCH', pidUrl(PENDING_JD_ID))).toHaveLength(1));
    const sent = server.requests('PATCH', pidUrl(PENDING_JD_ID))[0]!;
    expect(sent.body).toEqual({ pid: '4003', expected_row_version: 0, reason: '登记时推广位填错' });
    assertWrite(sent);
    assertVerified(server);
    await waitFor(() => expect(hasRow('4003')).toBe(true));
    expect(hasRow(PID.pendingJd)).toBe(false);
    expect(row('4003').textContent).toContain('待确认');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-EDIT#2] 什么都没改：不发带原值的 PATCH；发了只带版本时按 20001 [body] 提示',
  async () => {
    const { server } = await mount();
    const form = await openEdit(PID.pendingJd);
    expect(textbox(form, LABEL.pid).value).toBe(PID.pendingJd);
    await click(submit(form));
    await settle();
    if (stepUpOpen()) await verify(await dialog(/^二次验证/));
    await settle();
    const sent = server.requests('PATCH');
    for (const request of sent) {
      const keys = Object.keys((request.body ?? {}) as Record<string, unknown>);
      expect(keys.filter((key) => (PID_FIELDS as readonly string[]).includes(key))).toEqual([]);
    }
    if (sent.length > 0)
      await waitFor(() =>
        expect(document.body.textContent).toMatch(
          /未修改|没有修改|无改动|未更改|没有变化|未做.*修改/,
        ),
      );
    expect(row(PID.pendingJd).textContent).toContain('待确认');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-EDIT#3] 淘宝待确认行改到京东：账号只列京东的，site_id 清为 null 一并发送',
  async () => {
    const { server } = await mount();
    const form = await openEdit(PID.pendingTaobao);
    expect(textbox(form, LABEL.site).value).toBe(SITE);
    await choose(form, LABEL.platform, /京东|jd/i);
    const offered = await choose(form, LABEL.account, new RegExp(JD_NAME));
    expect(offered.join('|')).not.toContain(TAOBAO_NAME);
    expect(offered.join('|')).not.toContain(PDD_NAME);
    for (const input of textboxes(form, LABEL.site)) expect(input.value).toBe('');
    await verify(await stepUp(form));
    await waitFor(() =>
      expect(server.requests('PATCH', pidUrl(PENDING_TAOBAO_ID))).toHaveLength(1),
    );
    expect(server.requests('PATCH', pidUrl(PENDING_TAOBAO_ID))[0]!.body).toEqual({
      platform: 'jd',
      union_account_id: JD_ACCOUNT,
      site_id: null,
      expected_row_version: 3,
    });
    await waitFor(() => expect(row(PID.pendingTaobao).textContent).toMatch(/jd|京东/i));
    expect(row(PID.pendingTaobao).textContent).not.toContain(SITE);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-EDIT#4] 20902（行已变化）提示刷新并重新读取列表，不自动重发',
  async () => {
    const server = createServer();
    server.once('PATCH', pidUrl(PENDING_JD_ID), () => {
      const index = server.state.findIndex((item) => item.pid_id === PENDING_JD_ID);
      server.state[index] = { ...server.state[index]!, pid: '4009', row_version: 1 };
      return failure(20902, { resource: 'union_pid' });
    });
    await mount(server);
    const form = await openEdit(PID.pendingJd);
    expect(document.body.textContent).not.toMatch(CONFLICT);
    await fill(textbox(form, LABEL.pid), '4003');
    await verify(await stepUp(form));
    await waitFor(() => expect(document.body.textContent).toMatch(CONFLICT));
    await waitFor(() => expect(server.requests('GET', PIDS)).toHaveLength(2));
    await waitFor(() => expect(hasRow('4009')).toBe(true));
    await settle();
    expect(server.requests('PATCH')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-EDIT#5] 修改时 20001 fields=[pid]（同平台 PID 已登记）在 PID 旁提示',
  async () => {
    const server = createServer();
    server.once('PATCH', pidUrl(PENDING_JD_ID), () => failure(20001, { fields: ['pid'] }));
    await mount(server);
    const form = await openEdit(PID.pendingJd);
    await fill(textbox(form, LABEL.pid), '4008');
    await verify(await stepUp(form));
    await waitFor(() => expect(server.requests('PATCH')).toHaveLength(1));
    const current = await dialog(EDIT);
    await waitFor(() => fieldError(textbox(current, LABEL.pid)));
    await settle();
    expect(server.requests('PATCH')).toHaveLength(1);
    expect(hasRow('4008')).toBe(false);
  },
  FLOW_TIMEOUT,
);
