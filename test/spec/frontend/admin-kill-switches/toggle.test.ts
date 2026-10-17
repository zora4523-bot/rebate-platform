// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AUTO, LIST, TARGET, VERIFY, createServer, item, ok } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  changed,
  checked,
  click,
  confirm,
  control,
  dialog,
  expectText,
  loaded,
  mount,
  row,
  settled,
  stepUp,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-06zf-TOGGLE#1] 确认变更前后与操作说明、再 totp，PUT 带 token、版本与说明，成功采用服务端值',
  async () => {
    const { server, directFetch } = await mount();
    const confirmation = await confirm();
    expectText(confirmation, '淘宝转链', TARGET, 'switch.all');
    expect(confirmation.textContent).toMatch(/动态码|totp/);
    expect(confirmation.textContent).toMatch(/10\s*秒/);
    expect(confirmation.textContent).toMatch(/已生成.*链接.*订单.*不受影响/);
    expect(confirmation.textContent).toMatch(/已开放\s*→\s*已暂停/);
    const reason = '淘宝联盟接口超时率升高，临时暂停转链排查';
    await act(async () => {
      fireEvent.change(within(confirmation).getByRole('textbox', { name: /操作说明/ }), {
        target: { value: reason },
      });
    });
    checked(TARGET, true);
    expect(server.requests('PUT')).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    await click(button(confirmation, /验证并|确认/));
    const verification = await dialog('二次验证 · 动态码');
    expectText(verification, '动态码', '身份验证器');
    expect(server.requests('PUT')).toEqual([]);
    await verify(verification);
    await changed(server);
    // The task explicitly excludes a paired convert.off_reason write.
    expect(server.requests('PUT')).toHaveLength(1);
    const request = server.requests('PUT')[0]!;
    expect(request.path).toBe(`${LIST}/${TARGET}`);
    expect(request.body).toMatchObject({ value: false, expected_version: 3, reason });
    expect(
      Object.keys(request.body as object).every((key) =>
        ['value', 'expected_version', 'reason'].includes(key),
      ),
    ).toBe(true);
    expect(request.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
    expect(request.headers.has('Idempotency-Key')).toBe(false);
    expect(request.query).toEqual({});
    expect(server.requests('POST', VERIFY).map((request) => request.body)).toEqual([
      { tier: 'totp', code: '123456' },
    ]);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zf-TOGGLE#12] 操作说明允许 200 字，超过上限时限制输入或提示修正，不能原样发送',
  async () => {
    const { server } = await mount();
    const confirmation = await confirm();
    const input = within(confirmation).getByRole('textbox', { name: /操作说明/ }) as
      HTMLInputElement | HTMLTextAreaElement;
    const reason = '查'.repeat(200);
    const user = userEvent.setup({ delay: null });
    // Real typing respects native maxLength; fireEvent.change alone would bypass it in jsdom.
    await act(async () => {
      await user.clear(input);
      await user.type(input, `${reason}补`);
    });
    if (input.value.length > 200) {
      // A validation error is also valid, provided it prevents proceeding until corrected.
      await click(button(confirmation, /验证并|确认/));
      await waitFor(() => expect(confirmation.textContent).toMatch(/200/));
      await settled(server);
      expect(screen.queryByRole('dialog', { name: '二次验证 · 动态码' })).toBeNull();
      expect(server.requests('POST')).toEqual([]);
      expect(server.requests('PUT')).toEqual([]);
      await act(async () => {
        await user.clear(input);
        await user.type(input, reason);
      });
    }
    expect(input.value).toBe(reason);
    await click(button(confirmation, /验证并|确认/));
    await verify(await dialog('二次验证 · 动态码'));
    await changed(server);
    expect(server.requests('PUT')).toHaveLength(1);
    expect(server.requests('PUT')[0]!.body).toMatchObject({
      value: false,
      expected_version: 3,
      reason,
    });
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-06zf-TOGGLE#2] 取消影响确认不验证、不写入、不提前翻转', async () => {
  const { server } = await mount();
  const modal = await confirm();
  await click(button(modal, '取消'));
  await settled(server);
  checked(TARGET, true);
  expect(server.requests('POST')).toEqual([]);
  expect(server.requests('PUT')).toEqual([]);
});

it(
  '[AC-F1-06zf-TOGGLE#3] 取消动态码弹窗不写入，验证请求晚到也不能执行已取消的动作',
  async () => {
    const server = createServer();
    const release = server.hold('POST', VERIFY);
    await mount(server);
    const modal = await stepUp();
    try {
      await verify(modal);
      await waitFor(() => expect(server.requests('POST', VERIFY)).toHaveLength(1));
      // The shared modal explicitly supports cancelling while the verification is under way.
      await click(button(modal, '取消'));
    } finally {
      release();
    }
    await settled(server);
    checked(TARGET, true);
    expect(server.requests('PUT')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zf-TOGGLE#4] 未提交动态码直接取消，不发验证或切换请求',
  async () => {
    const { server } = await mount();
    const modal = await stepUp();
    await click(button(modal, '取消'));
    await settled(server);
    checked(TARGET, true);
    expect(server.requests('POST')).toEqual([]);
    expect(server.requests('PUT')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zf-TOGGLE#5] 在途保持旧值并禁用开关，双击验证只产生一个 PUT',
  async () => {
    const server = createServer();
    const release = server.hold('PUT', `${LIST}/${TARGET}`);
    await mount(server);
    try {
      const modal = await stepUp();
      await verify(modal, true);
      await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
      checked(TARGET, true);
      expect(control(TARGET).disabled).toBe(true);
      await click(control(TARGET));
      expect(server.requests('PUT')).toHaveLength(1);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
    } finally {
      release();
    }
    await changed(server);
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-06zf-TOGGLE#6] 双击开关只显示一个确认弹窗', async () => {
  const { server } = await mount();
  await loaded();
  const toggle = control(TARGET);
  await act(async () => {
    fireEvent.click(toggle);
    fireEvent.click(toggle);
  });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(server.requests('PUT')).toEqual([]);
  checked(TARGET, true);
});

it(
  '[AC-F1-06zf-TOGGLE#7] 成功不能只做本地取反，下一次修改使用响应或重读得到的新版本',
  async () => {
    const server = createServer();
    // Another writer has already restored the value by the time the server returns its current row.
    server.once('PUT', `${LIST}/${TARGET}`, () => {
      const entry = server.state.find((value) => value.key === TARGET)!;
      entry.value = true;
      entry.version = 9;
      return ok(entry);
    });
    await mount(server);
    await verify(await stepUp());
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
    await settled(server);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '二次验证 · 动态码' })).toBeNull(),
    );
    checked(TARGET, true);
    await verify(await stepUp());
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(2));
    expect(server.requests('PUT')[1]!.body).toMatchObject({ value: false, expected_version: 9 });
  },
  FLOW_TIMEOUT,
);

