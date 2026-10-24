// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { CODES, LIST, createServer, items, type ChannelItem } from './fixtures.ts';
import {
  CHANNELS_TAB,
  FLOW_TIMEOUT,
  channelCell,
  channelRow,
  isDisabled,
  isOn,
  mount,
  openChannels,
  panelOf,
  rowsOf,
  squash,
  switchesOf,
  toggle,
} from './helpers.ts';

const ALWAYS_ON = '恒开';

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
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-LIST#2] 三列照接口字段画：可开关的给开关（值取 channels），恒开 / 只发站内信 / 不含站内信按字段显示',
  async () => {
    await mount();
    await openChannels('WD_FAILED');
    // WD_FAILED: push + inbox + SMS on, both switchable.
    expect(isOn('push', 'WD_FAILED')).toBe(true);
    expect(isOn('sms', 'WD_FAILED')).toBe(true);
    expect(squash(channelCell('WD_FAILED', 'inbox').textContent)).toContain(ALWAYS_ON);
    // WD_SUCCESS: push on, SMS off.
    expect(isOn('push', 'WD_SUCCESS')).toBe(true);
    expect(isOn('sms', 'WD_SUCCESS')).toBe(false);
    // CLAIM_RESULT: inbox only by default; push and SMS may be opened.
    expect(isOn('push', 'CLAIM_RESULT')).toBe(false);
    expect(isOn('sms', 'CLAIM_RESULT')).toBe(false);
    expect(squash(channelCell('CLAIM_RESULT', 'inbox').textContent)).toContain(ALWAYS_ON);
    // BALANCE_ADJUSTED: inbox only, nothing to switch.
    expect(switchesOf(channelRow('BALANCE_ADJUSTED'))).toEqual([]);
    expect(squash(channelCell('BALANCE_ADJUSTED', 'inbox').textContent)).toContain(ALWAYS_ON);
    // SMS_CODE and UNION_AUTH_EXPIRING: SMS fixed on, no inbox, no switch.
    for (const code of ['SMS_CODE', 'UNION_AUTH_EXPIRING']) {
      expect(switchesOf(channelRow(code)), code).toEqual([]);
      expect(squash(channelCell(code, 'sms').textContent), code).toContain(ALWAYS_ON);
      expect(squash(channelCell(code, 'inbox').textContent), code).not.toContain(ALWAYS_ON);
    }
    for (const [channel, code] of [
      ['push', 'WD_FAILED'],
      ['sms', 'WD_FAILED'],
      ['push', 'WD_SUCCESS'],
      ['sms', 'WD_SUCCESS'],
      ['push', 'CLAIM_RESULT'],
      ['sms', 'CLAIM_RESULT'],
    ] as const)
      expect(isDisabled(toggle(channel, code)), `${channel} ${code}`).toBe(false);
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
    expect(squash(channelCell('SMS_CODE', 'sms').textContent)).not.toContain(ALWAYS_ON);
    expect(switchesOf(channelRow('SMS_CODE'), 'push', 'SMS_CODE')).toEqual([]);
  },
  FLOW_TIMEOUT,
);
