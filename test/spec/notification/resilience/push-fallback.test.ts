// 推送失败回落站内消息的规则测试（B1-14c；规划/02 §14 推送行：通道故障 → 站内消息 + 回前台拉取兜底，
// 开关「自动」；§1 原则 4）。契约是 apps/api/src/modules/notification/resilience/index.ts 的头注释：
// 站内消息是回前台拉取的依据，每条通知先写一次站内消息再推送；推送成功或失败都不写第二条。策略只经
// platform 公共出口的登记表 push 行取得；通道故障取自 QA-05a 的故障定义（只消费 status、延迟、连接
// 重置）。期望值一律手写字面量。只用顶层 it（规划/11 §4.3）。
import { expect, it } from 'vitest';
import { createPushDispatcher } from '../../../../apps/api/src/modules/notification/resilience/index.ts';
import type {
  PushDeliveryResult,
  PushDispatcher,
} from '../../../../apps/api/src/modules/notification/resilience/index.ts';
import type { ResilienceRegistry } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  ACCEPT,
  REJECT,
  fastBreaker,
  fault,
  notification,
  observe,
  pushRig,
  registry,
  settle,
} from './kit.ts';
import type { Observed, PushRig } from './kit.ts';

function dispatcher(rig: PushRig, reg: ResilienceRegistry = registry()): PushDispatcher {
  return createPushDispatcher({
    registry: reg,
    push: rig.push,
    inbox: rig.inbox,
    scheduler: rig.scheduler,
  });
}

async function deliverOne(
  rig: PushRig,
  d: PushDispatcher,
  n = 1,
): Promise<Observed<PushDeliveryResult>> {
  return settle(rig.scheduler, observe(d.deliver(notification(n))));
}

it('[02 §14 推送] 推送成功：站内消息先写入一次再推送，推送只调用一次，不写第二条站内消息', async () => {
  const rig = pushRig([ACCEPT]);
  const outcome = await deliverOne(rig, dispatcher(rig));
  expect({
    settled: outcome.settled,
    value: outcome.value,
    order: rig.log.map((l) => l.port),
    inbox: rig.inbox.writes,
    pushed: rig.push.calls.map((c) => c.message.notification_id),
    sameObject: rig.push.calls[0]?.message === rig.inbox.writes[0],
  }).toEqual({
    settled: 'resolved',
    value: { inbox: 'written', push: 'delivered', pushFailure: null },
    order: ['inbox', 'push'],
    inbox: [
      {
        app_id: 'app-synthetic',
        user_id: 'user-synthetic',
        notification_id: 'ntf-1',
        title: '合成标题',
        body: '合成正文',
      },
    ],
    pushed: ['ntf-1'],
    sameObject: true,
  });
});

it('[02 §14 推送][QA-05a] 推送通道 503、连接重置、429：回落站内消息（照常写入一次），结果标明推送未送达；推送不自动重试', async () => {
  const results: unknown[] = [];
  for (const scenario of ['server_error', 'connection_reset', 'rate_limited'] as const) {
    const rig = pushRig([fault(scenario), ACCEPT]);
    const outcome = observe(dispatcher(rig).deliver(notification()));
    await rig.scheduler.advance(60_000);
    results.push({
      scenario,
      settled: outcome.settled,
      value: outcome.value,
      order: rig.log.map((l) => l.port),
      inboxWrites: rig.inbox.writes.length,
    });
  }
  const fellBack = (scenario: string) => ({
    scenario,
    settled: 'resolved',
    value: { inbox: 'written', push: 'fallback', pushFailure: 'channel_error' },
    order: ['inbox', 'push'],
    inboxWrites: 1,
  });
  expect(results).toEqual([
    fellBack('server_error'),
    fellBack('connection_reset'),
    fellBack('rate_limited'),
  ]);
});

