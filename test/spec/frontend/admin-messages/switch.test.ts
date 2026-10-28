// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  LIST,
  VERIFY,
  channelPath,
  createServer,
  failure,
  ok,
  unregistered,
  withItem,
  type ChannelItem,
  type Server,
} from './fixtures.ts';
import {
  CONFLICT,
  FAILED,
  FLOW_TIMEOUT,
  action,
  assertVerified,
  assertWrite,
  bodyText,
  cancelStepUp,
  click,
  freshText,
  isDisabled,
  isOn,
  mount,
  openChannels,
  otherDialog,
  otherDialogs,
  settle,
  settled,
  snapshotText,
  squash,
  stepUpDialog,
  stepUpOpen,
  toggle,
  verify,
} from './helpers.ts';

function patches(server: Server, code: string) {
  return server.requests('PATCH', channelPath(code));
}

it(
  '[AC-F1-06zv-SWITCH#1] 关推送：切换 → 动态码 → PATCH 只带推送与 row_version，成功按返回项更新',
  async () => {
    const { server, directFetch } = await mount();
    await openChannels('WD_FAILED');
    await click(toggle('push', 'WD_FAILED'));
    const modal = await stepUpDialog();
    expect(otherDialogs()).toEqual([]);
    expect(server.requests('PATCH')).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    await verify(modal);
    await waitFor(() => expect(patches(server, 'WD_FAILED')).toHaveLength(1));
    const [request] = patches(server, 'WD_FAILED');
    expect(request!.body).toEqual({ push: false, row_version: 5 });
    expect(request!.query).toEqual({});
    assertWrite(request!, 'test-totp-1');
    assertVerified(server, 1);
    await settled(server);
    await waitFor(() => expect(isOn('push', 'WD_FAILED')).toBe(false));
    expect(isOn('sms', 'WD_FAILED')).toBe(true);
    expect(server.writes()).toHaveLength(1);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SWITCH#2] sms_billing_confirm 为真的编码由关到开先二次确认（说明按条计费）；取消则不验证、不请求、开关不变',
  async () => {
    const { server } = await mount();
    await openChannels('WD_SUCCESS');
    await click(toggle('sms', 'WD_SUCCESS'));
    const confirm = await otherDialog();
    expect(stepUpOpen()).toBe(false);
    expect(squash(confirm.textContent)).toContain('短信');
    expect(squash(confirm.textContent)).toMatch(/计费/);
    await click(action(confirm, /^取消/));
    await settle();
    await waitFor(() => expect(otherDialogs()).toEqual([]));
    expect(stepUpOpen()).toBe(false);
    await settled(server);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(server.writes()).toEqual([]);
    expect(isOn('sms', 'WD_SUCCESS')).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SWITCH#3] 【确认打开】后再动态码，PATCH 带 sms=true 与 confirm_sms_billing=true',
  async () => {
    const { server } = await mount();
    await openChannels('WD_SUCCESS');
    await click(toggle('sms', 'WD_SUCCESS'));
    const confirm = await otherDialog();
    expect(server.requests('POST', VERIFY)).toEqual([]);
    await click(action(confirm, /^确认打开/));
    const modal = await stepUpDialog();
    expect(server.requests('PATCH')).toEqual([]);
    await verify(modal);
    await waitFor(() => expect(patches(server, 'WD_SUCCESS')).toHaveLength(1));
    const [request] = patches(server, 'WD_SUCCESS');
    expect(request!.body).toEqual({ sms: true, confirm_sms_billing: true, row_version: 2 });
    assertWrite(request!, 'test-totp-1');
    await settled(server);
    await waitFor(() => expect(isOn('sms', 'WD_SUCCESS')).toBe(true));
    expect(isOn('push', 'WD_SUCCESS')).toBe(true);
  },
  FLOW_TIMEOUT,
);

it.each([
  {
    name: 'WD_FAILED 关短信（默认含短信）',
    data: undefined,
    channel: 'sms',
    code: 'WD_FAILED',
    body: { sms: false, row_version: 5 },
  },
  {
    name: 'WD_FAILED 重新打开短信（sms_billing_confirm 为假）',
    data: withItem('WD_FAILED', { channels: ['push', 'inbox'], sms_state: 'disabled' }),
    channel: 'sms',
    code: 'WD_FAILED',
    body: { sms: true, row_version: 5 },
  },
  {
    name: 'WD_SUCCESS 关已打开的短信（由开到关不确认）',
    data: withItem('WD_SUCCESS', { channels: ['push', 'inbox', 'sms'], sms_state: 'enabled' }),
    channel: 'sms',
    code: 'WD_SUCCESS',
    body: { sms: false, row_version: 2 },
  },
  {
    name: 'CLAIM_RESULT 打开推送',
    data: undefined,
    channel: 'push',
    code: 'CLAIM_RESULT',
    body: { push: true, row_version: 0 },
  },
  {
    name: 'WATCH_DIGEST（订阅类）关推送',
    data: undefined,
    channel: 'push',
    code: 'WATCH_DIGEST',
    body: { push: false, row_version: 1 },
  },
] satisfies {
  name: string;
  data: ChannelItem[] | undefined;
  channel: 'push' | 'sms';
  code: string;
  body: Record<string, unknown>;
}[])(
  '[AC-F1-06zv-SWITCH#4] $name：不弹二次确认，直接动态码，PATCH 只带被切渠道与 row_version',
  async ({ data, channel, code, body }) => {
    const server = createServer(data);
    await mount(server);
    await openChannels(code);
    const before = isOn(channel, code);
    await click(toggle(channel, code));
    const modal = await stepUpDialog();
    expect(otherDialogs()).toEqual([]);
    await verify(modal);
    await waitFor(() => expect(patches(server, code)).toHaveLength(1));
    expect(patches(server, code)[0]!.body).toEqual(body);
    await settled(server);
    await waitFor(() => expect(isOn(channel, code)).toBe(!before));
  },
  FLOW_TIMEOUT,
);

it.each([
  {
    name: '20001 notify_channel_locked',
    reply: () => failure(20001, { fields: ['push'], reason: 'notify_channel_locked' }),
  },
  { name: '50001', reply: () => failure(50001, undefined, '服务暂时不可用') },
])(
  '[AC-F1-06zv-SWITCH#5] 开关被拒（$name）：开关回到原值并提示，不重发',
  async ({ reply }) => {
    const server = createServer();
    server.once('PATCH', channelPath('WD_FAILED'), reply);
    await mount(server);
    await openChannels('WD_FAILED');
    // Only a notice that appears after the switch counts (not standing text of the row).
    const before = snapshotText();
    await click(toggle('push', 'WD_FAILED'));
    await verify(await stepUpDialog());
    await waitFor(() => expect(patches(server, 'WD_FAILED')).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(FAILED));
    expect(isOn('push', 'WD_FAILED')).toBe(true);
    expect(stepUpOpen()).toBe(false);
    expect(server.requests('PATCH')).toHaveLength(1);
    expect(server.item('WD_FAILED').channels).toEqual(['push', 'inbox', 'sms']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SWITCH#6] 20902：提示并重新拉列表，开关显示服务端当前值，下一次用新的 row_version',
  async () => {
    const server = createServer();
    server.once('PATCH', channelPath('WD_FAILED'), () => {
      // Someone else closed push meanwhile.
      const item = server.item('WD_FAILED');
      item.channels = ['inbox', 'sms'];
      item.row_version = 8;
      return failure(20902, undefined, '状态已变化，请刷新后重试');
    });
    await mount(server);
    await openChannels('WD_FAILED');
    await click(toggle('push', 'WD_FAILED'));
    await verify(await stepUpDialog());
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(2));
    await settled(server);
    await waitFor(() => expect(bodyText()).toMatch(CONFLICT));
    await waitFor(() => expect(isOn('push', 'WD_FAILED')).toBe(false));
    await click(toggle('push', 'WD_FAILED'));
    await verify(await stepUpDialog());
    await waitFor(() => expect(patches(server, 'WD_FAILED')).toHaveLength(2));
    const second = patches(server, 'WD_FAILED')[1]!;
    expect(second.body).toEqual({ push: true, row_version: 8 });
    assertWrite(second, 'test-totp-2');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SWITCH#7] 成功按返回项更新整行（不是本地取反），下一次用返回的 row_version',
  async () => {
    const server = createServer();
    server.once('PATCH', channelPath('WD_FAILED'), () => {
      // The server's current item: push closed, and SMS closed by another writer meanwhile.
      const item = server.item('WD_FAILED');
      item.channels = ['inbox'];
      item.sms_state = 'disabled';
      item.row_version = 9;
      return ok(item);
    });
    await mount(server);
    await openChannels('WD_FAILED');
    await click(toggle('push', 'WD_FAILED'));
    await verify(await stepUpDialog());
    await waitFor(() => expect(server.requests('PATCH')).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(isOn('sms', 'WD_FAILED')).toBe(false));
    expect(isOn('push', 'WD_FAILED')).toBe(false);
    await click(toggle('push', 'WD_FAILED'));
    await verify(await stepUpDialog());
    await waitFor(() => expect(server.requests('PATCH')).toHaveLength(2));
    expect(server.requests('PATCH')[1]!.body).toEqual({ push: true, row_version: 9 });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SWITCH#8] 连续两次开关各自验证动态码，不复用同一令牌',
  async () => {
    const { server } = await mount();
    await openChannels('WD_FAILED');
    await click(toggle('push', 'WD_FAILED'));
    await verify(await stepUpDialog());
    await waitFor(() => expect(patches(server, 'WD_FAILED')).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(isOn('push', 'WD_FAILED')).toBe(false));
    await click(toggle('push', 'WD_SUCCESS'));
    const second = await stepUpDialog();
    expect(patches(server, 'WD_SUCCESS')).toEqual([]);
    await verify(second);
    await waitFor(() => expect(patches(server, 'WD_SUCCESS')).toHaveLength(1));
    assertWrite(patches(server, 'WD_FAILED')[0]!, 'test-totp-1');
    assertWrite(patches(server, 'WD_SUCCESS')[0]!, 'test-totp-2');
    assertVerified(server, 2);
    await settled(server);
    await waitFor(() => expect(isOn('push', 'WD_SUCCESS')).toBe(false));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SWITCH#9] 取消动态码：不验证、不写入、开关不变',
  async () => {
    const { server } = await mount();
    await openChannels('WD_FAILED');
    await click(toggle('sms', 'WD_FAILED'));
    await cancelStepUp(await stepUpDialog());
    await waitFor(() => expect(stepUpOpen()).toBe(false));
    await settled(server);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(server.writes()).toEqual([]);
    expect(isOn('sms', 'WD_FAILED')).toBe(true);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SWITCH#10] 「开（未就绪）」照普通开关可关：动态码 → PATCH sms=false',
  async () => {
    const data = withItem('WD_FAILED', {
      sms_ready: false,
      sms_state: 'enabled_not_ready',
      sms_registrations: [unregistered(['amount'])],
    });
    const server = createServer(data);
    await mount(server);
    await openChannels('WD_FAILED');
    expect(isOn('sms', 'WD_FAILED')).toBe(true);
    expect(isDisabled(toggle('sms', 'WD_FAILED'))).toBe(false);
    await click(toggle('sms', 'WD_FAILED'));
    const modal = await stepUpDialog();
    expect(otherDialogs()).toEqual([]);
    await verify(modal);
    await waitFor(() => expect(patches(server, 'WD_FAILED')).toHaveLength(1));
    expect(patches(server, 'WD_FAILED')[0]!.body).toEqual({ sms: false, row_version: 5 });
    await settled(server);
    await waitFor(() => expect(isOn('sms', 'WD_FAILED')).toBe(false));
    // Off and not ready: greyed out now.
    expect(isDisabled(toggle('sms', 'WD_FAILED'))).toBe(true);
  },
  FLOW_TIMEOUT,
);
