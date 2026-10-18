// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { articles, BODY_TEXT, fakeBridge, helpServer } from './fixtures.ts';
import { entry, mount } from './helpers.ts';

for (const [index, detail] of [false, true].entries()) {
  it(`[AC-F1-03b-CS#${index + 1}] ${detail ? '详情' : '首页'} 客服入口先检查能力，只调用一次且参数只有固定 entry`, async () => {
    const native = fakeBridge();
    const http = helpServer();
    mount(http.api, {
      bridge: native.bridge,
      url: detail
        ? '/help?article_id=z-faq-47&uid=account-fixture&phone=phone-fixture&device_id=device-fixture'
        : '/help?uid=account-fixture&phone=phone-fixture&device_id=device-fixture',
    });
    await screen.findByText(detail ? BODY_TEXT : articles[0]!.title);
    expect(native.call).not.toHaveBeenCalled();
    await userEvent.setup().click(entry(detail ? '还有问题，联系客服' : '联系客服'));
    await waitFor(() => expect(native.call).toHaveBeenCalledTimes(1));
    expect(native.has).toHaveBeenCalledWith('cs.open');
    expect(native.has.mock.invocationCallOrder[0]!).toBeLessThan(
      native.call.mock.invocationCallOrder[0]!,
    );
    expect(native.call).toHaveBeenCalledWith(native.supportHandle, { entry: 'help' });
  });
}

for (const [index, situation] of [
  { inApp: true, support: false, detail: false },
  { inApp: true, support: false, detail: true },
  { inApp: false, support: true, detail: false },
  { inApp: false, support: true, detail: true },
].entries()) {
  it(`[AC-F1-03b-CS#${index + 3}] ${JSON.stringify(situation)} 无能力或 App 外隐藏客服操作，不调用原生`, async () => {
    // This test suite chooses the explicitly permitted "hidden" variant, not a disabled control.
    const native = fakeBridge(situation);
    const http = helpServer();
    mount(http.api, {
      bridge: native.bridge,
      url: situation.detail ? '/help?article_id=z-faq-47' : '/help',
    });
    await screen.findByText(situation.detail ? BODY_TEXT : articles[0]!.title);
    expect(screen.queryAllByRole('button', { name: /联系客服/ })).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: /联系客服/ })).toHaveLength(0);
    expect(native.call).not.toHaveBeenCalled();
    if (situation.inApp) expect(native.has).toHaveBeenCalledWith('cs.open');
  });
}

it('[AC-F1-03b-CS#7] 原生 opened=false 时不重发，不在 H5 额外提示安装微信', async () => {
  const native = fakeBridge({ opened: false });
  const http = helpServer();
  const view = mount(http.api, { bridge: native.bridge });
  await screen.findByText(articles[0]!.title);
  await userEvent.setup().click(entry('联系客服'));
  await waitFor(() => expect(native.call).toHaveBeenCalledTimes(1));
  expect(native.call).toHaveBeenCalledWith(native.supportHandle, { entry: 'help' });
  expect(view.container.textContent).not.toMatch(/安装微信|未安装微信|复制客服链接/);
  expect(screen.queryByRole('alert')).toBeNull();
});