it.each([
  'agent.enabled',
  'withdraw.enabled',
  'payout.queue_paused',
  'payout.channel_paused.alipay',
  'pay.enabled',
  'settle.auto.enabled',
])(
  '[AC-F1-06zf-TOGGLE#8] %s（含解除队列/通道暂停）均须 totp 后才能写入',
  async (key) => {
    const { server } = await mount();
    const modal = await stepUp(key);
    expect(server.requests('PUT')).toEqual([]);
    await verify(modal);
    await changed(server, key);
    expect(server.requests('PUT')[0]!.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zf-TOGGLE#9] 默认 true 的未写入行切换携带 expected_version=0',
  async () => {
    const { server } = await mount();
    await verify(await stepUp('parse.tpwd.enabled'));
    await changed(server, 'parse.tpwd.enabled');
    expect(server.requests('PUT')[0]!.body).toMatchObject({ value: false, expected_version: 0 });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zf-TOGGLE#10] 枚举只选服务端 options，仍通过确认与 totp 写入字符串值',
  async () => {
    const { server } = await mount();
    await loaded('convert.off_reason.pdd');
    // Editable enum control is an antd Select or Radio.Group, never a boolean Switch.
    const current = row('convert.off_reason.pdd');
    expect(within(current).queryAllByRole('switch')).toEqual([]);
    const select = within(current).queryByRole('combobox');
    if (select !== null) {
      await act(async () => {
        fireEvent.mouseDown(select);
      });
      // rc-select's virtual accessibility nodes are hidden; operate the visible option contents.
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
      expect(options.map((option) => option.textContent?.trim()).join(' ')).toMatch(/not_launched/);
      const target = options.find((option) => option.textContent?.includes('maintenance'));
      expect(target).toBeDefined();
      await click(target!);
    } else {
      const options = within(current).getAllByRole('radio');
      expect(options).toHaveLength(2);
      await click(within(current).getByRole('radio', { name: /maintenance/ }));
    }
    await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(1));
    await click(button(screen.getByRole('dialog'), /验证并|确认/));
    await verify(await dialog('二次验证 · 动态码'));
    await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
    expect(server.requests('PUT')[0]!.body).toMatchObject({
      value: 'maintenance',
      expected_version: 0,
    });
    expect(server.requests('PUT')[0]!.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zf-AUTO-PAYOUT#1] 自动打款 true 只允许关闭，写入 false 后不能再开',
  async () => {
    const server = createServer([item(AUTO, { value: true, default: false })]);
    await mount(server);
    await loaded(AUTO);
    expect(control(AUTO).disabled).toBe(false);
    await verify(await stepUp(AUTO));
    await changed(server, AUTO);
    expect(control(AUTO).disabled).toBe(true);
    expect(row(AUTO).textContent).toMatch(/负责人.*确认|确认.*负责人/);
    await click(control(AUTO));
    await settled(server);
    expect(server.requests('PUT')).toHaveLength(1);
    expect(server.requests('PUT')[0]!.body).toMatchObject({ value: false, expected_version: 3 });
  },
  FLOW_TIMEOUT,
);

it.each([false, null])(
  '[AC-F1-06zf-AUTO-PAYOUT#2] 自动打款当前 %s（默认 off）即使超管也不能开启',
  async (value) => {
    const server = createServer([
      item(AUTO, { value, default: false, version: value === null ? 0 : 3 }),
    ]);
    await mount(server);
    await loaded(AUTO);
    checked(AUTO, false);
    expect(control(AUTO).disabled).toBe(true);
    expect(row(AUTO).textContent).toMatch(/负责人.*确认|确认.*负责人/);
    await click(control(AUTO));
    await settled(server);
    expect(server.requests('PUT')).toEqual([]);
    expect(server.requests('POST')).toEqual([]);
  },
);

it(
  '[AC-F1-06zf-TOGGLE#11] 普通开关从默认 false 开启，不能把自动打款的单向限制套给其他行',
  async () => {
    const { server } = await mount();
    await loaded('credit.enabled.taobao');
    checked('credit.enabled.taobao', false);
    await verify(await stepUp('credit.enabled.taobao'));
    await changed(server, 'credit.enabled.taobao', true);
    expect(server.requests('PUT')[0]!.body).toMatchObject({ value: true, expected_version: 0 });
  },
  FLOW_TIMEOUT,
);
