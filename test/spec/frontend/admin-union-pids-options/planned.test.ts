// @vitest-environment jsdom
// F1-10gc with F1-06zu (D10-284): while adminListUnionAccountOptions is in the shell's planned
// list the 推广位 tab does not read GET /admin/v1/union/account-options (nor union-accounts), its
// register and 【修改】 dialogs offer no account and say 「功能开发中」, the list and the other
// operations work as usual and the 联盟账号 tab is untouched; once the operation leaves the list
// the tab reads the choices again. The lists are built here, not read from the generated file, so
// the cases stay true after the backend ships the operation. When only the 联盟账号 tab is a
// placeholder (its own reads planned, the scene of admin-planned PAGE#4) the 推广位 tab still reads
// union-pids and account-options and never union-accounts.
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ACTIVE_ID,
  JD_ACCOUNT,
  JD_NAME,
  OPTIONS,
  PDD_NAME,
  PID,
  PIDS,
  TAOBAO_ACCOUNT,
  TAOBAO_NAME,
  pids,
  retireUrl,
} from '../admin-union-pids/fixtures.ts';
import {
  FLOW_TIMEOUT,
  LABEL,
  actions,
  choose,
  main,
  openPids,
  openRegister,
  openRetire,
  panel,
  row,
  stepUp,
  verify,
} from '../admin-union-pids/helpers.ts';
import {
  PERMITTED,
  PIDS_ONLY,
  PLANNED,
  accountHintText,
  accountsTabShown,
  chooseIfOffered,
  closeDialog,
  editOffersNone,
  mountPage,
  noToast,
  offeredNow,
  quietly,
} from './kit.ts';
import { OPTIONS_OPERATION, type Backend } from './server.ts';

const NAMES = [TAOBAO_NAME, JD_NAME, PDD_NAME];

/** An operation of another page: the planned lists below are not only the one operation. */
const OTHER_PLANNED = 'adminListInvitees';

/** A planned list made of exactly these operationIds (as admin-planned builds them). */
function planned(...ids: string[]): ReadonlySet<string> {
  return new Set(ids);
}

/**
 * The register dialog and the 【修改】 dialog of a pending row offer no account and mark the
 * select 「功能开发中」.
 */
async function plannedChoices(api: Backend): Promise<void> {
  const form = await openRegister();
  await chooseIfOffered(form, LABEL.platform, /淘宝|taobao/i, api);
  const offered = (await offeredNow(form, LABEL.account, api)).join('|');
  for (const name of NAMES) expect(offered).not.toContain(name);
  expect(offered).not.toContain(TAOBAO_ACCOUNT);
  await waitFor(() => expect(accountHintText(form, LABEL.account)).toContain(PLANNED));
  await closeDialog(form, /登记|新增|添加/);
  await editOffersNone(api, PID.pendingJd, JD_ACCOUNT, NAMES, new RegExp(PLANNED));
}

/**
 * The 联盟账号 tab depends on `operationId`, which is planned: that tab is a placeholder and reads
 * nothing under union-accounts; opening the 推广位 tab reads union-pids and account-options (the
 * row shows the account name from it) and still nothing under union-accounts.
 */
async function accountsTabPlanned(operationId: string): Promise<void> {
  const { api, onError, directFetch } = await mountPage({
    snapshot: PERMITTED,
    planned: planned(operationId),
  });
  await waitFor(() => expect(main().textContent).toContain(PLANNED));
  await quietly(api);
  expect(api.accountReads()).toEqual([]);
  await openPids();
  await waitFor(() => expect(api.sent('GET', PIDS).length).toBeGreaterThan(0));
  await waitFor(() => expect(api.sent('GET', OPTIONS).length).toBeGreaterThan(0));
  await waitFor(() => expect(row(PID.active).textContent).toContain(TAOBAO_NAME));
  await quietly(api);
  expect(api.accountReads()).toEqual([]);
  expect(onError).not.toHaveBeenCalled();
  expect(directFetch).not.toHaveBeenCalled();
  noToast();
}

