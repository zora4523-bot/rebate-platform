// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LAGGING,
  PRIMARY,
  READY,
  TARGET,
  VERIFY,
  createServer,
  failure,
  item,
  payload,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertNoStepUp,
  button,
  change,
  click,
  edit,
  field,
  mount,
  save,
  saved,
  settled,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ['2.9.0', '2.10.0'],
  ['2.10.0', '10.0.0'],
  ['2.9.0', '2.9.1'],
  [null, '0.0.0'],
])(
  '[AC-F1-10h-STEP#1] 最低版本 %s → %s 按数字版本比较，先动态码再 PUT',
  async (before, next) => {
    const original = item({ min_supported_version: before });
    const server = createServer([original]);
    await mount(server);
    await edit();
    await change('min_supported_version', next!);
    await save();
    await screen.findByRole('dialog', { name: /二次验证.*动态码/ });
    expect(server.requests('PUT')).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
    await verify();
    await saved(server);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)[0]!.body).toEqual({ tier: 'totp', code: '123456' });
    const request = server.requests('PUT', TARGET)[0]!;
    expect(request.body).toEqual(payload(original, { min_supported_version: next }));
    expect(request.headers.get('X-Step-Up-Token')).toBe('example-step-up');
    expect(request.headers.has('Idempotency-Key')).toBe(false);
    expect(server.log.indexOf(server.requests('POST', VERIFY)[0]!)).toBeLessThan(
      server.log.indexOf(request),
    );
  },
  FLOW_TIMEOUT,
);

