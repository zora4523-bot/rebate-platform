// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CODES,
  LIST,
  MENU_ONLY_GRANTS,
  NO_FUND_GRANTS,
  READER_GRANTS,
  channelPath,
  createServer,
  retestPath,
  type Server,
} from './fixtures.ts';
import {
  ACCEPTED,
  CHANNELS_TAB,
  DISCARD,
  EDIT,
  ENABLE,
  FLOW_TIMEOUT,
  FORBIDDEN,
  LATER,
  REGISTER,
  RETEST,
  SAVE,
  SEND,
  SMS_TAB,
  STATUS,
  WRITE_ACTIONS,
  action,
  actions,
  assertWrite,
  click,
  dialogWith,
  editableFields,
  isDisabled,
  main,
  mount,
  openChannels,
  openSms,
  otherDialogs,
  panelOf,
  rowsOf,
  settle,
  settled,
  smsRow,
  squash,
  statusOf,
  stepUpDialog,
  switchesOf,
  toggle,
  usable,
  verify,
} from './helpers.ts';

const PLANNED = '功能开发中';

function patches(server: Server, code: string) {
  return server.requests('PATCH', channelPath(code));
}

it(
  '[AC-F1-06zv-ACCESS#1] 只有读权限（content.article，没有 notify.channels）：列表与状态照常显示，开关与写按钮都不出现',
  async () => {
    const { server } = await mount(createServer(undefined, { permissions: READER_GRANTS }));
    await openChannels('WD_FAILED');
    expect(server.requests('GET', LIST)).toHaveLength(1);
    for (const code of CODES)
      expect(rowsOf(panelOf(CHANNELS_TAB), [code]), `row ${code}`).toHaveLength(1);
    expect(switchesOf(main())).toEqual([]);
    expect(actions(panelOf(CHANNELS_TAB), WRITE_ACTIONS)).toEqual([]);
    await openSms('WD_FAILED');
    expect(statusOf('WD_FAILED')).toContain(STATUS.failed);
    expect(statusOf('WD_SUCCESS')).toContain(STATUS.enabled);
    expect(actions(panelOf(SMS_TAB), WRITE_ACTIONS)).toEqual([]);
    await settled(server);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ACCESS#2] 列表返回 10403（只有 content.fund_terms 看得到菜单）：显示无权限提示，不显示开关',
  async () => {
    const server = createServer(undefined, { permissions: MENU_ONLY_GRANTS });
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    expect(switchesOf(main())).toEqual([]);
    expect(rowsOf(main(), ['WD_FAILED'])).toEqual([]);
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
  '[AC-F1-06zv-ACCESS#5] 没有 content.fund_terms：资金类编码的短信登记不能改（没有可用的【编辑】【登记】，或抽屉只读、没有可用的【保存】），不发 PUT；非资金类照常可登记',
  async () => {
    const server = createServer(undefined, { permissions: NO_FUND_GRANTS });
    await mount(server);
    await openSms('WD_SUCCESS');
    const fundRows: [string, string][] = [
      ['WD_SUCCESS', 'default'],
      ['WD_FAILED', 'default'],
      ['CLAIM_RESULT', 'default'],
      ['WD_REJECTED', 'negative_balance'],
    ];
    for (const [code, variant] of fundRows) {
      for (const entry of usable(smsRow(code, variant), /^(?:编辑|登记)/)) {
        await click(entry);
        await settle();
        for (const drawer of otherDialogs()) {
          expect(usable(drawer, SAVE), `${code} · ${variant} no usable 【保存】`).toEqual([]);
          expect(usable(drawer, ENABLE), `${code} · ${variant} no 【启用新配置】`).toEqual([]);
          expect(editableFields(drawer), `${code} · ${variant} read only`).toEqual([]);
        }
      }
    }
    await settled(server);
    expect(server.requests('PUT')).toEqual([]);
    for (const code of ['SMS_CODE', 'DATA_COPY_CODE']) {
      const entries = actions(smsRow(code), REGISTER);
      expect(entries, `${code} 【登记】`).toHaveLength(1);
      expect(isDisabled(entries[0]!)).toBe(false);
    }
    // Retest and discard of a fund code need no content.fund_terms (CT-24t).
    expect(usable(smsRow('WD_FAILED'), RETEST)).toHaveLength(1);
    expect(usable(smsRow('WD_FAILED'), DISCARD)).toHaveLength(1);
    expect(usable(smsRow('UNION_AUTH_EXPIRING'), EDIT)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ACCESS#6] 没有 content.fund_terms：资金类编码重新测试已受理，结果弹窗不给【启用新配置】',
  async () => {
    const server = createServer(undefined, { permissions: NO_FUND_GRANTS });
    await mount(server);
    await openSms('WD_FAILED');
    await click(action(smsRow('WD_FAILED'), RETEST));
    const modal = await dialogWith(SEND);
    await click(action(modal, SEND));
    await verify(await stepUpDialog());
    const retests = () => server.requests('POST', retestPath('WD_FAILED'));
    await waitFor(() => expect(retests()).toHaveLength(1));
    await settled(server);
    const result = await dialogWith(LATER);
    expect(squash(result.textContent)).toMatch(ACCEPTED);
    expect(usable(result, ENABLE)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ACCESS#7] 没有 content.fund_terms：资金类编码的推送 / 短信开关照常可用（只开关不需要 content.fund_terms）',
  async () => {
    const server = createServer(undefined, { permissions: NO_FUND_GRANTS });
    await mount(server);
    await openChannels('WD_FAILED');
    expect(isDisabled(toggle('push', 'WD_FAILED'))).toBe(false);
    expect(isDisabled(toggle('sms', 'WD_FAILED'))).toBe(false);
    await click(toggle('push', 'WD_FAILED'));
    await verify(await stepUpDialog());
    await waitFor(() => expect(patches(server, 'WD_FAILED')).toHaveLength(1));
    const [request] = patches(server, 'WD_FAILED');
    assertWrite(request!, 'test-totp-1');
    expect(request!.body).toEqual({ push: false, row_version: 5 });
    await waitFor(() =>
      expect(toggle('push', 'WD_FAILED').getAttribute('aria-checked')).toBe('false'),
    );
  },
  FLOW_TIMEOUT,
);
