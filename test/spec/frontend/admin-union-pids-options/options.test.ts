// @vitest-environment jsdom
// F1-10gc (CT-24s adminListUnionAccountOptions, D10-243): the 推广位 tab takes its union accounts
// (row account names, the account select of 【登记推广位】 and 【修改】) from GET
// /admin/v1/union/account-options, which union.pid alone may read; it no longer reads GET
// /admin/v1/union-accounts. The 联盟账号 tab still does.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  JD_ACCOUNT,
  JD_NAME,
  OPTIONS,
  PDD_NAME,
  PENDING_TAOBAO_ID,
  PID,
  PIDS,
  SITE,
  TAOBAO_ACCOUNT,
  TAOBAO_NAME,
  createServer,
  pidUrl,
  pids,
} from '../admin-union-pids/fixtures.ts';
import {
  FLOW_TIMEOUT,
  LABEL,
  assertVerified,
  assertWrite,
  choose,
  fill,
  hasRow,
  openEdit,
  openPids,
  openRegister,
  row,
  stepUp,
  textbox,
  verify,
} from '../admin-union-pids/helpers.ts';
import { PERMITTED, PIDS_ONLY, accountsTabShown, mountPage, quietly } from './kit.ts';
import { SPARE_TAOBAO_NAME, accountsWithSpare, type Backend } from './server.ts';

const PID_PLATFORMS: readonly string[] = ['taobao', 'jd', 'pdd'];

/** Every account-options read was a plain GET: no step-up, no filter or one of a PID platform. */
function plainOptionReads(api: Backend): void {
  for (const hit of api.optionReads()) {
    expect(hit.method).toBe('GET');
    expect(hit.headers.has('X-Step-Up-Token')).toBe(false);
    expect(hit.headers.get('Authorization')).toBe('Bearer example-admin-token');
    const keys = Object.keys(hit.query);
    expect(keys.filter((key) => key !== 'platform')).toEqual([]);
    if (hit.query['platform'] !== undefined) expect(PID_PLATFORMS).toContain(hit.query['platform']);
  }
}

