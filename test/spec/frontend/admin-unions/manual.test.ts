// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CREDENTIAL, NEW_EXPIRY, SECRET, createServer, failure } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertVerified,
  assertWrite,
  button,
  click,
  fieldError,
  fill,
  mount,
  openManual,
  row,
  stepUp,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function credential(form: HTMLElement): HTMLInputElement {
  return within(form).getByLabelText(/^(?:新)?凭据$/) as HTMLInputElement;
}
function noSecret(): void {
  expect(document.body.textContent).not.toContain(SECRET);
  for (const input of document.querySelectorAll<HTMLInputElement>('input'))
    expect(input.value).not.toBe(SECRET);
}

it(
  '[AC-F1-10ga-MANUAL#1] 密码输入，动态码后仅 PUT 凭据；省略到期时间由响应更新行并保留估算标记',
  async () => {
    const { server } = await mount();
    const form = await openManual();
    expect(credential(form).type).toBe('password');
    await fill(credential(form), SECRET);
    const modal = await stepUp(form);
    expect(server.requests('PUT')).toEqual([]);
    expect(document.body.textContent).not.toContain(SECRET);
    await verify(modal);
    await waitFor(() => expect(row('测试手工账号').textContent).toMatch(/2027[-/]0?4[-/]0?4/));
    expect(row('测试手工账号').textContent).toContain('估算');
    expect(server.requests('PUT', CREDENTIAL)).toHaveLength(1);
    expect(server.requests('PUT', CREDENTIAL)[0]!.body).toEqual({ credential: SECRET });
    assertWrite(server.requests('PUT', CREDENTIAL)[0]!);
    assertVerified(server);
    noSecret();
    const reopened = await openManual();
    expect(credential(reopened).value).toBe('');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10ga-MANUAL#2] 选填到期时间和原因入 PUT 体，响应的精确到期不标估算',
  async () => {
    const { server } = await mount();
    const form = await openManual();
    await fill(credential(form), SECRET);
    const expiry = within(form).getByLabelText(/到期时间/) as HTMLInputElement;
    await fill(
      expiry,
      expiry.type === 'datetime-local' ? '2027-04-04T00:30:00' : '2027-04-04 00:30:00',
    );
    await act(async () => {
      fireEvent.keyDown(expiry, { key: 'Enter', code: 'Enter' });
      fireEvent.blur(expiry);
    });
    await fill(within(form).getByLabelText(/原因|操作说明/), '手工更新凭据');
    await verify(await stepUp(form));
    await waitFor(() => expect(server.requests('PUT', CREDENTIAL)).toHaveLength(1));
    const body = server.requests('PUT', CREDENTIAL)[0]!.body as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['credential', 'expires_at', 'reason']);
    expect(body['credential']).toBe(SECRET);
    expect(body['reason']).toBe('手工更新凭据');
    expect(Date.parse(body['expires_at']!)).toBe(Date.parse(NEW_EXPIRY));
    await waitFor(() => expect(row('测试手工账号').textContent).toMatch(/2027[-/]0?4[-/]0?4/));
    expect(row('测试手工账号').textContent).not.toContain('估算');
    noSecret();
  },
  FLOW_TIMEOUT,
);

it.each(['credential', 'expires_at', 'reason'] as const)(
  '[AC-F1-10ga-MANUAL#3] 20001 fields=%s 在对应输入旁显示提示，提交后的凭据清空',
  async (field) => {
    const server = createServer();
    server.once('PUT', CREDENTIAL, () => failure(20001, { fields: [field] }));
    await mount(server);
    const form = await openManual();
    await fill(credential(form), SECRET);
    await verify(await stepUp(form));
    await waitFor(() => expect(server.requests('PUT', CREDENTIAL)).toHaveLength(1));
    const label =
      field === 'credential'
        ? /^(?:新)?凭据$/
        : field === 'expires_at'
          ? /到期时间/
          : /原因|操作说明/;
    await waitFor(() =>
      fieldError(within(screen.getByRole('dialog', { name: /录入新凭据/ })).getByLabelText(label)),
    );
    noSecret();
    expect(row('测试手工账号').textContent).not.toMatch(/2027[-/]0?4[-/]0?4/);
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-10ga-MANUAL#4] 取消录入清空敏感输入且不写入', async () => {
  const { server } = await mount();
  const form = await openManual();
  await fill(credential(form), SECRET);
  await click(button(form, '取消'));
  const reopened = await openManual();
  expect(credential(reopened).value).toBe('');
  expect(server.requests('PUT')).toEqual([]);
  expect(server.requests('POST')).toEqual([]);
});