it.each([
  ['2.10.0', '2.9.0'],
  ['10.0.0', '2.10.0'],
  ['2.9.0', '2.9.0'],
  ['2.9.0', ''],
  [null, ''],
])(
  '[AC-F1-10h-STEP#2] 最低版本 %s → %s 降低、不变、清空均无需动态码',
  async (before, next) => {
    const original = item({ min_supported_version: before });
    const server = createServer([original]);
    await mount(server);
    await edit();
    await change('min_supported_version', next!);
    // A changed title ensures this is a save even when the minimum stays unchanged.
    await change('update_title', '仅更新文案也应直接保存');
    await save();
    await saved(server);
    expect(server.requests('PUT', TARGET)[0]!.body).toEqual(
      payload(original, {
        min_supported_version: next || null,
        update_title: '仅更新文案也应直接保存',
      }),
    );
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-STEP#3] 取消提高最低版本的动态码验证，完全不发送写请求',
  async () => {
    const { server } = await mount();
    await edit();
    await change('min_supported_version', '2.10.0');
    await save();
    const modal = await screen.findByRole('dialog', { name: /二次验证.*动态码/ });
    await click(button(modal, /取消/));
    await settled(server);
    expect(server.requests('PUT')).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
    expect(field('min_supported_version').value).toBe('2.10.0');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-STEP#4] 服务端 10003+tier=totp 才补动态码，原请求体不变并只重发一次',
  async () => {
    const server = createServer();
    server.once('PUT', TARGET, () => failure(10003, { tier: 'totp' }, '需要二次验证'));
    await mount(server);
    await edit();
    await change('update_title', '服务端要求验证');
    await save();
    await screen.findByRole('dialog', { name: /二次验证.*动态码/ });
    expect(server.requests('PUT', TARGET)).toHaveLength(1);
    expect(server.requests('PUT', TARGET)[0]!.headers.has('X-Step-Up-Token')).toBe(false);
    await verify();
    await saved(server, 2);
    expect(server.requests('PUT', TARGET)[1]!.body).toEqual(
      server.requests('PUT', TARGET)[0]!.body,
    );
    expect(server.requests('PUT', TARGET)[1]!.headers.get('X-Step-Up-Token')).toBe(
      'example-step-up',
    );
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(server.requests('PUT').every((r) => !r.headers.has('Idempotency-Key'))).toBe(true);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-STEP#5] 动态码后仍返回 10003，不无限弹验证或自动循环重发',
  async () => {
    const server = createServer();
    for (let i = 0; i < 2; i++)
      server.once('PUT', TARGET, () => failure(10003, { tier: 'totp' }, '验证未通过，请重试'));
    await mount(server);
    await edit();
    await change('update_title', '保留此文案');
    await save();
    await verify();
    await saved(server, 2);
    await waitFor(() => expect(document.body.textContent).toMatch(/未通过|失败|重试/));
    expect(server.requests('PUT', TARGET)).toHaveLength(2);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(field('update_title').value).toBe('保留此文案');
  },
  FLOW_TIMEOUT,
);

async function storeConfirmation(): Promise<HTMLElement> {
  let result: HTMLElement | undefined;
  await waitFor(() => {
    const dialogs = [...screen.queryAllByRole('dialog'), ...screen.queryAllByRole('alertdialog')];
    result = dialogs.find(
      (dialog) =>
        LAGGING.every((store) => dialog.textContent?.includes(store)) &&
        !dialog.contains(field('latest_version')),
    );
    expect(result, 'one batch confirmation containing every lagging store').toBeDefined();
  });
  return result!;
}

it(
  '[AC-F1-10h-STORES#1] 服务端 confirmed_stores 提示后一次列出全部落后商店，整组确认重发',
  async () => {
    const server = createServer();
    server.once('PUT', TARGET, () => failure(20001, { fields: ['confirmed_stores'] }));
    await mount(server);
    await edit();
    await change('min_supported_version', '2.10.0');
    await save();
    await verify();
    const modal = await storeConfirmation();
    expect(server.requests('PUT', TARGET)).toHaveLength(1);
    expect(server.requests('PUT', TARGET)[0]!.body).toEqual(
      payload(item(), { min_supported_version: '2.10.0' }),
    );
    expect(modal.textContent).toContain('2.9.0');
    expect(modal.textContent).toContain('2.8.9');
    expect(modal.textContent).not.toContain(PRIMARY);
    expect(modal.textContent).not.toContain(READY);
    expect(within(modal).queryAllByRole('checkbox')).toEqual([]);
    await click(button(modal, /确认|继续保存/));
    await saved(server, 2);
    expect(server.requests('PUT', TARGET)[1]!.body).toEqual(
      payload(item(), {
        min_supported_version: '2.10.0',
        confirmed_stores: LAGGING,
      }),
    );
    expect(server.requests('PUT', TARGET)[1]!.headers.get('X-Step-Up-Token')).toBe(
      'example-step-up',
    );
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(server.requests('PUT').every((r) => !r.headers.has('Idempotency-Key'))).toBe(true);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-STORES#2] 取消整组确认不重发，保留填写值；随后修改最低版本重新计算落后商店',
  async () => {
    const server = createServer();
    server.once('PUT', TARGET, () => failure(20001, { fields: ['confirmed_stores'] }));
    await mount(server);
    await edit();
    await change('min_supported_version', '2.10.0');
    await save();
    await verify();
    const modal = await storeConfirmation();
    await click(button(modal, /取消/));
    await settled(server);
    expect(server.requests('PUT', TARGET)).toHaveLength(1);
    expect(field('min_supported_version').value).toBe('2.10.0');
    await change('min_supported_version', '2.8.0');
    await save();
    await saved(server, 2);
    expect(server.requests('PUT', TARGET)[1]!.body).toEqual(
      payload(item(), { min_supported_version: '2.8.0', confirmed_stores: [] }),
    );
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-STORES#3] 单纯改文案不抢先要求商店确认：由服务端决定是否核对',
  async () => {
    const { server } = await mount();
    await edit();
    await change('update_notes', '商店版本未动，只更新说明');
    await save();
    await saved(server);
    expect(server.requests('PUT', TARGET)[0]!.body).toEqual(
      payload(item(), { update_notes: '商店版本未动，只更新说明' }),
    );
    assertNoStepUp(server);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
  },
  FLOW_TIMEOUT,
);