it('[02 §14 推送][02 §1 原则 4][QA-05a] 推送超时：按登记表 push 行单次时限 3000 毫秒中止推送并回落，站内消息已在推送前写入', async () => {
  const rig = pushRig([fault('timeout')]);
  const outcome = observe(dispatcher(rig).deliver(notification()));
  await rig.scheduler.advance(2999);
  const before = {
    settled: outcome.settled,
    inboxWrites: rig.inbox.writes.length,
    aborted: rig.push.calls[0]?.signal.aborted,
  };
  await rig.scheduler.advance(1);
  expect({
    before,
    settled: outcome.settled,
    value: outcome.value,
    aborted: rig.push.calls[0]?.signal.aborted,
    pushCalls: rig.push.calls.length,
    inboxWrites: rig.inbox.writes.length,
  }).toEqual({
    before: { settled: 'pending', inboxWrites: 1, aborted: false },
    settled: 'resolved',
    value: { inbox: 'written', push: 'fallback', pushFailure: 'timeout' },
    aborted: true,
    pushCalls: 1,
    inboxWrites: 1,
  });
});

it('[02 §14 推送][02 §1 原则 4] 登记表对 push 的时限覆盖（1000 毫秒）生效', async () => {
  const rig = pushRig([fault('timeout')]);
  const outcome = observe(
    dispatcher(rig, registry({ push: { timeoutMs: 1000 } })).deliver(notification()),
  );
  await rig.scheduler.advance(999);
  const before = outcome.settled;
  await rig.scheduler.advance(1);
  expect({ before, settled: outcome.settled, value: outcome.value }).toEqual({
    before: 'pending',
    settled: 'resolved',
    value: { inbox: 'written', push: 'fallback', pushFailure: 'timeout' },
  });
});

it('[02 §14 推送] 推送通道应答拒收：同样回落站内消息，标明 rejected，不重发', async () => {
  const rig = pushRig([REJECT, ACCEPT]);
  const outcome = await deliverOne(rig, dispatcher(rig));
  expect({
    settled: outcome.settled,
    value: outcome.value,
    pushCalls: rig.push.calls.length,
    inboxWrites: rig.inbox.writes.length,
  }).toEqual({
    settled: 'resolved',
    value: { inbox: 'written', push: 'fallback', pushFailure: 'rejected' },
    pushCalls: 1,
    inboxWrites: 1,
  });
});

it('[02 §14 推送][02 §1 原则 4] 熔断：推送按登记表熔断策略打开后不再调推送通道、直接回落站内消息；熔断期满恢复推送', async () => {
  const rig = pushRig([fault('server_error'), fault('server_error')]);
  const d = dispatcher(rig, registry(fastBreaker('push')));
  await deliverOne(rig, d, 1);
  await deliverOne(rig, d, 2);
  const open = await deliverOne(rig, d, 3);
  const duringOpen = {
    value: open.value,
    pushCalls: rig.push.calls.length,
    inbox: rig.inbox.writes.map((w) => w.notification_id),
  };
  await rig.scheduler.advance(12_000);
  rig.push.script(ACCEPT);
  const recovered = await deliverOne(rig, d, 4);
  expect({
    duringOpen,
    recovered: recovered.value,
    pushed: rig.push.calls.map((c) => c.message.notification_id),
    inbox: rig.inbox.writes.map((w) => w.notification_id),
  }).toEqual({
    duringOpen: {
      value: { inbox: 'written', push: 'fallback', pushFailure: 'circuit_open' },
      pushCalls: 2,
      inbox: ['ntf-1', 'ntf-2', 'ntf-3'],
    },
    recovered: { inbox: 'written', push: 'delivered', pushFailure: null },
    pushed: ['ntf-1', 'ntf-2', 'ntf-4'],
    inbox: ['ntf-1', 'ntf-2', 'ntf-3', 'ntf-4'],
  });
});

it('[02 §14 推送] 站内消息写入失败：deliver 以同一错误拒绝，不推送（交给至少一次投递重来，避免重复推送）', async () => {
  const rig = pushRig([ACCEPT]);
  const failure = new Error('synthetic inbox store down');
  rig.inbox.failWith = failure;
  const outcome = await deliverOne(rig, dispatcher(rig));
  expect({
    settled: outcome.settled,
    sameError: outcome.error === failure,
    pushCalls: rig.push.calls.length,
    order: rig.log.map((l) => l.port),
  }).toEqual({
    settled: 'rejected',
    sameError: true,
    pushCalls: 0,
    order: ['inbox'],
  });
});
