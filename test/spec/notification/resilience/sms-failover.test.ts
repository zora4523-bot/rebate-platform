// 短信主备通道切换的规则测试（B1-14c；规划/02 §14 短信行：通道故障 → 切备用通道，开关 sms.provider；
// §1 原则 4：外部依赖一律过治理层）。契约是 apps/api/src/modules/notification/resilience/index.ts
// 的头注释。策略只经 platform 公共出口的登记表 sms 行取得；通道故障取自 QA-05a 的故障定义（只消费
// status、延迟、连接重置）。主通道标识 'aliyun'（02 §14 写明），备用通道只是假标识 'fake-backup'。
// 期望值一律手写字面量。只用顶层 it（规划/11 §4.3）。
import { expect, it } from 'vitest';
import { createSmsSender } from '../../../../apps/api/src/modules/notification/resilience/index.ts';
import type {
  SmsSender,
  SmsSendResult,
} from '../../../../apps/api/src/modules/notification/resilience/index.ts';
import type { ResilienceRegistry } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  ACCEPT,
  BACKUP,
  FakeSmsChannel,
  PRIMARY,
  REJECT,
  fastBreaker,
  fault,
  observe,
  registry,
  settle,
  smsMessage,
  smsRig,
  thrown,
} from './kit.ts';
import type { Observed, SmsRig } from './kit.ts';

function sender(
  rig: SmsRig,
  o: { readonly registry?: ResilienceRegistry; readonly withBackup?: boolean } = {},
): SmsSender {
  return createSmsSender({
    registry: o.registry ?? registry(),
    primary: rig.primary,
    ...(o.withBackup === false ? {} : { backup: rig.backup }),
    providerSwitch: rig.providerSwitch,
    scheduler: rig.scheduler,
  });
}

async function sendOne(rig: SmsRig, s: SmsSender, n = 1): Promise<Observed<SmsSendResult>> {
  return settle(rig.scheduler, observe(s.send(smsMessage(n))));
}

it('[02 §14 短信] 开关指向主通道 aliyun 且主通道正常：只走主通道，未降级；备用通道不被调用', async () => {
  const rig = smsRig({ primary: [ACCEPT], backup: [ACCEPT] });
  const outcome = await sendOne(rig, sender(rig));
  expect({
    settled: outcome.settled,
    value: outcome.value,
    primary: rig.primary.calls.map((c) => c.message),
    backup: rig.backup.calls.length,
  }).toEqual({
    settled: 'resolved',
    value: {
      outcome: 'sent',
      provider: 'aliyun',
      route: 'primary',
      selected: 'primary',
      degraded: false,
      providerMessageId: 'aliyun-1',
      attempts: [{ provider: 'aliyun', route: 'primary', result: 'ok' }],
    },
    primary: [
      {
        app_id: 'app-synthetic',
        message_id: 'sms-msg-1',
        phone: '+8613800000000',
        template: 'login_code',
        params: { code: '123456' },
      },
    ],
    backup: 0,
  });
});

it('[02 §14 短信][QA-05a] 主通道 503（服务端错误）：同一条短信改走备用通道，结果标明实际用备用、发生降级', async () => {
  const rig = smsRig({ primary: [fault('server_error')], backup: [ACCEPT] });
  const outcome = await sendOne(rig, sender(rig));
  expect({
    settled: outcome.settled,
    value: outcome.value,
    order: rig.log.map((l) => l.port),
    sameMessage: rig.backup.calls[0]?.message === rig.primary.calls[0]?.message,
    backupMessage: rig.backup.calls[0]?.message.message_id,
  }).toEqual({
    settled: 'resolved',
    value: {
      outcome: 'sent',
      provider: 'fake-backup',
      route: 'backup',
      selected: 'primary',
      degraded: true,
      providerMessageId: 'fake-backup-1',
      attempts: [
        { provider: 'aliyun', route: 'primary', result: 'channel_error' },
        { provider: 'fake-backup', route: 'backup', result: 'ok' },
      ],
    },
    order: ['sms:aliyun', 'sms:fake-backup'],
    sameMessage: true,
    backupMessage: 'sms-msg-1',
  });
});

