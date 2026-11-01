// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { LATER_UID, createServer } from './export-fixtures.ts';
import {
  EXPORTER,
  FLOW_TIMEOUT,
  SUPER,
  announceSuccess,
  exportMasked,
  expectMasked,
  filterRisk,
  listed,
  mount,
  nextPage,
  seeTask,
  settled,
  stepUpDialogs,
  unmountAll,
} from './export-helpers.ts';

it(
  '[AC-F1-07je-MASKED#1] 超管未设筛选点【导出】（可直接发或经简单确认）：一次 POST /admin/v1/exports，body 恰为 {resource: users, filters: {}}（filters 省略也可），不带 unmasked / reason / 身份字段，不带 X-Step-Up-Token 与 Idempotency-Key，不弹动态码；202 后提示已创建导出任务并指向导出记录，导出记录里能看到这条任务',
  async () => {
    const server = createServer({ exports: true, records: true });
    const { directFetch } = await mount(server, SUPER);
    const { post, prior } = await exportMasked(server);
    expectMasked(post, {});
    await settled(server);
    expect(server.verifies(), 'no step-up for a masked export').toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
    expect(server.exportPosts()).toHaveLength(1);
    expect(server.tasks, 'the server created one task').toHaveLength(1);
    await announceSuccess(prior);
    await seeTask(server.tasks[0]!.id);
    expect(server.exportPosts(), 'looking at 导出记录 creates no other task').toHaveLength(1);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-MASKED#2] filters 取当前已应用的列表筛选：风控状态已冻结 → {risk_state: frozen}；已封禁且翻到第 2 页 → {risk_state: banned}（不带 page / page_size）；选回全部 → 空 filters',
  async () => {
    const frozen = createServer({ exports: true });
    await mount(frozen, SUPER);
    await filterRisk(frozen, 'frozen');
    const first = await exportMasked(frozen);
    expectMasked(first.post, { risk_state: 'frozen' });
    await settled(frozen);
    await announceSuccess(first.prior);
    unmountAll();

    const banned = createServer({ exports: true, total: 45 });
    await mount(banned, SUPER);
    await filterRisk(banned, 'banned');
    await nextPage(banned);
    await listed(LATER_UID);
    const paging = banned.listQueries().at(-1);
    expect(paging?.['page'], 'the list is on page 2').toBe('2');
    expect(paging?.['risk_state']).toBe('banned');
    const second = await exportMasked(banned);
    expectMasked(second.post, { risk_state: 'banned' });
    await settled(banned);
    await announceSuccess(second.prior);
    unmountAll();

    const cleared = createServer({ exports: true });
    await mount(cleared, SUPER);
    await filterRisk(cleared, 'frozen');
    await filterRisk(cleared, 'all');
    const third = await exportMasked(cleared);
    expectMasked(third.post, {});
    await settled(cleared);
    await announceSuccess(third.prior);
    for (const server of [frozen, banned, cleared]) {
      expect(server.exportPosts(), 'one POST per export').toHaveLength(1);
      expect(server.verifies()).toEqual([]);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-MASKED#3] 非超管（export + user.list，无 pii.*）按已冻结导出：同样只发脱敏 body，不弹动态码，202 后提示已创建导出任务并指向导出记录',
  async () => {
    const server = createServer({ exports: true, records: true });
    await mount(server, EXPORTER);
    await filterRisk(server, 'frozen');
    const { post, prior } = await exportMasked(server);
    expectMasked(post, { risk_state: 'frozen' });
    await settled(server);
    expect(server.verifies()).toEqual([]);
    expect(
      server.tasks.map((task) => task.masked),
      'a masked task',
    ).toEqual([true]);
    await announceSuccess(prior);
    await seeTask(server.tasks[0]!.id);
  },
  FLOW_TIMEOUT,
);
