// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ARTICLE_ONLY, LIST, NO_FUND, channelPath, createServer, failure } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  FORBIDDEN,
  actions,
  assertWrite,
  click,
  isDisabled,
  main,
  mount,
  openChannels,
  openSms,
  settle,
  settled,
  smsRow,
  stepUpDialog,
  switchesOf,
  toggle,
  verify,
} from './helpers.ts';

const PLANNED = '功能开发中';

it(
  '[AC-F1-06zv-ACCESS#1] 没有 notify.channels：不请求 notify-channels，显示无权限提示，没有开关与编辑入口',
  async () => {
    const { server } = await mount(createServer(), { snapshot: ARTICLE_ONLY });
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    await settled(server);
    expect(server.channelRequests()).toEqual([]);
    expect(switchesOf(main())).toEqual([]);
    expect(actions(main(), /^(?:编辑|登记)/)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ACCESS#2] 列表返回 10403：显示无权限提示，不显示开关',
  async () => {
    const server = createServer();
    server.once('GET', LIST, () => failure(10403, { reason: 'admin_permission_denied' }));
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    expect(switchesOf(main())).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ACCESS#3] planned 清单含 adminListNotifyChannels：整页「功能开发中」，不发请求',
  async () => {
    const { server } = await mount(createServer(), {
      planned: new Set(['adminListNotifyChannels', 'adminSwitchNotifyChannels']),
    });
    await waitFor(() => expect(main().textContent).toContain(PLANNED));
    await settled(server);
    expect(main().textContent).toContain('消息模板');
    expect(server.channelRequests()).toEqual([]);
    expect(switchesOf(main())).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ACCESS#4] planned 清单不含 adminListNotifyChannels：照常请求并列出编码',
  async () => {
    const { server } = await mount(createServer(), { planned: new Set(['adminGetDashboard']) });
    await openChannels('WD_FAILED');
    expect(server.requests('GET', LIST)).toHaveLength(1);
    expect(main().textContent).not.toContain(PLANNED);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ACCESS#5] 没有 content.fund_terms：资金类编码在「短信」页签没有可用的【编辑】【登记】，点了也不发 PUT；非资金类照常可编辑',
  async () => {
    const { server } = await mount(createServer(), { snapshot: NO_FUND });
    await openSms('WD_FAILED');
    const fundRows: [string, string][] = [
      ['WD_FAILED', 'default'],
      ['WD_SUCCESS', 'default'],
      ['WD_REJECTED', 'default'],
      ['WD_REJECTED', 'negative_balance'],
    ];
    for (const [code, variant] of fundRows) {
      const entries = actions(smsRow(code, variant), /^(?:编辑|登记)/);
      for (const entry of entries) {
        expect(isDisabled(entry), `${code} · ${variant} entry disabled`).toBe(true);
        await click(entry);
      }
    }
    await settle();
    expect(server.requests('PUT')).toEqual([]);
    for (const code of ['SMS_CODE', 'UNION_AUTH_EXPIRING']) {
      const entries = actions(smsRow(code), /^编辑/);
      expect(entries, `${code} 【编辑】`).toHaveLength(1);
      expect(isDisabled(entries[0]!)).toBe(false);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ACCESS#6] 没有 content.fund_terms：资金类编码的推送 / 短信开关照常可用（只开关不需要 content.fund_terms）',
  async () => {
    const { server } = await mount(createServer(), { snapshot: NO_FUND });
    await openChannels('WD_FAILED');
    expect(isDisabled(toggle('push', 'WD_FAILED'))).toBe(false);
    expect(isDisabled(toggle('sms', 'WD_FAILED'))).toBe(false);
    await click(toggle('push', 'WD_FAILED'));
    await verify(await stepUpDialog());
    await waitFor(() => expect(server.requests('PATCH', channelPath('WD_FAILED'))).toHaveLength(1));
    assertWrite(server.requests('PATCH', channelPath('WD_FAILED'))[0]!, 'test-totp-1');
    await waitFor(() =>
      expect(toggle('push', 'WD_FAILED').getAttribute('aria-checked')).toBe('false'),
    );
    expect(server.requests('PATCH', channelPath('WD_FAILED'))[0]!.body).toEqual({
      push: false,
      row_version: 1,
    });
  },
  FLOW_TIMEOUT,
);
