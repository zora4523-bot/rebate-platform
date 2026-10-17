// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AUTO, createServer, item } from './fixtures.ts';
import { click, control, loaded, mount, settled } from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('[AC-F1-06zf-PERMISSION#1] switch.payout 仅能改行权限交集对应项，自动打款不随 withdraw 前缀放开', async () => {
  const { server } = await mount(createServer(), {
    isSuper: false,
    permissions: ['switch.payout'],
  });
  await loaded('credit.enabled.taobao');
  for (const entry of server.state.filter((value) => value.value_type === 'boolean')) {
    const allowed =
      entry.admin_editable && entry.permissions.includes('switch.payout') && entry.key !== AUTO;
    expect(control(entry.key).disabled, entry.key).toBe(!allowed);
    if (!allowed) await click(control(entry.key));
  }
  await settled(server);
  expect(server.requests('PUT')).toEqual([]);
});

it('[AC-F1-06zf-PERMISSION#2] 读取服务端 permissions，不能在客户端另写允许键表', async () => {
  // Deliberate metadata mutation: frontend authorization must follow the returned row, even
  // when a future registry moves an existing key to a different permission group.
  const server = createServer([
    item('agent.tools.catalog_probe.enabled', { permissions: ['switch.payout'] }),
    item('payout.enabled', { permissions: ['switch.pay'] }),
  ]);
  await mount(server, { isSuper: false, permissions: ['switch.payout'] });
  await loaded('payout.enabled');
  expect(control('agent.tools.catalog_probe.enabled').disabled).toBe(false);
  expect(control('payout.enabled').disabled).toBe(true);
});

it('[AC-F1-06zf-PERMISSION#3] switch.pay 可读全表，只开放支付类行', async () => {
  const { server } = await mount(createServer(), { isSuper: false, permissions: ['switch.pay'] });
  await loaded('credit.enabled.taobao');
  expect(control('pay.enabled').disabled).toBe(false);
  expect(control('payout.enabled').disabled).toBe(true);
  expect(control('agent.enabled').disabled).toBe(true);
  expect(server.requests('PUT')).toEqual([]);
});

it('[AC-F1-06zf-PERMISSION#4] 超管与 switch.all 账号可改全部可编辑项，仍尊重只读和自动打款限制', async () => {
  const { server } = await mount();
  await loaded('credit.enabled.taobao');
  for (const entry of server.state.filter((value) => value.value_type === 'boolean'))
    expect(control(entry.key).disabled, entry.key).toBe(
      !entry.admin_editable || entry.key === AUTO,
    );
  cleanup();
  await mount(createServer(), { isSuper: false, permissions: ['switch.all'] });
  await loaded('credit.enabled.taobao');
  expect(control('payout.enabled').disabled).toBe(false);
  expect(control('pay.enabled').disabled).toBe(false);
  expect(control('agent.whitelist_only').disabled).toBe(true);
});