it('[02 §14 短信][QA-05a] 主通道连接重置、429 限流同样算通道故障：各自改走备用通道', async () => {
  const results: unknown[] = [];
  for (const scenario of ['connection_reset', 'rate_limited'] as const) {
    const rig = smsRig({ primary: [fault(scenario)], backup: [ACCEPT] });
    const outcome = await sendOne(rig, sender(rig));
    results.push({
      scenario,
      settled: outcome.settled,
      value: outcome.value,
      calls: [rig.primary.calls.length, rig.backup.calls.length],
    });
  }
  const failedOver = (scenario: string) => ({
    scenario,
    settled: 'resolved',
    value: {
      outcome: 'sent',
      provider: 'fake-backup',
      route: 'backup',
      selected: 'primary',
      degraded: true,
      providerMessageId: 'fake-backup-1',
      attempts: [
        { provider: 'aliyun', route: 'primary', result: 'channel_error' },
        { provider: 'fake-backup', route: 'backup', result: 'ok' },
      ],
    },
    calls: [1, 1],
  });
  expect(results).toEqual([failedOver('connection_reset'), failedOver('rate_limited')]);
});

it('[02 §14 短信][02 §1 原则 4][QA-05a] 主通道超时：按登记表 sms 行单次时限 3000 毫秒中止主通道请求，再切备用（不等 QA-05a 的 15000 毫秒）', async () => {
  const rig = smsRig({ primary: [fault('timeout')], backup: [ACCEPT] });
  const outcome = observe(sender(rig).send(smsMessage()));
  await rig.scheduler.advance(2999);
  const before = {
    settled: outcome.settled,
    backupCalls: rig.backup.calls.length,
    primaryAborted: rig.primary.calls[0]?.signal.aborted,
  };
  await rig.scheduler.advance(1);
  expect({
    before,
    settled: outcome.settled,
    value: outcome.value,
    primaryAborted: rig.primary.calls[0]?.signal.aborted,
    backupAt: rig.backup.calls.map((c) => c.at),
  }).toEqual({
    before: { settled: 'pending', backupCalls: 0, primaryAborted: false },
    settled: 'resolved',
    value: {
      outcome: 'sent',
      provider: 'fake-backup',
      route: 'backup',
      selected: 'primary',
      degraded: true,
      providerMessageId: 'fake-backup-1',
      attempts: [
        { provider: 'aliyun', route: 'primary', result: 'timeout' },
        { provider: 'fake-backup', route: 'backup', result: 'ok' },
      ],
    },
    primaryAborted: true,
    backupAt: [3000],
  });
});

it('[02 §14 短信][02 §1 原则 4] 登记表对 sms 的时限覆盖（1500 毫秒）生效：主通道到 1500 毫秒即判超时切备用', async () => {
  const rig = smsRig({ primary: [fault('timeout')], backup: [ACCEPT] });
  const outcome = observe(
    sender(rig, { registry: registry({ sms: { timeoutMs: 1500 } }) }).send(smsMessage()),
  );
  await rig.scheduler.advance(1499);
  const before = { settled: outcome.settled, backupCalls: rig.backup.calls.length };
  await rig.scheduler.advance(1);
  expect({
    before,
    settled: outcome.settled,
    route: outcome.value?.outcome === 'sent' ? outcome.value.route : null,
    backupAt: rig.backup.calls.map((c) => c.at),
  }).toEqual({
    before: { settled: 'pending', backupCalls: 0 },
    settled: 'resolved',
    route: 'backup',
    backupAt: [1500],
  });
});

it('[02 §14 短信][QA-05a] 主通道慢 1000 毫秒但在时限内应答成功：仍走主通道，不降级、不调备用', async () => {
  const rig = smsRig({ primary: [fault('delay')], backup: [ACCEPT] });
  const outcome = observe(sender(rig).send(smsMessage()));
  await rig.scheduler.advance(1000);
  expect({
    settled: outcome.settled,
    value: outcome.value,
    backup: rig.backup.calls.length,
  }).toEqual({
    settled: 'resolved',
    value: {
      outcome: 'sent',
      provider: 'aliyun',
      route: 'primary',
      selected: 'primary',
      degraded: false,
      providerMessageId: 'aliyun-1',
      attempts: [{ provider: 'aliyun', route: 'primary', result: 'ok' }],
    },
    backup: 0,
  });
});

