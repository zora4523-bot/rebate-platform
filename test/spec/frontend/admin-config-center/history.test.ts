// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST, TARGET, VERIFY, createServer, item } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  approve,
  button,
  click,
  column,
  currentValue,
  dialog,
  enabled,
  expectText,
  mount,
  openEditor,
  prepareRollback,
  settled,
  verify,
  versionRow,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-06zg-HISTORY#1] 抽屉 GET 历史、最新在前，显示值/修改人/时间，仅旧版本能回滚',
  async () => {
    const { server } = await mount(createServer([item()]));
    const edit = await openEditor(server);
    const current = await versionRow(edit, 3);
    const old = await versionRow(edit, 2);
    const seed = await versionRow(edit, 1);
    expect(current.compareDocumentPosition(old) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(old.compareDocumentPosition(seed) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expectText(current, 'ops-yi', '当前');
    expectText(old, 'ops-old', '2');
    expect(old.textContent).toMatch(/2026[-/]10[-/]0?8/);
    expectText(seed, '系统初始化');
    expect(
      within(current)
        .queryAllByRole('button', { name: /回滚/ })
        .every((node) => !enabled(node)),
    ).toBe(true);
    expect(enabled(button(old, /^回滚.*到\s*v2(?!\d)/))).toBe(true);
    expect(enabled(button(seed, /^回滚.*到\s*v1(?!\d)/))).toBe(true);
    expect(server.requests('GET', `${LIST}/${TARGET}/versions`)).toHaveLength(1);
    expect(server.requests('POST')).toEqual([]);
    expect(
      server.requests('GET', `${LIST}/${TARGET}/versions`)[0]!.headers.has('X-Step-Up-Token'),
    ).toBe(false);
  },
  FLOW_TIMEOUT,
);

it.each(['config.general', 'config.risk', 'config.business'] as const)(
  '[AC-F1-06zg-ROLLBACK#1] %s 回滚确认后按权限验证，带 to_version 与 CAS，成为新版本',
  async (permission) => {
    const server = createServer([item(TARGET, { permission })]);
    await mount(server);
    const confirm = await prepareRollback(server);
    expectText(confirm, TARGET, '2');
    expect(server.requests('POST')).toEqual([]);
    await approve(confirm);
    if (permission !== 'config.general') {
      const verification = await dialog('二次验证 · 动态码');
      expect(server.requests('POST', `${LIST}/${TARGET}/rollback`)).toEqual([]);
      await verify(verification);
    }
    await waitFor(() =>
      expect(server.requests('POST', `${LIST}/${TARGET}/rollback`)).toHaveLength(1),
    );
    await currentValue(TARGET, /2/);
    await settled(server);
    const request = server.requests('POST', `${LIST}/${TARGET}/rollback`)[0]!;
    expect(request.body).toMatchObject({
      to_version: 2,
      expected_version: 3,
      reason: expect.stringMatching(/\S/) as unknown,
    });
    expect(request.headers.get('X-Step-Up-Token')).toBe(
      permission === 'config.general' ? null : 'test-totp-1',
    );
    expect(server.requests('PUT')).toEqual([]);
    expect(server.requests('POST', VERIFY)).toHaveLength(permission === 'config.general' ? 0 : 1);
    // Display the newly created current version, not the restored history version number.
    expect(column(TARGET, /版本/).textContent).toMatch(/v?4/);
  },
  FLOW_TIMEOUT,
);

it.each(['confirm', 'totp'] as const)(
  '[AC-F1-06zg-ROLLBACK#2] 回滚取消 %s 阶段不写入',
  async (stage) => {
    const { server } = await mount(createServer([item()]));
    let modal = await prepareRollback(server);
    if (stage === 'totp') {
      await approve(modal);
      modal = await dialog('二次验证 · 动态码');
    }
    await click(button(modal, '取消'));
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(server.requests('PUT')).toEqual([]);
    await currentValue(TARGET, /3/);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zg-HISTORY#2] 未写入配置历史为空，不生成可回滚的 v0',
  async () => {
    const server = createServer([
      item(TARGET, { value: null, version: 0, updated_by: null, updated_at: null }),
    ]);
    await mount(server);
    const edit = await openEditor(server);
    await waitFor(() =>
      expect(server.requests('GET', `${LIST}/${TARGET}/versions`)).toHaveLength(1),
    );
    await settled(server);
    expect(edit.textContent).toMatch(/暂无|无数据|没有.*版本/);
    expect(within(edit).queryAllByRole('button', { name: /回滚/ })).toEqual([]);
  },
  FLOW_TIMEOUT,
);
