// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ACTIVE_ID,
  PENDING_JD_ID,
  PENDING_TAOBAO_ID,
  PID,
  PIDS,
  SITE,
  TAOBAO_NAME,
  VERIFY,
  activateUrl,
  createServer,
  failure,
  pidUrl,
  retireUrl,
  screenshot,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  LABEL,
  STEP_UP_TITLE,
  action,
  actions,
  assertVerified,
  assertWrite,
  chooseFile,
  choose,
  click,
  dialog,
  fill,
  fillTime,
  mount,
  openActivate,
  openEdit,
  openRegister,
  openRetire,
  row,
  settle,
  stepUp,
  stepUpOpen,
  textbox,
  verify,
} from './helpers.ts';

type Kind = 'register' | 'edit' | 'activate' | 'retire';

/** Opens the dialog of `kind` and fills what it needs. */
async function prepare(kind: Kind): Promise<HTMLElement> {
  if (kind === 'register') {
    const form = await openRegister();
    await choose(form, LABEL.platform, /淘宝|taobao/i);
    await choose(form, LABEL.account, new RegExp(TAOBAO_NAME));
    await fill(textbox(form, LABEL.site), SITE);
    await fill(textbox(form, LABEL.pid), '2005');
    await choose(form, LABEL.scene, /share/);
    return form;
  }
  if (kind === 'edit') {
    const form = await openEdit(PID.pendingJd);
    await fill(textbox(form, LABEL.pid), '4003');
    return form;
  }
  if (kind === 'activate') {
    const form = await openActivate(PID.pendingJd);
    await fillTime(textbox(form, LABEL.confirmedAt), '2026-10-22 09:30:00');
    await chooseFile(form, screenshot('hjy.png', 'image/png', 2048));
    return form;
  }
  return openRetire(PID.active);
}

it.each([
  { kind: 'register', method: 'POST', path: PIDS },
  { kind: 'edit', method: 'PATCH', path: pidUrl(PENDING_JD_ID) },
  { kind: 'activate', method: 'POST', path: activateUrl(PENDING_JD_ID) },
  { kind: 'retire', method: 'POST', path: retireUrl(ACTIVE_ID) },
] as const)(
  '[AC-F1-10gb-STEPUP#1] $kind 遇 10003（totp）不自动重发；再次输入动态码后用新的验证结果重发',
  async ({ kind, method, path }) => {
    const server = createServer();
    server.once(method, path, () => failure(10003, { tier: 'totp' }));
    await mount(server);
    const form = await prepare(kind);
    await verify(await stepUp(form));
    await waitFor(() => expect(server.requests(method, path)).toHaveLength(1));
    await settle();
    // The shared gate may reopen at once, or the dialog offers an explicit re-verification.
    if (!stepUpOpen()) {
      expect(document.body.textContent).toMatch(/动态码|二次验证|重新验证/);
      const current = screen.getAllByRole('dialog').at(-1)!;
      await click(action(current, /^(?:重新验证|验证并|确认|提交|保存)/));
    }
    const second = await dialog(STEP_UP_TITLE);
    expect(server.requests(method, path)).toHaveLength(1);
    await verify(second);
    await waitFor(() => expect(server.requests(method, path)).toHaveLength(2));
    const [first, again] = server.requests(method, path);
    assertWrite(first!, 'test-totp-1');
    assertWrite(again!, 'test-totp-2');
    assertVerified(server, 2);
    if (kind === 'activate') {
      expect(again!.form?.get('hjy_ignore_evidence')).toBeInstanceOf(Blob);
      expect(again!.form?.get('expected_row_version')).toBe('0');
    } else {
      expect(again!.body).toEqual(first!.body);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-STEPUP#2] 连续两次写各自验证动态码：停用旧的再启用新的，第二次不复用第一次的验证结果',
  async () => {
    const { server } = await mount();
    const retire = await openRetire(PID.active);
    await verify(await stepUp(retire));
    await waitFor(() => expect(server.requests('POST', retireUrl(ACTIVE_ID))).toHaveLength(1));
    await waitFor(() => expect(actions(row(PID.active), /^停用/)).toEqual([]));
    const form = await openActivate(PID.pendingTaobao);
    await fillTime(textbox(form, LABEL.confirmedAt), '2026-10-22 09:30:00');
    await chooseFile(form, screenshot('hjy.png', 'image/png', 2048));
    const modal = await stepUp(form);
    expect(server.requests('POST', activateUrl(PENDING_TAOBAO_ID))).toEqual([]);
    assertVerified(server, 1);
    await verify(modal);
    await waitFor(() =>
      expect(server.requests('POST', activateUrl(PENDING_TAOBAO_ID))).toHaveLength(1),
    );
    assertWrite(server.requests('POST', retireUrl(ACTIVE_ID))[0]!, 'test-totp-1');
    assertWrite(server.requests('POST', activateUrl(PENDING_TAOBAO_ID))[0]!, 'test-totp-2');
    assertVerified(server, 2);
    await waitFor(() => expect(actions(row(PID.pendingTaobao), /^停用/)).toHaveLength(1));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-STEPUP#3] 取消动态码不写入',
  async () => {
    const { server } = await mount();
    const form = await openRetire(PID.active);
    const modal = await stepUp(form);
    await click(within(modal).getByRole('button', { name: '取消' }));
    await settle();
    await waitFor(() => expect(stepUpOpen()).toBe(false));
    expect(server.requests('POST', retireUrl(ACTIVE_ID))).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(actions(row(PID.active), /^停用/)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