it('[02 §14 短信 sms.provider] 开关指向备用通道（人工切换）：直接走备用通道，不调主通道，不算降级', async () => {
  const rig = smsRig({ primary: [ACCEPT], backup: [ACCEPT], switchValue: BACKUP });
  const outcome = await sendOne(rig, sender(rig));
  expect({
    settled: outcome.settled,
    value: outcome.value,
    primary: rig.primary.calls.length,
  }).toEqual({
    settled: 'resolved',
    value: {
      outcome: 'sent',
      provider: 'fake-backup',
      route: 'backup',
      selected: 'backup',
      degraded: false,
      providerMessageId: 'fake-backup-1',
      attempts: [{ provider: 'fake-backup', route: 'backup', result: 'ok' }],
    },
    primary: 0,
  });
});

it('[02 §14 短信 sms.provider] 开关每条短信都读一次：改开关后下一条短信即换通道，不必重建', async () => {
  const rig = smsRig({ primary: [ACCEPT, ACCEPT], backup: [ACCEPT] });
  const s = sender(rig);
  const first = await sendOne(rig, s, 1);
  rig.providerSwitch.value = BACKUP;
  const second = await sendOne(rig, s, 2);
  rig.providerSwitch.value = PRIMARY;
  const third = await sendOne(rig, s, 3);
  const routeOf = (o: Observed<SmsSendResult>) =>
    o.value?.outcome === 'sent' ? [o.value.provider, o.value.selected, o.value.degraded] : null;
  expect({
    routes: [routeOf(first), routeOf(second), routeOf(third)],
    reads: rig.providerSwitch.reads,
    primaryMessages: rig.primary.calls.map((c) => c.message.message_id),
    backupMessages: rig.backup.calls.map((c) => c.message.message_id),
  }).toEqual({
    routes: [
      ['aliyun', 'primary', false],
      ['fake-backup', 'backup', false],
      ['aliyun', 'primary', false],
    ],
    reads: 3,
    primaryMessages: ['sms-msg-1', 'sms-msg-3'],
    backupMessages: ['sms-msg-2'],
  });
});

it('[02 §14 短信 sms.provider] 人工切到备用后备用通道故障：改走另一个已登记通道（主通道），标明降级', async () => {
  const rig = smsRig({ primary: [ACCEPT], backup: [fault('server_error')], switchValue: BACKUP });
  const outcome = await sendOne(rig, sender(rig));
  expect({ settled: outcome.settled, value: outcome.value }).toEqual({
    settled: 'resolved',
    value: {
      outcome: 'sent',
      provider: 'aliyun',
      route: 'primary',
      selected: 'backup',
      degraded: true,
      providerMessageId: 'aliyun-1',
      attempts: [
        { provider: 'fake-backup', route: 'backup', result: 'channel_error' },
        { provider: 'aliyun', route: 'primary', result: 'ok' },
      ],
    },
  });
});

it('[02 §14 短信 sms.provider] 开关读不到（拒绝、同步抛错、空值、空串、未登记的标识）一律按主通道发送，不因开关故障停发', async () => {
  const cases: {
    readonly name: string;
    readonly value: string | null | Error;
    readonly sync?: boolean;
  }[] = [
    { name: 'rejected', value: new Error('synthetic switch store down') },
    { name: 'sync-throw', value: PRIMARY, sync: true },
    { name: 'null', value: null },
    { name: 'empty', value: '' },
    { name: 'unknown', value: 'not-registered' },
  ];
  const results: unknown[] = [];
  for (const c of cases) {
    const rig = smsRig({ primary: [ACCEPT], backup: [ACCEPT], switchValue: c.value });
    rig.providerSwitch.throwSync = c.sync === true;
    const outcome = await sendOne(rig, sender(rig));
    results.push({
      name: c.name,
      settled: outcome.settled,
      route: outcome.value?.outcome === 'sent' ? outcome.value.route : null,
      selected: outcome.value?.selected,
      calls: [rig.primary.calls.length, rig.backup.calls.length],
    });
  }
  const primary = (name: string) => ({
    name,
    settled: 'resolved',
    route: 'primary',
    selected: 'primary',
    calls: [1, 0],
  });
  expect(results).toEqual([
    primary('rejected'),
    primary('sync-throw'),
    primary('null'),
    primary('empty'),
    primary('unknown'),
  ]);
});

