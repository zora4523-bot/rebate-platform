// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST, TARGET, VERIFY, createServer, failure, item } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  alert,
  approve,
  button,
  click,
  currentValue,
  dialog,
  mount,
  openDrawers,
  prepareRollback,
  row,
  settled,
  submit,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function currentValueBehindStepUp(key: string, pattern: RegExp): Promise<void> {
  await waitFor(() => {
    const current = row(key);
    const table = current.closest('table');
    expect(table).not.toBeNull();
    // StepUpModal hides the app from the accessibility tree while verification is open.
    const index = within(table!)
      .getAllByRole('columnheader', { hidden: true })
      .findIndex((node) => /当前值/.test(node.textContent ?? ''));
    expect(index, 'column 当前值').toBeGreaterThanOrEqual(0);
    const cell = current.children[index];
    expect(cell).toBeDefined();
    expect(cell!.textContent).toMatch(pattern);
  });
}

// Both write endpoints have the same permission, CAS and unknown-result contract.
for (const operation of ['edit', 'rollback'] as const) {
  const method = operation === 'edit' ? 'PUT' : 'POST';
  const path = `${LIST}/${TARGET}${operation === 'rollback' ? '/rollback' : ''}`;
  const start = async (server: ReturnType<typeof createServer>) => {
    if (operation === 'edit') await submit(server);
    else {
      await approve(await prepareRollback(server));
      await verify(await dialog('二次验证 · 动态码'));
    }
  };

  it(
    `[AC-F1-06zg-ERRORS#1] ${operation} 10003 保留原值，重新 totp 后才用新 token 写入`,
    async () => {
      const server = createServer([item()]);
      server.once(method, path, () => failure(10003, { tier: 'totp' }, '请完成二次验证'));
      await mount(server);
      await start(server);
      await waitFor(() => expect(server.requests(method, path)).toHaveLength(1));
      const modal = await dialog('二次验证 · 动态码');
      await currentValueBehindStepUp(TARGET, /3/);
      await settled(server);
      expect(server.requests(method, path)).toHaveLength(1);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
      await verify(modal);
      await waitFor(() => expect(server.requests(method, path)).toHaveLength(2));
      expect(
        server.requests(method, path).map((entry) => entry.headers.get('X-Step-Up-Token')),
      ).toEqual(['test-totp-1', 'test-totp-2']);
      expect(server.requests(method, path)[1]!.body).toEqual(
        server.requests(method, path)[0]!.body,
      );
      await currentValue(TARGET, operation === 'edit' ? /7/ : /2/);
    },
    FLOW_TIMEOUT,
  );

  it.each([
    {
      label: '10403',
      code: 10403,
      data: { reason: 'admin_permission_denied' },
      pattern: /无权限|没有.*权限|权限不足/,
    },
    {
      label: '20001 key',
      code: 20001,
      data: { fields: ['key'] },
      pattern: /配置.*(?:未登记|无效|不可|只读|不允许)|key/,
    },
    {
      label: `20001 ${operation === 'edit' ? 'value' : 'to_version'}`,
      code: 20001,
      data: { fields: [operation === 'edit' ? 'value' : 'to_version'] },
      pattern:
        operation === 'edit'
          ? /值.*(?:无效|错误|不合法|不允许)|value/
          : /回滚.*(?:无效|失败|不允许)|版本.*(?:无效|错误|不合法|不允许)|to_version/,
    },
  ])(
    `[AC-F1-06zg-ERRORS#2] ${operation} $label 显示对应错误、值不变且不自动重发`,
    async ({ code, data, pattern }) => {
      const server = createServer([item()]);
      server.once(method, path, () => failure(code, data, '操作失败'));
      await mount(server);
      await start(server);
      // Antd Form validation or a drawer/page Alert are both valid error locations.
      await waitFor(() =>
        expect(
          [...screen.queryAllByRole('alert'), ...openDrawers()].some((node) =>
            pattern.test(node.textContent ?? ''),
          ),
        ).toBe(true),
      );
      await settled(server);
      await currentValue(TARGET, /3/);
      expect(server.requests(method, path)).toHaveLength(1);
    },
    FLOW_TIMEOUT,
  );

  it(
    `[AC-F1-06zg-ERRORS#3] ${operation} 20902 提示冲突并重读该项，下一次显式写使用新版本`,
    async () => {
      const server = createServer([item()]);
      server.once(method, path, () => {
        server.state[0]!.value = 19;
        server.state[0]!.version = 12;
        return failure(20902, { resource: 'config_item' }, '状态已变化，请刷新后重试');
      });
      await mount(server);
      await start(server);
      await alert(/冲突|状态.*变化|已被.*修改/);
      await waitFor(() => {
        const writeIndex = server.log.findIndex(
          (request) => request.method === method && request.path === path,
        );
        expect(writeIndex).toBeGreaterThanOrEqual(0);
        expect(
          server.log
            .slice(writeIndex + 1)
            .some((request) => request.method === 'GET' && request.path === `${LIST}/${TARGET}`),
        ).toBe(true);
      });
      await currentValue(TARGET, /19/);
      await settled(server);
      expect(server.requests(method, path)).toHaveLength(1);
      for (const edit of openDrawers()) await click(button(edit, '取消'));
      // A fresh PUT after either failed operation must use the refreshed version.
      const writesBefore = server.requests('PUT').length;
      await submit(server, TARGET, '8');
      await waitFor(() => expect(server.requests('PUT')).toHaveLength(writesBefore + 1));
      expect(server.requests('PUT').at(-1)!.body).toMatchObject({ value: 8, expected_version: 12 });
    },
    FLOW_TIMEOUT,
  );

  it.each(['network-applied', 'network-not-applied', 'parse-applied'] as const)(
    `[AC-F1-06zg-ERRORS#4] ${operation} %s 提示结果未知，重读核实且绝不自动重发`,
    async (mode) => {
      const server = createServer([item()]);
      server.once(method, path, () => {
        if (mode !== 'network-not-applied') {
          server.state[0]!.value = 21;
          server.state[0]!.version = 4;
        }
        if (mode === 'parse-applied')
          return new Response('{not-json', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        return Promise.reject(new Error('response lost'));
      });
      await mount(server);
      await start(server);
      await alert(/结果.*(?:未知|不明|未确认)|未能确认|无法确认/);
      await waitFor(() => {
        const writeIndex = server.log.findIndex(
          (request) => request.method === method && request.path === path,
        );
        expect(writeIndex).toBeGreaterThanOrEqual(0);
        expect(
          server.log
            .slice(writeIndex + 1)
            .some(
              (request) =>
                request.method === 'GET' &&
                (request.path === `${LIST}/${TARGET}` || request.path === LIST),
            ),
        ).toBe(true);
      });
      await currentValue(TARGET, mode === 'network-not-applied' ? /3/ : /21/);
      await settled(server);
      expect(server.requests(method, path)).toHaveLength(1);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
    },
    FLOW_TIMEOUT,
  );
}

it(
  '[AC-F1-06zg-ERRORS#5] 动态码错误不发保存，保留输入和旧值供纠正',
  async () => {
    const server = createServer([item()]);
    server.once('POST', VERIFY, () => failure(20002, null, '验证码错误'));
    await mount(server);
    await submit(server);
    await waitFor(() => expect(screen.queryByText('验证码错误，请重新输入')).not.toBeNull());
    expect(await dialog('二次验证 · 动态码')).toBeDefined();
    expect(server.requests('PUT')).toEqual([]);
    await currentValueBehindStepUp(TARGET, /3/);
  },
  FLOW_TIMEOUT,
);
