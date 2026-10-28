// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  CODES,
  LIST,
  createServer,
  items,
  unregistered,
  withItem,
  type ChannelItem,
} from './fixtures.ts';
import {
  CHANNELS_TAB,
  FLOW_TIMEOUT,
  channelCell,
  channelRow,
  click,
  isDisabled,
  isOn,
  mount,
  openChannels,
  otherDialogs,
  panelOf,
  rowsOf,
  settled,
  squash,
  stepUpOpen,
  switchesOf,
  toggle,
} from './helpers.ts';

const ALWAYS_ON = '恒开';
const NOT_READY = '未就绪';

function cellText(code: string, channel: 'push' | 'sms'): string {
  return squash(channelCell(code, channel).textContent);
}

it(
  '[AC-F1-06zv-LIST#1] 「消息模板」页签：一次不分页的列表请求，每个编码一行',
  async () => {
    const { server, directFetch } = await mount();
    await openChannels('WD_FAILED');
    const reads = server.requests('GET', LIST);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.query).toEqual({});
    for (const code of CODES)
      expect(rowsOf(panelOf(CHANNELS_TAB), [code]), `row ${code}`).toHaveLength(1);
    expect(server.writes()).toEqual([]);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-LIST#2] 推送 / 短信照接口字段画：可开关的给开关（值取 channels），sms_fixed 的短信格显示恒开、没有开关，只发站内信与订阅类没有短信开关',
  async () => {
    await mount();
    await openChannels('WD_FAILED');
    // WD_FAILED: push + inbox + SMS on, both switchable.
    expect(isOn('push', 'WD_FAILED')).toBe(true);
    expect(isOn('sms', 'WD_FAILED')).toBe(true);
    expect(isDisabled(toggle('push', 'WD_FAILED'))).toBe(false);
    expect(isDisabled(toggle('sms', 'WD_FAILED'))).toBe(false);
    // WD_SUCCESS: push on, SMS off but ready.
    expect(isOn('push', 'WD_SUCCESS')).toBe(true);
    expect(isOn('sms', 'WD_SUCCESS')).toBe(false);
    expect(isDisabled(toggle('sms', 'WD_SUCCESS'))).toBe(false);
    // CLAIM_RESULT: inbox only by default; push may be opened.
    expect(isOn('push', 'CLAIM_RESULT')).toBe(false);
    expect(isDisabled(toggle('push', 'CLAIM_RESULT'))).toBe(false);
    // BALANCE_ADJUSTED: inbox only, nothing to switch.
    expect(switchesOf(channelRow('BALANCE_ADJUSTED'))).toEqual([]);
    // WATCH_DIGEST (subscription): push switch, never an SMS switch.
    expect(isOn('push', 'WATCH_DIGEST')).toBe(true);
    expect(switchesOf(channelRow('WATCH_DIGEST'), 'sms', 'WATCH_DIGEST')).toEqual([]);
    // SMS_CODE, UNION_AUTH_EXPIRING, DATA_COPY_CODE: SMS fixed on (a locked cell, no switch).
    for (const code of ['SMS_CODE', 'UNION_AUTH_EXPIRING', 'DATA_COPY_CODE']) {
      expect(switchesOf(channelRow(code)), code).toEqual([]);
      expect(cellText(code, 'sms'), code).toContain(ALWAYS_ON);
    }
    expect(cellText('WD_FAILED', 'sms')).not.toContain(ALWAYS_ON);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-LIST#3] 前端不写死编码名单：同一编码的可改性随接口字段变化',
  async () => {
    const patched: Record<string, Partial<ChannelItem>> = {
      WD_SUCCESS: { push_switchable: false, sms_switchable: false, sms_billing_confirm: false },
      BALANCE_ADJUSTED: { push_switchable: true },
      SMS_CODE: { sms_fixed: false, sms_switchable: true },
    };
    const data = items().map((item) => ({ ...item, ...(patched[item.code] ?? {}) }));
    await mount(createServer(data));
    await openChannels('WD_SUCCESS');
    expect(switchesOf(channelRow('WD_SUCCESS'))).toEqual([]);
    expect(isOn('push', 'BALANCE_ADJUSTED')).toBe(false);
    expect(switchesOf(channelRow('BALANCE_ADJUSTED'), 'sms', 'BALANCE_ADJUSTED')).toEqual([]);
    expect(isOn('sms', 'SMS_CODE')).toBe(true);
    expect(cellText('SMS_CODE', 'sms')).not.toContain(ALWAYS_ON);
    expect(switchesOf(channelRow('SMS_CODE'), 'push', 'SMS_CODE')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-LIST#4] 短信未就绪（sms_ready=false）且关着：短信开关置灰，点了不弹确认、不要动态码、不写',
  async () => {
    const { server } = await mount();
    await openChannels('WD_REJECTED');
    for (const code of ['WD_REJECTED', 'CLAIM_RESULT']) {
      const sms = toggle('sms', code);
      expect(sms.getAttribute('aria-checked'), code).toBe('false');
      expect(isDisabled(sms), `${code} SMS switch greyed out`).toBe(true);
      // Push of the same code is not affected.
      expect(isDisabled(toggle('push', code)), `${code} push`).toBe(false);
      await click(sms);
    }
    await settled(server);
    expect(otherDialogs()).toEqual([]);
    expect(stepUpOpen()).toBe(false);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-LIST#5] 就绪置灰只看 sms_ready：同一编码 sms_ready 为真时短信开关可用',
  async () => {
    await mount(createServer(withItem('WD_REJECTED', { sms_ready: true })));
    await openChannels('WD_REJECTED');
    expect(isOn('sms', 'WD_REJECTED')).toBe(false);
    expect(isDisabled(toggle('sms', 'WD_REJECTED'))).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-LIST#6] 默认含短信、开着但未就绪（sms_state=enabled_not_ready）：短信格显示「开（未就绪）」，推送格不显示',
  async () => {
    const data = withItem('WD_FAILED', {
      sms_ready: false,
      sms_state: 'enabled_not_ready',
      sms_registrations: [unregistered(['amount'])],
    });
    await mount(createServer(data));
    await openChannels('WD_FAILED');
    expect(cellText('WD_FAILED', 'sms')).toContain(NOT_READY);
    expect(cellText('WD_FAILED', 'push')).not.toContain(NOT_READY);
    // Codes whose SMS is on and ready, or off, show no 未就绪.
    expect(cellText('UNION_AUTH_EXPIRING', 'sms')).not.toContain(NOT_READY);
    expect(cellText('WD_SUCCESS', 'sms')).not.toContain(NOT_READY);
  },
  FLOW_TIMEOUT,
);