it('[02 §14 短信 sms.provider] 开关指向备用标识但没有登记备用通道：按主通道发送', async () => {
  const rig = smsRig({ primary: [ACCEPT], switchValue: BACKUP });
  const outcome = await sendOne(rig, sender(rig, { withBackup: false }));
  expect({ settled: outcome.settled, value: outcome.value }).toEqual({
    settled: 'resolved',
    value: {
      outcome: 'sent',
      provider: 'aliyun',
      route: 'primary',
      selected: 'primary',
      degraded: false,
      providerMessageId: 'aliyun-1',
      attempts: [{ provider: 'aliyun', route: 'primary', result: 'ok' }],
    },
  });
});

it('[02 §14 短信][02 §1 原则 4] 通道写不自动重试：主备都 503 时每个通道对这条短信只调用 1 次，返回明确失败（不抛异常、不伪造成功）', async () => {
  const rig = smsRig({
    primary: [fault('server_error'), ACCEPT],
    backup: [fault('server_error'), ACCEPT],
  });
  const outcome = observe(sender(rig).send(smsMessage()));
  await rig.scheduler.advance(60_000);
  expect({
    settled: outcome.settled,
    value: outcome.value,
    calls: [rig.primary.calls.length, rig.backup.calls.length],
    pendingWaits: rig.scheduler.pending,
  }).toEqual({
    settled: 'resolved',
    value: {
      outcome: 'failed',
      reason: 'all_channels_down',
      selected: 'primary',
      attempts: [
        { provider: 'aliyun', route: 'primary', result: 'channel_error' },
        { provider: 'fake-backup', route: 'backup', result: 'channel_error' },
      ],
    },
    calls: [1, 1],
    pendingWaits: 0,
  });
});

it('[02 §14 短信][QA-05a] 主备都超时：各在 3000 毫秒中止，共 6000 毫秒后返回 all_channels_down', async () => {
  const rig = smsRig({ primary: [fault('timeout')], backup: [fault('timeout')] });
  const outcome = observe(sender(rig).send(smsMessage()));
  await rig.scheduler.advance(5999);
  const before = outcome.settled;
  await rig.scheduler.advance(1);
  expect({
    before,
    settled: outcome.settled,
    value: outcome.value,
    calls: [rig.primary.calls.map((c) => c.at), rig.backup.calls.map((c) => c.at)],
    aborted: [rig.primary.calls[0]?.signal.aborted, rig.backup.calls[0]?.signal.aborted],
  }).toEqual({
    before: 'pending',
    settled: 'resolved',
    value: {
      outcome: 'failed',
      reason: 'all_channels_down',
      selected: 'primary',
      attempts: [
        { provider: 'aliyun', route: 'primary', result: 'timeout' },
        { provider: 'fake-backup', route: 'backup', result: 'timeout' },
      ],
    },
    calls: [[0], [3000]],
    aborted: [true, true],
  });
});

it('[02 §14 短信] 没有登记备用通道且主通道故障：返回 no_backup 失败，主通道只调用 1 次', async () => {
  const rig = smsRig({ primary: [fault('connection_reset'), ACCEPT] });
  const outcome = observe(sender(rig, { withBackup: false }).send(smsMessage()));
  await rig.scheduler.advance(60_000);
  expect({
    settled: outcome.settled,
    value: outcome.value,
    calls: rig.primary.calls.length,
  }).toEqual({
    settled: 'resolved',
    value: {
      outcome: 'failed',
      reason: 'no_backup',
      selected: 'primary',
      attempts: [{ provider: 'aliyun', route: 'primary', result: 'channel_error' }],
    },
    calls: 1,
  });
});