it(
  '[AC-F1-10gc-PLANNED#1] adminListUnionAccountOptions 为 planned：推广位页签不请求 account-options 也不读 union-accounts，登记下拉为空并提示「功能开发中」，列表与停用照常，联盟账号页签不变',
  async () => {
    const { api, server, onError } = await mountPage({
      snapshot: PERMITTED,
      planned: new Set([OPTIONS_OPERATION]),
    });
    // The 联盟账号 tab is not a placeholder: it reads and shows its list as before.
    await accountsTabShown(api, TAOBAO_NAME);
    expect(main().textContent).not.toContain(PLANNED);
    const accountReads = api.accountReads().length;
    await openPids();
    await quietly(api);
    // The list as usual; without choices the account column shows the account id.
    for (const item of pids()) expect(row(item.pid).textContent).toContain(item.pid);
    expect(row(PID.active).textContent).toContain(TAOBAO_ACCOUNT);
    expect(row(PID.pendingJd).textContent).toContain(JD_ACCOUNT);
    expect(actions(row(PID.pendingJd), /^修改/)).toHaveLength(1);
    expect(actions(row(PID.pendingJd), /^启用/)).toHaveLength(1);
    expect(actions(panel(), /^(?:登记|新增|添加)/)).toHaveLength(1);
    expect(panel().textContent).not.toMatch(/失败|出错/);
    // Another operation works as usual: 【停用】 the active PID.
    const retire = await openRetire(PID.active);
    await verify(await stepUp(retire));
    await waitFor(() => expect(server.requests('POST', retireUrl(ACTIVE_ID))).toHaveLength(1));
    await waitFor(() => expect(actions(row(PID.active), /^停用/)).toEqual([]));
    await plannedChoices(api);
    await quietly(api);
    expect(api.optionReads()).toEqual([]);
    expect(api.accountReads()).toHaveLength(accountReads);
    expect(onError).not.toHaveBeenCalled();
    noToast();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gc-PLANNED#2] 只持 union.pid 且 adminListUnionAccountOptions 为 planned：不请求 account-options，登记下拉为空并提示「功能开发中」',
  async () => {
    const { api, onError } = await mountPage({
      snapshot: PIDS_ONLY,
      planned: new Set([OPTIONS_OPERATION]),
    });
    await openPids();
    await quietly(api);
    expect(row(PID.active).textContent).toContain(TAOBAO_ACCOUNT);
    await plannedChoices(api);
    await quietly(api);
    expect(api.optionReads()).toEqual([]);
    expect(api.accountReads()).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    noToast();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gc-PLANNED#3] 传入的清单含 adminListUnionAccountOptions 时不请求；清单不含它（接口上线后）推广位页签自动恢复读取 account-options 并列出账号',
  async () => {
    const first = await mountPage({
      snapshot: PIDS_ONLY,
      planned: planned(OPTIONS_OPERATION, OTHER_PLANNED),
    });
    await openPids();
    await quietly(first.api);
    await plannedChoices(first.api);
    await quietly(first.api);
    expect(first.api.optionReads()).toEqual([]);
    cleanup();
    const second = await mountPage({ snapshot: PIDS_ONLY, planned: planned(OTHER_PLANNED) });
    await openPids();
    await waitFor(() => expect(second.api.optionReads().length).toBeGreaterThan(0));
    await waitFor(() => expect(row(PID.active).textContent).toContain(TAOBAO_NAME));
    const form = await openRegister();
    await choose(form, LABEL.platform, /淘宝|taobao/i);
    const offered = await choose(form, LABEL.account, new RegExp(TAOBAO_NAME));
    expect(offered.join('|')).not.toContain(JD_NAME);
    expect(form.textContent).not.toContain(PLANNED);
    await quietly(second.api);
    expect(second.api.accountReads()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gc-PLANNED#4] 联盟账号页签依赖的 adminListUnionAccounts 为 planned（该页签占位）：切到推广位照常请求 union-pids，并读 account-options，仍不读 union-accounts',
  async () => {
    await accountsTabPlanned('adminListUnionAccounts');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gc-PLANNED#5] 联盟账号页签依赖的 adminListUnionAlertPhones 为 planned（该页签占位）：切到推广位照常请求 union-pids，并读 account-options，仍不读 union-accounts',
  async () => {
    await accountsTabPlanned('adminListUnionAlertPhones');
  },
  FLOW_TIMEOUT,
);
