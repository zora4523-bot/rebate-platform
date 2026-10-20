// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CID,
  DETAIL,
  LIST,
  PREFILL,
  REASON,
  ROUTE,
  STAFF_REASONS,
  actionPath,
  createServer,
  decided,
  detail,
  failure,
  ok,
  rejectLabel,
  statusLabel,
} from './claims-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  fill,
  loaded,
  mainElement,
  mount,
  note,
  openSelect,
  panel,
  rejectForm,
  review,
  select,
  settled,
  textbox,
} from './claims-helpers.ts';

it(
  '[AC-F1-07f-REVIEW#1] 深链直接读取目标找回单，逐项显示用户值、联盟值和服务端比对结论',
  async () => {
    const { server, directFetch } = await review();
    expect(window.location.pathname).toBe(ROUTE);
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(server.requests('GET', LIST)).toHaveLength(0);
    expect(mainElement().textContent).toContain('用户填写');
    expect(mainElement().textContent).toContain('联盟回传');
    for (const item of server.claim.items) {
      expect(mainElement().textContent).toContain(item.sub_order_id);
      for (const match of item.matches) {
        const matchingRows = within(mainElement())
          .queryAllByRole('row')
          .filter(
            (row) =>
              row.textContent?.includes(match.user_value!) &&
              row.textContent.includes(match.union_value!),
          );
        expect(matchingRows.length, `${item.sub_order_id} ${match.field}`).toBeGreaterThan(0);
        expect(
          matchingRows.some((row) =>
            match.matched
              ? /匹配|一致/.test(row.textContent ?? '') &&
                !/不匹配|不一致/.test(row.textContent ?? '')
              : /不匹配|不一致/.test(row.textContent ?? ''),
          ),
        ).toBe(true);
      }
    }
    expect(mainElement().textContent).toMatch(/通过.*锁定|锁定.*归属/);
    expect(mainElement().textContent).toMatch(/不能撤销|不可撤销/);
    expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(2);
    expect(within(mainElement()).queryAllByRole('button', { name: /^驳回$/ })).toHaveLength(2);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#18] 每条证据记录显示北京时间和对应场景，保留各子订单的全部记录',
  async () => {
    const claim = detail();
    claim.items[0]!.evidence_links = [
      { at: '2026-10-04T18:58:12Z', scene: 'detail' },
      { at: '2026-10-04T10:51:40+08:00', scene: 'search' },
    ];
    claim.items[1]!.evidence_links = [
      { at: '2026-09-28T11:52:10Z', scene: 'home_card' },
      { at: '2026-09-27T16:03:25Z', scene: 'clipboard' },
    ];
    await review(createServer(undefined, claim));
    const records = [
      { time: '2026-10-05 02:58', scene: /detail|详情/ },
      { time: '2026-10-04 10:51', scene: /search|搜索/ },
      { time: '2026-09-28 19:52', scene: /home_card|首页卡片/ },
      { time: '2026-09-28 00:03', scene: /clipboard|剪贴板|粘贴板/ },
    ];
    for (const record of records) {
      const matchingRows = within(mainElement())
        .queryAllByRole('row')
        .filter((row) => row.textContent?.includes(record.time));
      expect(matchingRows, record.time).toHaveLength(1);
      expect(matchingRows[0]!.textContent).toMatch(record.scene);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#16] 通过时订单已失效也按系统 ORDER_INVALID 结案，不能显示通过成功',
  async () => {
    const { server } = await review();
    const response = detail();
    response.reason = REASON;
    response.items[0] = decided(response.items[0]!, {
      decision: 'rejected',
      reject_reason: 'ORDER_INVALID',
      decided_by: null,
      decided_by_name: null,
    });
    server.once('POST', actionPath(0, 'approve'), () => ok(response));
    await note(REASON);
    await click(button(panel(), /^通过$/));
    await waitFor(() =>
      expect(document.body.textContent).toContain('订单已失效，已按系统原因驳回'),
    );
    expect(mainElement().textContent).toContain(rejectLabel('ORDER_INVALID'));
    expect(document.body.textContent).not.toMatch(/通过成功|审核通过成功/);
    expect(document.body.textContent).not.toContain('订单已被自动归属');
    expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(1);
    expect(server.requests('POST')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#17] 驳回遇到 20902 同样刷新整单并关闭过期操作，不重发驳回',
  async () => {
    const { server } = await review();
    const response = detail();
    response.reason = '另一客服已核实';
    response.items[1] = decided(response.items[1]!, { decided_by_name: '客服小周' });
    server.once('GET', DETAIL, () => ok(response));
    server.once('POST', actionPath(1, 'reject'), () =>
      failure(20902, { resource: 'claim_item' }, '状态已变化，请刷新后重试'),
    );
    const form = await rejectForm(1);
    await select(/驳回原因/, rejectLabel('FRAUD'), form);
    await fill(textbox(/说明/, form), REASON);
    await click(button(form, /^(确认驳回|驳回)$/));
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/已被.*处理|他人.*处理|状态已变化.*刷新/),
    );
    await waitFor(() => expect(mainElement().textContent).toContain('客服小周'));
    await settled(server);
    expect(server.requests('POST')).toHaveLength(1);
    expect(server.requests('GET', DETAIL)).toHaveLength(2);
    expect(screen.queryAllByRole('button', { name: /^确认驳回$/ })).toHaveLength(0);
    expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#2] 通过说明空、纯空白和去空白后四字均不可提交，恰五字发送当前子项版本',
  async () => {
    const { server } = await review();
    for (const value of ['', '     ', '  证据核实  ']) {
      await note(value);
      await click(button(panel(), /^通过$/));
      await settled(server);
      expect(server.requests('POST')).toHaveLength(0);
    }
    const response = detail();
    response.reason = '证据已核实';
    response.items[0] = decided(response.items[0]!);
    server.once('POST', actionPath(0, 'approve'), () => ok(response));
    await note('  证据已核实  ');
    await click(button(panel(), /^通过$/));
    await waitFor(() => expect(server.requests('POST', actionPath(0, 'approve'))).toHaveLength(1));
    const request = server.requests('POST')[0]!;
    expect(request.body).toMatchObject({ expected_row_version: 7 });
    const body = request.body as { reason: string };
    expect(body.reason.trim()).toBe('证据已核实');
    expect(Object.keys(request.body as object).sort()).toEqual(['expected_row_version', 'reason']);
    expect(request.headers.has('X-Step-Up-Token')).toBe(false);
    expect(screen.queryAllByRole('dialog', { name: /二次验证/ })).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#3] 一键填入证据核实一致只填写本子项，提交中禁用且重复点击只请求一次',
  async () => {
    const { server } = await review();
    const response = detail();
    response.reason = PREFILL;
    response.items[0] = decided(response.items[0]!);
    const release = server.hold('POST', actionPath(0, 'approve'), () => ok(response));
    try {
      await click(button(panel(), /证据核实一致|一键填入/));
      expect((textbox(/说明/, panel()) as HTMLTextAreaElement).value).toBe(PREFILL);
      expect((textbox(/说明/, panel(1)) as HTMLTextAreaElement).value).toBe('');
      expect(server.requests('POST')).toHaveLength(0);
      const approve = button(panel(), /^通过$/) as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(approve);
        fireEvent.click(approve);
      });
      await waitFor(() =>
        expect(server.requests('POST', actionPath(0, 'approve'))).toHaveLength(1),
      );
      expect(approve.disabled || approve.getAttribute('aria-disabled') === 'true').toBe(true);
      const reject = button(panel(), /^驳回$/) as HTMLButtonElement;
      expect(reject.disabled || reject.getAttribute('aria-disabled') === 'true').toBe(true);
      await click(approve);
      expect(server.requests('POST')).toHaveLength(1);
      expect(server.requests('POST')[0]!.body).toEqual({
        expected_row_version: 7,
        reason: PREFILL,
      });
    } finally {
      release();
    }
    await waitFor(() =>
      expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(1),
    );
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#4] 驳回下拉仅六个客服原因，标签来自完整字典且不含两个系统原因',
  async () => {
    await review();
    const form = await rejectForm(1);
    const options = await openSelect(/驳回原因/, form);
    expect(options).toHaveLength(6);
    for (const reason of STAFF_REASONS)
      expect(
        options.filter((node) => node.textContent?.includes(rejectLabel(reason))),
      ).toHaveLength(1);
    expect(
      options.some(
        (node) =>
          /NOT_IN_POOL|ORDER_INVALID/.test(node.textContent ?? '') ||
          node.textContent?.includes(rejectLabel('NOT_IN_POOL')) ||
          node.textContent?.includes(rejectLabel('ORDER_INVALID')),
      ),
    ).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#5] 驳回缺原因或说明不足不请求，正确提交只包含所选子项版本、原因编码与说明',
  async () => {
    const { server } = await review();
    const form = await rejectForm(1);
    await fill(textbox(/说明/, form), REASON);
    await click(button(form, /^(确认驳回|驳回)$/));
    await settled(server);
    expect(server.requests('POST')).toHaveLength(0);
    await select(/驳回原因/, rejectLabel('EXPIRED_CLICK'), form);
    for (const value of ['', '    ', '  点击过期  ']) {
      await fill(textbox(/说明/, form), value);
      await click(button(form, /^(确认驳回|驳回)$/));
      await settled(server);
      expect(server.requests('POST')).toHaveLength(0);
    }
    const response = detail();
    response.reason = REASON;
    response.items[1] = decided(response.items[1]!, {
      decision: 'rejected',
      reject_reason: 'EXPIRED_CLICK',
    });
    const release = server.hold('POST', actionPath(1, 'reject'), () => ok(response));
    try {
      await fill(textbox(/说明/, form), REASON);
      const submit = button(form, /^(确认驳回|驳回)$/) as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(submit);
        fireEvent.click(submit);
      });
      await waitFor(() => expect(server.requests('POST')).toHaveLength(1));
      expect(submit.disabled || submit.getAttribute('aria-disabled') === 'true').toBe(true);
      expect(server.requests('POST')[0]!.path).toBe(actionPath(1, 'reject'));
      expect(server.requests('POST')[0]!.body).toEqual({
        expected_row_version: 11,
        reason: REASON,
        reject_reason: 'EXPIRED_CLICK',
      });
      await click(submit);
      expect(server.requests('POST')).toHaveLength(1);
    } finally {
      release();
    }
    await waitFor(() => expect(mainElement().textContent).toContain(rejectLabel('EXPIRED_CLICK')));
    expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#6] 成功直接使用整张返回单刷新状态、说明和其他子项，不只修改当前子项',
  async () => {
    const { server } = await review();
    const response = detail();
    response.status = 'approved';
    response.reason = '服务端返回的最新审核说明';
    response.items[0] = decided(response.items[0]!);
    response.items[1] = decided(response.items[1]!, {
      decision: 'rejected',
      reject_reason: 'NOT_IN_POOL',
      decided_by: null,
      decided_by_name: null,
    });
    server.once('POST', actionPath(0, 'approve'), () => ok(response));
    await note(REASON);
    await click(button(panel(), /^通过$/));
    await waitFor(() => expect(mainElement().textContent).toContain(response.reason));
    expect(mainElement().textContent).toContain(statusLabel('approved'));
    expect(mainElement().textContent).toContain(rejectLabel('NOT_IN_POOL'));
    expect(mainElement().textContent).toContain('客服小林');
    expect(within(mainElement()).queryAllByRole('button', { name: /^(通过|驳回)$/ })).toHaveLength(
      0,
    );
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(server.requests('POST')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#7] 通过返回 cancelled 且无审核人时提示订单已被自动归属',
  async () => {
    const { server } = await review();
    const response = detail();
    response.reason = REASON;
    response.items[0] = decided(response.items[0]!, {
      decision: 'cancelled',
      decided_by: null,
      decided_by_name: null,
    });
    server.once('POST', actionPath(0, 'approve'), () => ok(response));
    await note(REASON);
    await click(button(panel(), /^通过$/));
    await waitFor(() => expect(document.body.textContent).toContain('订单已被自动归属'));
    expect(mainElement().textContent).toContain(statusLabel('cancelled'));
    expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(1);
    expect(server.requests('POST')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#8] 通过返回系统 NOT_IN_POOL 显示完整字典原因和自动归属提示',
  async () => {
    const { server } = await review();
    const response = detail();
    response.reason = REASON;
    response.items[0] = decided(response.items[0]!, {
      decision: 'rejected',
      reject_reason: 'NOT_IN_POOL',
      decided_by: null,
      decided_by_name: null,
    });
    server.once('POST', actionPath(0, 'approve'), () => ok(response));
    await note(REASON);
    await click(button(panel(), /^通过$/));
    await waitFor(() => expect(document.body.textContent).toContain('订单已被自动归属'));
    expect(mainElement().textContent).toContain(rejectLabel('NOT_IN_POOL'));
    expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(1);
    expect(server.requests('POST')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#9] 驳回返回系统 ORDER_INVALID 显示服务端原因与订单失效提示',
  async () => {
    const { server } = await review();
    const response = detail();
    response.reason = REASON;
    response.items[1] = decided(response.items[1]!, {
      decision: 'rejected',
      reject_reason: 'ORDER_INVALID',
      decided_by: null,
      decided_by_name: null,
    });
    server.once('POST', actionPath(1, 'reject'), () => ok(response));
    const form = await rejectForm(1);
    await select(/驳回原因/, rejectLabel('OTHER'), form);
    await fill(textbox(/说明/, form), REASON);
    await click(button(form, /^(确认驳回|驳回)$/));
    await waitFor(() =>
      expect(document.body.textContent).toContain('订单已失效，已按系统原因驳回'),
    );
    expect(mainElement().textContent).toContain(rejectLabel('ORDER_INVALID'));
    expect(document.body.textContent).not.toContain('订单已被自动归属');
    expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(1);
    expect(server.requests('POST')[0]!.body).toMatchObject({ reject_reason: 'OTHER' });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#10] 20902 claim_item 提示他人已处理并只重拉一次，不自动重发审核',
  async () => {
    const { server } = await review();
    const response = detail();
    response.reason = '另一客服已核对';
    response.items[0] = decided(response.items[0]!, { decided_by_name: '客服小陈' });
    server.once('GET', DETAIL, () => ok(response));
    server.once('POST', actionPath(0, 'approve'), () =>
      failure(20902, { resource: 'claim_item' }, '状态已变化，请刷新后重试'),
    );
    await note(REASON);
    await click(button(panel(), /^通过$/));
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/已被.*处理|他人.*处理|状态已变化.*刷新/),
    );
    await waitFor(() => expect(mainElement().textContent).toContain('客服小陈'));
    await settled(server);
    expect(server.requests('GET', DETAIL)).toHaveLength(2);
    expect(server.requests('POST')).toHaveLength(1);
    expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#11] 已结案的 approved、rejected、cancelled 均没有审核按钮，系统原因照字典显示',
  async () => {
    const claim = detail();
    claim.status = 'approved';
    claim.reason = REASON;
    claim.items = [
      decided(claim.items[0]!),
      decided(claim.items[1]!, {
        decision: 'rejected',
        reject_reason: 'ORDER_INVALID',
        decided_by: null,
        decided_by_name: null,
      }),
      decided(
        {
          ...claim.items[0]!,
          item_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5ab3',
          sub_order_id: '231005-0987654324',
        },
        { decision: 'cancelled', decided_by: null, decided_by_name: null },
      ),
    ];
    const { server } = await review(createServer(undefined, claim));
    expect(mainElement().textContent).toContain(REASON);
    expect(mainElement().textContent).toContain(rejectLabel('ORDER_INVALID'));
    for (const status of ['approved', 'rejected', 'cancelled'] as const)
      expect(mainElement().textContent).toContain(statusLabel(status));
    expect(
      within(mainElement()).queryAllByRole('button', { name: /^(通过|驳回|确认驳回)$/ }),
    ).toHaveLength(0);
    expect(server.requests('POST')).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#12] 未知 claim_id 的 20001 fields 提示参数或找回单错误，不能显示虚构详情',
  async () => {
    const server = createServer();
    const unknown = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5999';
    await mount(server, `/claims/${unknown}`);
    await waitFor(() =>
      expect(mainElement().textContent).toMatch(/参数.*错误|找回单.*不存在|找回单.*无效/),
    );
    expect(server.requests('GET', `${LIST}/${unknown}`)).toHaveLength(1);
    expect(mainElement().textContent).not.toContain('40401');
    expect(mainElement().textContent).not.toContain(CID);
    expect(within(mainElement()).queryAllByRole('button', { name: /^(通过|驳回)$/ })).toHaveLength(
      0,
    );
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#13] 审核写入 20001 显示字段错误并保留说明，不伪造成功或自动重试',
  async () => {
    const { server } = await review();
    server.once('POST', actionPath(0, 'approve'), () =>
      failure(20001, { fields: ['reason'] }, '参数错误'),
    );
    await note(REASON);
    await click(button(panel(), /^通过$/));
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/参数错误|说明.*(?:错误|不正确|不符合)/),
    );
    await settled(server);
    expect((textbox(/说明/, panel()) as HTMLTextAreaElement).value).toBe(REASON);
    expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(2);
    expect(server.requests('POST')).toHaveLength(1);
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#14] 审核写入 10403 后移除旧详情与操作，提示无权限',
  async () => {
    const { server } = await review();
    server.once('POST', actionPath(0, 'approve'), () =>
      failure(10403, { reason: 'admin_permission_denied' }),
    );
    await note(REASON);
    await click(button(panel(), /^通过$/));
    await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
    expect(mainElement().textContent).not.toContain('135****6021');
    expect(mainElement().textContent).not.toContain(detail().items[0]!.sub_order_id);
    expect(within(mainElement()).queryAllByRole('button', { name: /^(通过|驳回)$/ })).toHaveLength(
      0,
    );
    expect(server.requests('POST')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07f-REVIEW#15] 逐个审核用各自 row_version，第二个子项独立提交后更新整单',
  async () => {
    const { server } = await review();
    const first = detail();
    first.reason = REASON;
    first.items[1] = decided(first.items[1]!);
    server.once('POST', actionPath(1, 'approve'), () => ok(first));
    await note(REASON, 1);
    await click(button(panel(1), /^通过$/));
    await waitFor(() =>
      expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(1),
    );
    expect(document.body.textContent).not.toContain('订单已被自动归属');
    const final = structuredClone(first);
    final.status = 'approved';
    final.items[0] = decided(final.items[0]!);
    server.once('POST', actionPath(0, 'approve'), () => ok(final));
    await note(PREFILL);
    await click(button(panel(), /^通过$/));
    await waitFor(() =>
      expect(within(mainElement()).queryAllByRole('button', { name: /^通过$/ })).toHaveLength(0),
    );
    expect(document.body.textContent).not.toContain('订单已被自动归属');
    expect(server.requests('POST').map((request) => [request.path, request.body])).toEqual([
      [actionPath(1, 'approve'), { expected_row_version: 11, reason: REASON }],
      [actionPath(0, 'approve'), { expected_row_version: 7, reason: PREFILL }],
    ]);
    expect(mainElement().textContent).toContain(statusLabel('approved'));
    await loaded();
  },
  FLOW_TIMEOUT,
);
