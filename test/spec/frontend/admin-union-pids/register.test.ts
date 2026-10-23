// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  JD_ACCOUNT,
  JD_NAME,
  PDD_NAME,
  PID,
  PIDS,
  SITE,
  TAOBAO_ACCOUNT,
  TAOBAO_NAME,
  VERIFY,
  createServer,
  failure,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  LABEL,
  actions,
  assertVerified,
  assertWrite,
  choose,
  click,
  dialog,
  fieldError,
  fill,
  hasRow,
  mount,
  openRegister,
  row,
  settle,
  stepUp,
  stepUpOpen,
  submit,
  textbox,
  textboxes,
  verify,
} from './helpers.ts';

const REGISTER = /登记|新增|添加/;

/** Fills a valid taobao registration: platform, account, site_id, PID, scene. */
async function fillTaobao(form: HTMLElement, pid: string): Promise<string[]> {
  await choose(form, LABEL.platform, /淘宝|taobao/i);
  const offered = await choose(form, LABEL.account, new RegExp(TAOBAO_NAME));
  await fill(textbox(form, LABEL.site), SITE);
  await fill(textbox(form, LABEL.pid), pid);
  await choose(form, LABEL.scene, /share/);
  return offered;
}

/** The one control (input, select) labelled `label` in `scope`. */
function control(scope: HTMLElement, label: RegExp): HTMLElement {
  const found = within(scope)
    .queryAllByLabelText(label)
    .filter((node) => node instanceof HTMLInputElement || node instanceof HTMLSelectElement);
  expect(found, `one control labelled ${String(label)}`).toHaveLength(1);
  return found[0]!;
}

it(
  '[AC-F1-10gb-REG#1] 淘宝登记：账号只列淘宝的，site_id 必填入体；动态码后 POST，新行为待确认',
  async () => {
    const { server } = await mount();
    const form = await openRegister();
    const offered = await fillTaobao(form, '2005');
    expect(offered.join('|')).toContain(TAOBAO_NAME);
    expect(offered.join('|')).not.toContain(JD_NAME);
    expect(offered.join('|')).not.toContain(PDD_NAME);
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
    expect(sent.headers.get('Content-Type')).toMatch(/application\/json/);
    assertWrite(sent);
    assertVerified(server);
    // A new row is always pending: 【修改】 and 【启用】, no 【停用】.
    await waitFor(() => expect(hasRow('2005')).toBe(true));
    expect(row('2005').textContent).toContain('待确认');
    expect(actions(row('2005'), /^修改/)).toHaveLength(1);
    expect(actions(row('2005'), /^启用/)).toHaveLength(1);
    expect(actions(row('2005'), /^停用/)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-REG#2] 非淘宝登记：账号只列该平台的，site_id 不出现或为空且不入体；不填原因时不带 reason',
  async () => {
    const { server } = await mount();
    const form = await openRegister();
    // Typed on taobao first, then the platform changes: the site id must not survive.
    await choose(form, LABEL.platform, /淘宝|taobao/i);
    await fill(textbox(form, LABEL.site), SITE);
    await choose(form, LABEL.platform, /京东|jd/i);
    const offered = await choose(form, LABEL.account, new RegExp(JD_NAME));
    expect(offered.join('|')).not.toContain(TAOBAO_NAME);
    expect(offered.join('|')).not.toContain(PDD_NAME);
    for (const input of textboxes(form, LABEL.site)) expect(input.value).toBe('');
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
    await waitFor(() => expect(hasRow('4005')).toBe(true));
    expect(row('4005').textContent).not.toContain(SITE);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-REG#3] 淘宝不填 site_id：在字段旁提示，不要动态码、不发请求',
  async () => {
    const { server } = await mount();
    const form = await openRegister();
    await choose(form, LABEL.platform, /淘宝|taobao/i);
    await choose(form, LABEL.account, new RegExp(TAOBAO_NAME));
    await fill(textbox(form, LABEL.pid), '2006');
    await choose(form, LABEL.scene, /share/);
    await click(submit(form));
    await settle();
    await waitFor(() => fieldError(textbox(form, LABEL.site)));
    expect(stepUpOpen()).toBe(false);
    expect(server.requests('POST', PIDS)).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-REG#4] 同平台 PID 已登记（20001 fields=[pid]）在 PID 旁提示，不新增行',
  async () => {
    const { server } = await mount();
    const form = await openRegister();
    await fillTaobao(form, PID.active);
    await verify(await stepUp(form));
    await waitFor(() => expect(server.requests('POST', PIDS)).toHaveLength(1));
    const current = await dialog(REGISTER);
    await waitFor(() => fieldError(textbox(current, LABEL.pid)));
    await settle();
    expect(server.requests('POST', PIDS)).toHaveLength(1);
    expect(server.state.filter((item) => item.pid === PID.active)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it.each([
  { field: 'site_id', label: LABEL.site },
  { field: 'union_account_id', label: LABEL.account },
  { field: 'pid_scene', label: LABEL.scene },
] as const)(
  '[AC-F1-10gb-REG#5] 20001 fields=$field 在对应字段旁提示，不自动重发',
  async ({ field, label }) => {
    const server = createServer();
    server.once('POST', PIDS, () => failure(20001, { fields: [field] }));
    await mount(server);
    const form = await openRegister();
    await fillTaobao(form, '2007');
    await verify(await stepUp(form));
    await waitFor(() => expect(server.requests('POST', PIDS)).toHaveLength(1));
    const current = await dialog(REGISTER);
    await waitFor(() => fieldError(control(current, label)));
    await settle();
    expect(server.requests('POST', PIDS)).toHaveLength(1);
    expect(hasRow('2007')).toBe(false);
  },
  FLOW_TIMEOUT,
);
