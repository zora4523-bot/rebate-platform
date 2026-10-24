// @vitest-environment jsdom
// F1-10gc: when GET /admin/v1/union/account-options fails (an error, 10403, the network) the 推广位
// list still shows (the account column falls back to the account id), the register dialog offers
// no account and says so, nothing pops up as a global error, and the tab does not fall back to
// GET /admin/v1/union-accounts.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  JD_ACCOUNT,
  JD_NAME,
  PDD_NAME,
  PID,
  TAOBAO_ACCOUNT,
  TAOBAO_NAME,
  pids,
} from '../admin-union-pids/fixtures.ts';
import {
  FLOW_TIMEOUT,
  LABEL,
  actions,
  openPids,
  openRegister,
  panel,
  row,
} from '../admin-union-pids/helpers.ts';
import {
  PERMITTED,
  PIDS_ONLY,
  UNAVAILABLE,
  accountHintText,
  accountsTabShown,
  chooseIfOffered,
  mountPage,
  noToast,
  offeredNow,
  quietly,
} from './kit.ts';
import { SPARE_TAOBAO_NAME, type Backend } from './server.ts';

const NAMES = [TAOBAO_NAME, SPARE_TAOBAO_NAME, JD_NAME, PDD_NAME];

/** The list shows every PID with its status entries; the account column shows the account id. */
function listWithIds(): void {
  for (const item of pids()) expect(row(item.pid).textContent).toContain(item.pid);
  expect(row(PID.active).textContent).toContain(TAOBAO_ACCOUNT);
  expect(row(PID.active).textContent).not.toContain(TAOBAO_NAME);
  expect(row(PID.pendingJd).textContent).toContain(JD_ACCOUNT);
  expect(row(PID.pendingJd).textContent).not.toContain(JD_NAME);
  expect(actions(row(PID.pendingJd), /^修改/)).toHaveLength(1);
  expect(actions(row(PID.pendingJd), /^启用/)).toHaveLength(1);
  expect(actions(row(PID.active), /^停用/)).toHaveLength(1);
  expect(actions(panel(), /^(?:登记|新增|添加)/)).toHaveLength(1);
}

/** The register dialog offers no account and gives a hint next to it; no global error. */
async function noChoices(api: Backend): Promise<void> {
  const form = await openRegister();
  await chooseIfOffered(form, LABEL.platform, /淘宝|taobao/i, api);
  const offered = (await offeredNow(form, LABEL.account, api)).join('|');
  for (const name of NAMES) expect(offered).not.toContain(name);
  expect(offered).not.toContain(TAOBAO_ACCOUNT);
  await waitFor(() => expect(accountHintText(form, LABEL.account)).toMatch(UNAVAILABLE));
  noToast();
}

it.each([
  { mode: 'error', name: '读取出错（50000）' },
  { mode: 'forbidden', name: '10403' },
  { mode: 'offline', name: '网络中断' },
] as const)(
  '[AC-F1-10gc-FAIL#1] account-options $name：推广位列表照常、所属账号显示账号编号，登记对话框账号下拉为空并提示，不弹全局错误、不改读 union-accounts',
  async ({ mode }) => {
    const { api } = await mountPage({ snapshot: PERMITTED, optionsMode: mode });
    await accountsTabShown(api, TAOBAO_NAME);
    const accountReads = api.accountReads().length;
    await openPids();
    await waitFor(() => expect(api.optionReads().length).toBeGreaterThan(0));
    await quietly(api);
    listWithIds();
    noToast();
    await noChoices(api);
    await quietly(api);
    expect(api.accountReads()).toHaveLength(accountReads);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gc-FAIL#2] 只持 union.pid 且 account-options 出错：列表照常显示账号编号，登记对话框下拉为空并提示，不请求 union-accounts',
  async () => {
    const { api } = await mountPage({ snapshot: PIDS_ONLY, optionsMode: 'error' });
    await openPids();
    await waitFor(() => expect(api.optionReads().length).toBeGreaterThan(0));
    await quietly(api);
    listWithIds();
    await noChoices(api);
    await quietly(api);
    expect(api.accountReads()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