it('[02 §14 短信] 通道应答拒收（不是通道故障）：不切备用、不重发，结果为 rejected', async () => {
  const rig = smsRig({ primary: [REJECT], backup: [ACCEPT] });
  const outcome = await sendOne(rig, sender(rig));
  expect({
    settled: outcome.settled,
    value: outcome.value,
    calls: [rig.primary.calls.length, rig.backup.calls.length],
  }).toEqual({
    settled: 'resolved',
    value: {
      outcome: 'rejected',
      provider: 'aliyun',
      route: 'primary',
      selected: 'primary',
      degraded: false,
      attempts: [{ provider: 'aliyun', route: 'primary', result: 'rejected' }],
    },
    calls: [1, 0],
  });
});

it('[02 §14 短信][02 §1 原则 4] 熔断：主通道按登记表熔断策略打开后，后续短信不再调主通道、直接走备用；熔断期满回主通道', async () => {
  const rig = smsRig({
    primary: [fault('server_error'), fault('server_error')],
    backup: [ACCEPT, ACCEPT, ACCEPT, ACCEPT],
  });
  const s = sender(rig, { registry: registry(fastBreaker('sms')) });
  await sendOne(rig, s, 1);
  await sendOne(rig, s, 2);
  const third = await sendOne(rig, s, 3);
  const duringOpen = {
    value: third.value,
    primaryCalls: rig.primary.calls.length,
    backupCalls: rig.backup.calls.length,
  };
  await rig.scheduler.advance(11_999);
  const stillOpen = await sendOne(rig, s, 4);
  await rig.scheduler.advance(1);
  rig.primary.script(ACCEPT);
  const recovered = await sendOne(rig, s, 5);
  expect({
    duringOpen,
    stillOpenAttempts: stillOpen.value?.attempts,
    recovered: recovered.value,
    primaryMessages: rig.primary.calls.map((c) => c.message.message_id),
  }).toEqual({
    duringOpen: {
      value: {
        outcome: 'sent',
        provider: 'fake-backup',
        route: 'backup',
        selected: 'primary',
        degraded: true,
        providerMessageId: 'fake-backup-3',
        attempts: [
          { provider: 'aliyun', route: 'primary', result: 'circuit_open' },
          { provider: 'fake-backup', route: 'backup', result: 'ok' },
        ],
      },
      primaryCalls: 2,
      backupCalls: 3,
    },
    stillOpenAttempts: [
      { provider: 'aliyun', route: 'primary', result: 'circuit_open' },
      { provider: 'fake-backup', route: 'backup', result: 'ok' },
    ],
    recovered: {
      outcome: 'sent',
      provider: 'aliyun',
      route: 'primary',
      selected: 'primary',
      degraded: false,
      providerMessageId: 'aliyun-3',
      attempts: [{ provider: 'aliyun', route: 'primary', result: 'ok' }],
    },
    primaryMessages: ['sms-msg-1', 'sms-msg-2', 'sms-msg-5'],
  });
});

it('[02 §14 短信] 主备通道提供方标识必须是非空串且互不相同，否则构造即拒绝（invalid_policy）', () => {
  const rig = smsRig({});
  const base = {
    registry: registry(),
    providerSwitch: rig.providerSwitch,
    scheduler: rig.scheduler,
  };
  expect({
    same: thrown(() =>
      createSmsSender({
        ...base,
        primary: rig.primary,
        backup: new FakeSmsChannel(PRIMARY, rig.scheduler, rig.log, []),
      }),
    ),
    emptyPrimary: thrown(() =>
      createSmsSender({ ...base, primary: new FakeSmsChannel('', rig.scheduler, rig.log, []) }),
    ),
    emptyBackup: thrown(() =>
      createSmsSender({
        ...base,
        primary: rig.primary,
        backup: new FakeSmsChannel('', rig.scheduler, rig.log, []),
      }),
    ),
    valid: thrown(() => createSmsSender({ ...base, primary: rig.primary, backup: rig.backup })),
    calls: [rig.primary.calls.length, rig.backup.calls.length, rig.providerSwitch.reads],
  }).toEqual({
    same: 'invalid_policy',
    emptyPrimary: 'invalid_policy',
    emptyBackup: 'invalid_policy',
    valid: 'returned',
    calls: [0, 0, 0],
  });
});
