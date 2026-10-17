// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { formatYuanAdmin } from '../../../../packages/money/src/index.ts';
import { LIST, REASON, TARGET, VERIFY, createServer, item, ok } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  approve,
  button,
  click,
  column,
  confirmation,
  currentValue,
  dialog,
  expectText,
  input,
  mount,
  numberValue,
  openDrawers,
  openEditor,
  prepare,
  reason,
  settled,
  submit,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(['config.general', 'config.risk', 'config.business'] as const)(
  '[AC-F1-06zg-EDIT#1] %s 保存前确认，按该行权限决定 totp，请求含新值、原因与 CAS',
  async (permission) => {
    const server = createServer([item(TARGET, { permission })]);
    const { directFetch } = await mount(server);
    const confirm = await prepare(server);
    expectText(confirm, TARGET, '3', '7');
    expect(server.requests('PUT')).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    await approve(confirm);
    if (permission !== 'config.general') {
      const modal = await dialog('二次验证 · 动态码');
      expect(server.requests('PUT')).toEqual([]);
      await verify(modal);
    }
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
    await currentValue(TARGET, /^\s*7(?:\s|次|$)/);
    await settled(server);
    const request = server.requests('PUT')[0]!;
    expect(request.path).toBe(`${LIST}/${TARGET}`);
    expect(request.body).toEqual({ value: 7, expected_version: 3, reason: REASON });
    expect(request.query).toEqual({});
    expect(request.headers.has('Idempotency-Key')).toBe(false);
    expect(request.headers.get('X-Step-Up-Token')).toBe(
      permission === 'config.general' ? null : 'test-totp-1',
    );
    expect(server.requests('POST', VERIFY).map((entry) => entry.body)).toEqual(
      permission === 'config.general' ? [] : [{ tier: 'totp', code: '123456' }],
    );
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zg-EDIT#2] 数字为空或非法、原因空白时不能进入确认/验证/写入',
  async () => {
    const { server } = await mount(createServer([item()]));
    const edit = await openEditor(server);
    for (const value of ['', 'not-a-number']) {
      await numberValue(edit, value);
      await reason(edit);
      await click(button(edit, /保存/));
      await settled(server);
      expect(screen.queryAllByRole('dialog')).toHaveLength(1);
      expect(edit.textContent).toMatch(/请输入|必填|有效|数字|数值|不能为空/);
      expect(server.requests('PUT')).toEqual([]);
      expect(server.requests('POST')).toEqual([]);
    }
    await numberValue(edit);
    await reason(edit, '   ');
    await click(button(edit, /保存/));
    await settled(server);
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);
    expect(edit.textContent).toMatch(/原因.*(?:必填|不能为空)|请输入.*原因/);
    expect(server.requests('PUT')).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zg-EDIT#3] 枚举仅展示响应 options，非候选值不能自由提交，选中值按字符串保存',
  async () => {
    const server = createServer([
      item(TARGET, {
        permission: 'config.general',
        value_type: 'enum',
        value: 'fixture_a',
        options: ['fixture_a', 'fixture_b'],
      }),
    ]);
    await mount(server);
    const edit = await openEditor(server);
    const select = within(edit).getByRole('combobox', { name: /新值/ });
    await act(async () => {
      fireEvent.mouseDown(select);
    });
    await waitFor(() =>
      expect(
        document.querySelectorAll('.ant-select-dropdown .ant-select-item-option-content'),
      ).toHaveLength(2),
    );
    const options = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ant-select-dropdown .ant-select-item-option-content',
      ),
    );
    expect(options.map((node) => node.textContent?.trim())).toEqual(['fixture_a', 'fixture_b']);
    // Entering a search term must not add a tags-mode option or a custom value.
    await input(select, 'unregistered_choice');
    await act(async () => {
      fireEvent.keyDown(select, { key: 'Enter', code: 'Enter' });
    });
    expect(within(edit).queryAllByText('unregistered_choice')).toEqual([]);
    await input(select, '');
    // Keyboard opening is idempotent (mouseDown could close an already open dropdown).
    await act(async () => {
      fireEvent.keyDown(select, { key: 'ArrowDown', code: 'ArrowDown' });
    });
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option-content')).some(
          (node) => node.textContent === 'fixture_b',
        ),
      ).toBe(true),
    );
    await click(
      Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option-content')).find(
        (node) => node.textContent === 'fixture_b',
      )!,
    );
    await reason(edit);
    await click(button(edit, /保存/));
    await approve(await confirmation());
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
    expect(server.requests('PUT')[0]!.body).toEqual({
      value: 'fixture_b',
      expected_version: 3,
      reason: REASON,
    });
    expect(server.requests('POST', VERIFY)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zg-EDIT#4] 布尔用 Switch，false 按 JSON boolean 保存而非字符串',
  async () => {
    const server = createServer([
      item(TARGET, { permission: 'config.general', value_type: 'boolean', value: true }),
    ]);
    await mount(server);
    const edit = await openEditor(server);
    const toggle = within(edit).getByRole('switch', { name: /新值/ });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await reason(edit);
    await click(button(edit, /保存/));
    await approve(await confirmation());
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
    expect(server.requests('PUT')[0]!.body).toEqual({
      value: false,
      expected_version: 3,
      reason: REASON,
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zg-EDIT#5] 字符串不转换为数字，文本内容保持原样',
  async () => {
    const server = createServer([
      item(TARGET, { permission: 'config.general', value_type: 'string', value: '旧文案' }),
    ]);
    await mount(server);
    const edit = await openEditor(server);
    await input(within(edit).getByRole('textbox', { name: /新值/ }), '00123');
    await reason(edit);
    await click(button(edit, /保存/));
    await approve(await confirmation());
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
    expect(server.requests('PUT')[0]!.body).toEqual({
      value: '00123',
      expected_version: 3,
      reason: REASON,
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zg-EDIT#6] 首次写入使用 expected_version=0，不把 null 当已有版本',
  async () => {
    const server = createServer([
      item(TARGET, {
        value: null,
        version: 0,
        updated_by: null,
        updated_at: null,
        permission: 'config.general',
      }),
    ]);
    await mount(server);
    await submit(server, TARGET, '7', false);
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
    expect(server.requests('PUT')[0]!.body).toMatchObject({ value: 7, expected_version: 0 });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zg-EDIT#7] 成功按服务器返回值和版本更新，再次保存使用最新 CAS',
  async () => {
    const server = createServer([item(TARGET, { permission: 'config.general' })]);
    server.once('PUT', `${LIST}/${TARGET}`, () => {
      const entry = server.state[0]!;
      entry.value = 17;
      entry.version = 11;
      return ok(entry);
    });
    await mount(server);
    await submit(server, TARGET, '7', false);
    await currentValue(TARGET, /17/);
    await settled(server);
    for (const edit of openDrawers()) await click(button(edit, '取消'));
    await submit(server, TARGET, '8', false);
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(2));
    expect(server.requests('PUT')[1]!.body).toMatchObject({ value: 8, expected_version: 11 });
  },
  FLOW_TIMEOUT,
);

it.each(['drawer', 'confirm', 'totp'] as const)(
  '[AC-F1-06zg-EDIT#8] 取消 %s 阶段不发送写入',
  async (stage) => {
    const { server } = await mount(createServer([item()]));
    let modal: HTMLElement;
    if (stage === 'drawer') modal = await openEditor(server);
    else {
      modal = await prepare(server);
      if (stage === 'totp') {
        await approve(modal);
        modal = await dialog('二次验证 · 动态码');
      }
    }
    await click(button(modal, '取消'));
    await settled(server);
    await currentValue(TARGET, /3/);
    expect(server.requests('PUT')).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zg-EDIT#9] 动态码请求未返回时取消，晚到 token 不得触发写入',
  async () => {
    const { server } = await mount(createServer([item()]));
    const release = server.hold('POST', VERIFY);
    try {
      await approve(await prepare(server));
      const modal = await dialog('二次验证 · 动态码');
      await verify(modal);
      await waitFor(() => expect(server.requests('POST', VERIFY)).toHaveLength(1));
      await click(button(modal, '取消'));
    } finally {
      release();
    }
    await settled(server);
    expect(server.requests('PUT')).toEqual([]);
    await currentValue(TARGET, /3/);
  },
  FLOW_TIMEOUT,
);

it.each(['config.general', 'config.business'] as const)(
  '[AC-F1-06zg-EDIT#10] %s 双击确认和验证只发一次，写入在途保留旧值',
  async (permission) => {
    const server = createServer([item(TARGET, { permission })]);
    const release = server.hold('PUT', `${LIST}/${TARGET}`);
    await mount(server);
    try {
      await approve(await prepare(server), true);
      if (permission !== 'config.general') await verify(await dialog('二次验证 · 动态码'), true);
      await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
      await currentValue(TARGET, /3/);
      expect(server.requests('POST', VERIFY)).toHaveLength(permission === 'config.general' ? 0 : 1);
    } finally {
      release();
    }
    await currentValue(TARGET, /7/);
    await settled(server);
    expect(server.requests('PUT')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zg-EDIT#11] 双击抽屉保存只出现一个确认框，确认前不写入',
  async () => {
    const server = createServer([item(TARGET, { permission: 'config.general' })]);
    await mount(server);
    const edit = await openEditor(server);
    await numberValue(edit);
    await reason(edit);
    const save = button(edit, /保存/);
    await act(async () => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    const confirm = await confirmation();
    expect(server.requests('PUT')).toEqual([]);
    await approve(confirm);
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
    await settled(server);
    expect(server.requests('PUT')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it.each([
  { yuan: '3000', fen: 300000 },
  { yuan: '3000.00', fen: 300000 },
  { yuan: '0.01', fen: 1 },
  { yuan: '0.29', fen: 29 },
  { yuan: '12.34', fen: 1234 },
  { yuan: '3000.50', fen: 300050 },
])(
  '[AC-F1-06zg-EDIT#12] 金额显示带千分位和两位小数，输入 $yuan 元精确提交 $fen 分',
  async ({ yuan, fen }) => {
    const key = 'withdraw.max_amount_fen';
    // This checks the UI's unit conversion, not server-side operating limits.
    const server = createServer([item(key, { value: 500000 })]);
    await mount(server);
    const edit = await openEditor(server, key);
    const displayed = formatYuanAdmin(500000n);
    expectText(column(key, /当前值/), displayed);
    // The same value in a history row must not satisfy the current-value assertion.
    const summary = edit.cloneNode(true) as HTMLElement;
    // Leave plain layout tables (e.g. antd Descriptions) in the current-value summary.
    for (const table of summary.querySelectorAll('.ant-table, [role="table"]')) table.remove();
    expectText(summary, displayed);
    await numberValue(edit, yuan);
    await reason(edit);
    await click(button(edit, /保存/));
    const confirm = await confirmation();
    expect(server.requests('PUT')).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
    await approve(confirm);
    const verification = await dialog('二次验证 · 动态码');
    expect(server.requests('PUT')).toEqual([]);
    await verify(verification);
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
    const request = server.requests('PUT')[0]!;
    expect(request.path).toBe(`${LIST}/${key}`);
    expect(request.body).toEqual({ value: fen, expected_version: 3, reason: REASON });
    expect(Number.isSafeInteger((request.body as { value: unknown }).value)).toBe(true);
    expect(request.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
    await waitFor(() => expectText(column(key, /当前值/), formatYuanAdmin(BigInt(fen))));
    await settled(server);
    expect(server.requests('PUT')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it.each(['12.345', '-1', 'not-a-number'])(
  '[AC-F1-06zg-EDIT#13] 金额非法输入 %s 显示校验错误，不取整、不截断、不进入确认或写入',
  async (yuan) => {
    const key = 'withdraw.max_amount_fen';
    const server = createServer([item(key, { value: 500000 })]);
    await mount(server);
    const edit = await openEditor(server, key);
    await numberValue(edit, yuan);
    await reason(edit);
    await click(button(edit, /保存/));
    await settled(server);
    await waitFor(() =>
      expect(edit.textContent).toMatch(
        /请输入|必填|不能为空|无效|不合法|有效.*(?:金额|数字)|小数|精度|负数|大于|正数|正整数|至少|不得小于|不能小于/,
      ),
    );
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);
    expect(server.requests('PUT')).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
    expectText(column(key, /当前值/), formatYuanAdmin(500000n));
  },
  FLOW_TIMEOUT,
);