it(
  '[AC-F1-10gc-SOURCE#1] 推广位页签读 account-options 显示所属账号名，不为推广位读 union-accounts；联盟账号页签照旧只读 union-accounts',
  async () => {
    const { api } = await mountPage({ snapshot: PERMITTED });
    // The 联盟账号 tab (default) reads GET /admin/v1/union-accounts, never the choices.
    await accountsTabShown(api, TAOBAO_NAME);
    expect(api.sent('GET', '/admin/v1/union-accounts')).toHaveLength(1);
    expect(api.optionReads()).toEqual([]);
    const accountReads = api.accountReads().length;
    await openPids();
    await waitFor(() => expect(api.sent('GET', OPTIONS).length).toBeGreaterThan(0));
    await waitFor(() => expect(row(PID.active).textContent).toContain(TAOBAO_NAME));
    expect(row(PID.pendingTaobao).textContent).toContain(TAOBAO_NAME);
    expect(row(PID.pendingJd).textContent).toContain(JD_NAME);
    // The register dialog lists the accounts from the same source.
    const form = await openRegister();
    await choose(form, LABEL.platform, /淘宝|taobao/i);
    const offered = await choose(form, LABEL.account, new RegExp(TAOBAO_NAME));
    expect(offered.join('|')).toContain(TAOBAO_NAME);
    await quietly(api);
    expect(api.accountReads()).toHaveLength(accountReads);
    plainOptionReads(api);
    expect(api.server.pidRequests().filter((r) => r.method !== 'GET')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gc-SOURCE#2] 只持 union.pid：所属账号显示名称，登记对话框列出该平台账号并完成登记，请求体同 F1-10gb，全程不读 union-accounts',
  async () => {
    const { api, server } = await mountPage({ snapshot: PIDS_ONLY });
    await openPids();
    await waitFor(() => expect(row(PID.active).textContent).toContain(TAOBAO_NAME));
    expect(row(PID.pendingJd).textContent).toContain(JD_NAME);
    const form = await openRegister();
    await choose(form, LABEL.platform, /淘宝|taobao/i);
    const offered = await choose(form, LABEL.account, new RegExp(TAOBAO_NAME));
    expect(offered.join('|')).not.toContain(JD_NAME);
    expect(offered.join('|')).not.toContain(PDD_NAME);
    await fill(textbox(form, LABEL.site), SITE);
    await fill(textbox(form, LABEL.pid), '2005');
    await choose(form, LABEL.scene, /share/);
    await fill(textbox(form, LABEL.reason), '新增分享位');
    const modal = await stepUp(form);
    expect(server.requests('POST', PIDS)).toEqual([]);
    await verify(modal);
    await waitFor(() => expect(server.requests('POST', PIDS)).toHaveLength(1));
    const sent = server.requests('POST', PIDS)[0]!;
    expect(sent.body).toEqual({
      platform: 'taobao',
      union_account_id: TAOBAO_ACCOUNT,
      site_id: SITE,
      pid: '2005',
      pid_scene: 'share',
      reason: '新增分享位',
    });
    assertWrite(sent);
    assertVerified(server);
    await waitFor(() => expect(hasRow('2005')).toBe(true));
    expect(row('2005').textContent).toContain('待确认');
    expect(row('2005').textContent).toContain(TAOBAO_NAME);
    await quietly(api);
    expect(api.accountReads()).toEqual([]);
    expect(api.optionReads().length).toBeGreaterThan(0);
    plainOptionReads(api);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gc-SOURCE#3] 只持 union.pid 修改待确认行：带出原账号名；改到京东时只列京东账号，PATCH 同 F1-10gb',
  async () => {
    const { api, server } = await mountPage({ snapshot: PIDS_ONLY });
    const form = await openEdit(PID.pendingTaobao);
    await waitFor(() => expect(form.textContent).toContain(TAOBAO_NAME));
    expect(textbox(form, LABEL.site).value).toBe(SITE);
    await choose(form, LABEL.platform, /京东|jd/i);
    const offered = await choose(form, LABEL.account, new RegExp(JD_NAME));
    expect(offered.join('|')).not.toContain(TAOBAO_NAME);
    expect(offered.join('|')).not.toContain(PDD_NAME);
    await verify(await stepUp(form));
    await waitFor(() =>
      expect(server.requests('PATCH', pidUrl(PENDING_TAOBAO_ID))).toHaveLength(1),
    );
    expect(server.requests('PATCH', pidUrl(PENDING_TAOBAO_ID))[0]!.body).toEqual({
      platform: 'jd',
      union_account_id: JD_ACCOUNT,
      site_id: null,
      expected_row_version: 3,
    });
    await waitFor(() => expect(row(PID.pendingTaobao).textContent).toContain(JD_NAME));
    await quietly(api);
    expect(api.accountReads()).toEqual([]);
    plainOptionReads(api);
  },
  FLOW_TIMEOUT,
);

it.each([
  {
    platform: /淘宝|taobao/i,
    listed: [TAOBAO_NAME, SPARE_TAOBAO_NAME],
    others: [JD_NAME, PDD_NAME],
  },
  { platform: /京东|jd/i, listed: [JD_NAME], others: [TAOBAO_NAME, SPARE_TAOBAO_NAME, PDD_NAME] },
  {
    platform: /拼多多|pdd/i,
    listed: [PDD_NAME],
    others: [TAOBAO_NAME, SPARE_TAOBAO_NAME, JD_NAME],
  },
])(
  '[AC-F1-10gc-FILTER#1] 只持 union.pid 登记：账号下拉只列所选平台 $platform 的全部账号，不列其他平台的',
  async ({ platform, listed, others }) => {
    const { api } = await mountPage({
      snapshot: PIDS_ONLY,
      server: createServer(pids(), accountsWithSpare()),
    });
    const form = await openRegister();
    await choose(form, LABEL.platform, platform);
    const offered = await choose(form, LABEL.account, new RegExp(listed[0]!));
    const joined = offered.join('|');
    for (const name of listed) expect(joined).toContain(name);
    for (const name of others) expect(joined).not.toContain(name);
    expect(offered).toHaveLength(listed.length);
    await quietly(api);
    expect(api.accountReads()).toEqual([]);
    plainOptionReads(api);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gc-FILTER#2] 登记时换平台：账号下拉随之只列新平台的账号，原平台的账号选择被清掉',
  async () => {
    const { api, server } = await mountPage({
      snapshot: PIDS_ONLY,
      server: createServer(pids(), accountsWithSpare()),
    });
    const form = await openRegister();
    await choose(form, LABEL.platform, /淘宝|taobao/i);
    await choose(form, LABEL.account, new RegExp(SPARE_TAOBAO_NAME));
    await choose(form, LABEL.platform, /京东|jd/i);
    await waitFor(() => expect(form.textContent).not.toContain(SPARE_TAOBAO_NAME));
    const offered = await choose(form, LABEL.account, new RegExp(JD_NAME));
    expect(offered.join('|')).not.toContain(TAOBAO_NAME);
    expect(offered.join('|')).not.toContain(SPARE_TAOBAO_NAME);
    await fill(textbox(form, LABEL.pid), '4005');
    await choose(form, LABEL.scene, /share/);
    await verify(await stepUp(form));
    await waitFor(() => expect(server.requests('POST', PIDS)).toHaveLength(1));
    const { site_id: site, ...rest } = server.requests('POST', PIDS)[0]!.body as Record<
      string,
      unknown
    >;
    expect(rest).toEqual({
      platform: 'jd',
      union_account_id: JD_ACCOUNT,
      pid: '4005',
      pid_scene: 'share',
    });
    expect(site ?? null).toBeNull();
    await quietly(api);
    expect(api.accountReads()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
