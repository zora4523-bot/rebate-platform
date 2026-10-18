import { expect, it, vi } from 'vitest';
import { fixture } from './entry-kit.ts';

it('[AC-B1-08n#5] worker 在 queue 与 agent 后启动一次；停机等待 sync 完成再停 agent 和 services', async () => {
  const f = await fixture();
  await f.run('worker');
  expect(f.start.mock.calls).toEqual([[]]);
  expect(f.order).toEqual(['queue-start', 'seed', 'heal-start', 'agent-start', 'sync-start']);
  expect(f.msgs()).toContain('started');
  const held = f.holdLoopStop();
  f.signal('SIGTERM');
  await f.drain();
  expect(f.loopStop).toHaveBeenCalledTimes(1);
  expect(f.order).not.toContain('agent-stop');
  expect(f.servicesStop).not.toHaveBeenCalled();
  held.release();
  await f.settleShutdown();
  expect(f.order).toEqual([
    'queue-start',
    'seed',
    'heal-start',
    'agent-start',
    'sync-start',
    'heal-stop',
    'sync-stop-called',
    'sync-stopped',
    'agent-stop',
    'services-stop',
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['throw', null, undefined, 'no-start', 'queue', 'start-throws'] as const)(
  '[AC-B1-08n#6] 可选运行体 %s 不导致启动失败或额外日志',
  async (answer) => {
    const f = await fixture();
    f.state.agent = answer;
    await f.run('worker');
    expect(f.state.agentGets).toBe(1);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.msgs()).toEqual(['started']);
    f.signal('SIGTERM');
    await f.settleShutdown();
    expect(f.servicesStop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('[AC-B1-08n#7] sync stop 拒绝仍停止底层服务并清空定时器', async () => {
  const f = await fixture();
  await f.run('worker');
  expect(f.start).toHaveBeenCalledTimes(1);
  const held = f.holdLoopStop();
  f.signal('SIGTERM');
  await f.drain();
  expect(f.servicesStop).not.toHaveBeenCalled();
  held.fail(new Error('synthetic sync stop failure'));
  await f.settleShutdown();
  expect(f.servicesStop).toHaveBeenCalledTimes(1);
  expect(f.order.indexOf('sync-stop-called')).toBeLessThan(f.order.indexOf('services-stop'));
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-08n#8] 服务启动期间收到 SIGTERM 不取用同步运行体', async () => {
  const f = await fixture();
  f.onStart(() => f.signal('SIGTERM'));
  await f.run('worker');
  await f.settleShutdown();
  expect(f.state.agentGets).toBe(0);
  expect(f.start).not.toHaveBeenCalled();
  expect(f.servicesStop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-08n#9] 初始化即退出不启动同步', async () => {
  const f = await fixture({ COULI_EXIT_AFTER_INIT: '1' });
  await f.run('worker');
  expect(f.msgs()).toContain('started');
  expect(f.state.agentGets).toBe(0);
  expect(f.start).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-08n#20] agent 启动时收到信号，订单同步仍须检查 stopping', async () => {
  const f = await fixture();
  f.onAgentStart(() => f.signal('SIGTERM'));
  await f.run('worker');
  await f.settleShutdown();
  expect(f.state.agentGets).toBe(0);
  expect(f.start).not.toHaveBeenCalled();
  expect(f.servicesStop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['api', 'stream', 'admin', 'payout'] as const)(
  '[AC-B1-08n#10] %s 不取用同步运行体',
  async (entry) => {
    const f = await fixture();
    await f.run(entry);
    expect(f.msgs()).toContain('started');
    expect(f.state.agentGets).toBe(0);
    expect(f.start).not.toHaveBeenCalled();
    f.signal('SIGINT');
    await f.settleShutdown();
    expect(vi.getTimerCount()).toBe(0);
  },
);
