// @vitest-environment jsdom
// F1-06zu (D10-284): on pages that are online, an entry that would call a planned operation is
// disabled and marked 「功能开发中」; clicking it opens nothing and sends nothing. Once the route
// ships (its operationId leaves the list) the entry works again. Accessible names come from
// apps/admin/src/texts/users.ts (relations) and the claim review page; the user detail has no
// 【编辑资料】 entry yet, so adminEditUserProfile only rides along in the planned list.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  REASON as CLAIM_NOTE,
  ROUTE as CLAIM_ROUTE,
  actionPath,
  createServer as claimsServer,
  decided,
  detail as claimDetail,
  ok as claimOk,
} from '../admin-claims/claims-fixtures.ts';
import { note, panel } from '../admin-claims/claims-helpers.ts';
import { INVITEES, createRelationsServer } from '../admin-user-relations/relations-fixtures.ts';
import { detailLoaded, dialog, openDetail } from '../admin-users/helpers.ts';
import {
  ALL_PLANNED,
  FLOW_TIMEOUT,
  OPS,
  PLANNED,
  buttons,
  click,
  expectPlannedButton,
  isDisabled,
  mainElement,
  mount,
  noDialog,
  noToast,
  planned,
  reset,
  settled,
  shipped,
} from './kit.ts';

const CLAIM_REVIEWER: PermissionSnapshot = { isSuper: false, permissions: ['order.claim'] };
const USER_ENTRIES = [
  ['调等级', /调等级/],
  ['改上级', /改上级/],
  ['查看直推名单', /查看直推名单/],
] as const;
const USER_WRITES = [OPS.level, OPS.inviter, OPS.invitees, OPS.profile];

function one(name: RegExp, label: string): HTMLElement {
  const found = buttons(mainElement(), name);
  expect(found, `【${label}】仍在页面上`).toHaveLength(1);
  return found[0]!;
}

async function userDetail(fetch: typeof globalThis.fetch, list: ReadonlySet<string>) {
  const mounted = await mount({ route: '/users', fetch, planned: list });
  await openDetail();
  await detailLoaded();
  return mounted;
}

async function claimReview(fetch: typeof globalThis.fetch, list: ReadonlySet<string>) {
  const mounted = await mount({
    route: CLAIM_ROUTE,
    fetch,
    planned: list,
    snapshot: CLAIM_REVIEWER,
  });
  await waitFor(() =>
    expect(mainElement().textContent).toContain(claimDetail().items[0]!.sub_order_id),
  );
  return mounted;
}

it(
  '[AC-F1-06zu-BTN#1] 用户详情的调等级、改上级、查看直推名单依赖 planned 时置灰并标「功能开发中」，点了不开对话框、不发请求、不弹动态码',
  async () => {
    const server = createRelationsServer();
    const { onError } = await userDetail(server.fetch, planned(...USER_WRITES));
    for (const [label, name] of USER_ENTRIES) await expectPlannedButton(one(name, label), label);
    for (const [label, name] of USER_ENTRIES) await click(one(name, label));
    await settled(server);
    noDialog();
    expect(server.requests('POST')).toEqual([]);
    expect(server.requests('GET', INVITEES)).toEqual([]);
    noToast(onError);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zu-BTN#2] 只有 adminListInvitees 为 planned：只有查看直推名单置灰，调等级与改上级照常并能打开对话框',
  async () => {
    const server = createRelationsServer();
    await userDetail(server.fetch, planned(OPS.invitees));
    await expectPlannedButton(one(/查看直推名单/, '查看直推名单'), '查看直推名单');
    for (const [label, name] of USER_ENTRIES.slice(0, 2)) {
      const node = one(name, label);
      expect(isDisabled(node), `【${label}】可点`).toBe(false);
      expect(node.textContent).not.toContain(PLANNED);
    }
    await click(one(/调等级/, '调等级'));
    await dialog('调等级');
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zu-BTN#3] 用户写接口去掉 planned 后（清单不含它们）三个入口自动恢复，查看直推名单照常请求并打开抽屉',
  async () => {
    const first = createRelationsServer();
    await userDetail(first.fetch, ALL_PLANNED);
    await expectPlannedButton(one(/查看直推名单/, '查看直推名单'), '查看直推名单');
    reset();
    const second = createRelationsServer();
    await userDetail(second.fetch, shipped(...USER_WRITES));
    for (const [label, name] of USER_ENTRIES) {
      const node = one(name, label);
      expect(isDisabled(node), `【${label}】可点`).toBe(false);
      expect(node.textContent).not.toContain(PLANNED);
    }
    await click(one(/查看直推名单/, '查看直推名单'));
    await waitFor(() => expect(second.requests('GET', INVITEES).length).toBeGreaterThan(0));
    await dialog('直推名单');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zu-BTN#4] 找回审核子项的通过与驳回依赖 planned 时置灰并标「功能开发中」，点了不发请求、不出驳回表单',
  async () => {
    const server = claimsServer();
    const { onError } = await claimReview(server.fetch, planned(OPS.approve, OPS.reject));
    const approve = buttons(mainElement(), /^通过/);
    const reject = buttons(mainElement(), /^驳回/);
    expect(approve, '每个待审子项一个【通过】').toHaveLength(2);
    expect(reject, '每个待审子项一个【驳回】').toHaveLength(2);
    for (const node of approve) await expectPlannedButton(node, '通过');
    for (const node of reject) await expectPlannedButton(node, '驳回');
    await act(async () => {
      for (const box of within(mainElement()).queryAllByRole('textbox', { name: /说明/ }))
        fireEvent.change(box, { target: { value: CLAIM_NOTE } });
    });
    for (const node of [...buttons(mainElement(), /^通过/), ...buttons(mainElement(), /^驳回/)])
      await click(node);
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(screen.queryAllByRole('combobox', { name: /驳回原因/ })).toHaveLength(0);
    noDialog();
    noToast(onError);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zu-BTN#5] 子项审核接口去掉 planned 后（清单不含它们）通过与驳回自动恢复，通过照常提交',
  async () => {
    const first = claimsServer();
    await claimReview(first.fetch, ALL_PLANNED);
    const blocked = buttons(mainElement(), /^通过/);
    expect(blocked.length).toBeGreaterThan(0);
    await expectPlannedButton(blocked[0]!, '通过');
    reset();
    const second = claimsServer();
    await claimReview(second.fetch, shipped(OPS.approve, OPS.reject));
    const controls = [...buttons(mainElement(), /^通过$/), ...buttons(mainElement(), /^驳回$/)];
    expect(controls).toHaveLength(4);
    for (const node of controls) expect(isDisabled(node)).toBe(false);
    const response = claimDetail();
    response.reason = CLAIM_NOTE;
    response.items[0] = decided(response.items[0]!);
    second.once('POST', actionPath(0, 'approve'), () => claimOk(response));
    await note(CLAIM_NOTE);
    const approve = buttons(panel(), /^通过$/);
    expect(approve).toHaveLength(1);
    await click(approve[0]!);
    await waitFor(() => expect(second.requests('POST', actionPath(0, 'approve'))).toHaveLength(1));
  },
  FLOW_TIMEOUT,
);
