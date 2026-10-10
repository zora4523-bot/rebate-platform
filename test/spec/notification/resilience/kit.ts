// 共用夹具（B1-14c）：短信主备通道与推送回落站内消息的规则测试。全部输入合成：
// - 登记表只经 platform 公共出口（apps/api/src/modules/platform/index.ts）的 createResilienceRegistry
//   取得，取 sms、push 两行的治理策略；被测组合层是 apps/api/src/modules/notification/resilience。
// - 通道故障取自 QA-05a 的故障定义（infra/fault/fault.ts 的 buildMappings）。QA-05a 没有短信、推送目标，
//   这里只消费故障应答里与协议无关的三项：status、fixedDelayMilliseconds、fault（连接重置），取自
//   'bailian' 目标的按请求头选场景映射（它覆盖 QA-05 的全部故障名）；不另造故障名，不冒称 QA-05a
//   有短信或推送的报文。
// - 通道是假端口：提供方标识只用 'aliyun'（02 §14 写明的主通道）与 'fake-backup'；没有任何真实厂商的
//   接口、报文或密钥。不联网、不 listen、不连库。
// - 时间只走手动 Scheduler（platform/http 规则测试的 ManualScheduler）。
import { expect } from 'vitest';
import { createResilienceRegistry } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  ResilienceOverrides,
  ResilienceRegistry,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  PushChannel,
  PushChannelAnswer,
  InboxWriter,
  SmsChannel,
  SmsChannelAnswer,
  SmsMessage,
  SmsProviderSwitch,
  UserNotification,
} from '../../../../apps/api/src/modules/notification/resilience/index.ts';
import { buildMappings } from '../../../../infra/fault/fault.ts';
import type { FaultKind, StubResponse } from '../../../../infra/fault/fault.ts';
import { ManualScheduler, ending, observe, thrown } from '../../platform/http/kit.ts';
import type { Observed } from '../../platform/http/kit.ts';

export { ManualScheduler, ending, observe, thrown };
export type { Observed };

export const PRIMARY = 'aliyun';
export const BACKUP = 'fake-backup';

/** 登记表（可带覆盖），只经 platform 公共出口。 */
export function registry(overrides?: ResilienceOverrides): ResilienceRegistry {
  return overrides === undefined ? createResilienceRegistry() : createResilienceRegistry(overrides);
}

/** 熔断可确定触发的覆盖：窗口 10000 ms 内至少 2 次、失败率高于 50 % 即打开 12000 ms。 */
export function fastBreaker(dependency: 'sms' | 'push'): ResilienceOverrides {
  return {
    [dependency]: {
      breaker: { windowMs: 10_000, minRequests: 2, failureRatePercent: 50, openMs: 12_000 },
    },
  };
}

// ---------- QA-05a 故障定义 ----------

/** buildMappings('bailian') 里按请求头选场景的那条映射的应答（WireMock 优先级 1）。 */
export function qa05aResponse(scenario: FaultKind): StubResponse {
  const found = buildMappings('bailian').find((m) => m.name === `bailian.${scenario}.header`);
  expect(found, `QA-05a buildMappings('bailian') 缺 ${scenario} 映射`).toBeDefined();
  return (found as { response: StubResponse }).response;
}

export type Reply =
  | { readonly t: 'qa05a'; readonly scenario: FaultKind }
  | { readonly t: 'accept' }
  | { readonly t: 'reject' };

export function fault(scenario: FaultKind): Reply {
  return { t: 'qa05a', scenario };
}

export const ACCEPT: Reply = { t: 'accept' };
export const REJECT: Reply = { t: 'reject' };

/**
 * 按脚本给出一次应答：accept / reject 直接答；QA-05a 场景只消费 status、延迟、连接重置——
 * 延迟走手动 Scheduler 并随 AbortSignal 取消，2xx 当作接受，其他状态与连接重置都抛错（通道故障）。
 * 没排脚本的调用以普通错误失败，由调用次数断言抓住。
 */
async function answer(
  reply: Reply | undefined,
  scheduler: ManualScheduler,
  signal: AbortSignal,
): Promise<'accepted' | 'rejected'> {
  if (reply === undefined) throw new Error('unscripted channel call');
  if (reply.t === 'accept') return 'accepted';
  if (reply.t === 'reject') return 'rejected';
  const response = qa05aResponse(reply.scenario);
  if (response.fault !== undefined) throw new Error('synthetic connection reset');
  if (response.fixedDelayMilliseconds !== undefined) {
    await scheduler.sleep(response.fixedDelayMilliseconds, signal);
  }
  const status = response.status ?? 200;
  if (status >= 200 && status < 300) return 'accepted';
  throw new Error(`synthetic HTTP ${String(status)}`);
}

/** 所有假端口共用的调用记录，按发生顺序。 */
export interface LogEntry {
  readonly port: string;
  readonly at: number;
}

export interface ChannelCall<M> {
  readonly at: number;
  readonly message: M;
  readonly signal: AbortSignal;
}

export class FakeSmsChannel implements SmsChannel {
  readonly provider: string;
  readonly calls: ChannelCall<SmsMessage>[] = [];
  private readonly scheduler: ManualScheduler;
  private readonly log: LogEntry[];
  private readonly replies: Reply[];

  constructor(
    provider: string,
    scheduler: ManualScheduler,
    log: LogEntry[],
    replies: readonly Reply[],
  ) {
    this.provider = provider;
    this.scheduler = scheduler;
    this.log = log;
    this.replies = [...replies];
  }

  /** 追加后续应答（跨多条短信的场景）。 */
  script(...replies: Reply[]): void {
    this.replies.push(...replies);
  }

  async send(message: SmsMessage, signal: AbortSignal): Promise<SmsChannelAnswer> {
    const at = this.scheduler.now();
    this.calls.push({ at, message, signal });
    this.log.push({ port: `sms:${this.provider}`, at });
    const status = await answer(this.replies.shift(), this.scheduler, signal);
    return status === 'accepted'
      ? { status, providerMessageId: `${this.provider}-${String(this.calls.length)}` }
      : { status };
  }
}

/** sms.provider 开关：value 为 Error 时 current() 拒绝；throwSync 为真时同步抛出。 */
export class FakeSwitch implements SmsProviderSwitch {
  value: string | null | Error;
  throwSync = false;
  reads = 0;

  constructor(value: string | null | Error) {
    this.value = value;
  }

  current(): Promise<string | null> {
    this.reads += 1;
    if (this.throwSync) throw new Error('synthetic switch store down (sync)');
    const value = this.value;
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value);
  }
}

export interface SmsRig {
  readonly scheduler: ManualScheduler;
  readonly log: LogEntry[];
  readonly primary: FakeSmsChannel;
  readonly backup: FakeSmsChannel;
  readonly providerSwitch: FakeSwitch;
}

export function smsRig(o: {
  readonly primary?: readonly Reply[];
  readonly backup?: readonly Reply[];
  readonly switchValue?: string | null | Error;
}): SmsRig {
  const scheduler = new ManualScheduler();
  const log: LogEntry[] = [];
  return {
    scheduler,
    log,
    primary: new FakeSmsChannel(PRIMARY, scheduler, log, o.primary ?? []),
    backup: new FakeSmsChannel(BACKUP, scheduler, log, o.backup ?? []),
    providerSwitch: new FakeSwitch(o.switchValue === undefined ? PRIMARY : o.switchValue),
  };
}

export function smsMessage(n = 1): SmsMessage {
  return {
    app_id: 'app-synthetic',
    message_id: `sms-msg-${String(n)}`,
    phone: '+8613800000000',
    template: 'login_code',
    params: { code: '123456' },
  };
}

export class FakePushChannel implements PushChannel {
  readonly calls: ChannelCall<UserNotification>[] = [];
  private readonly scheduler: ManualScheduler;
  private readonly log: LogEntry[];
  private readonly replies: Reply[];

  constructor(scheduler: ManualScheduler, log: LogEntry[], replies: readonly Reply[]) {
    this.scheduler = scheduler;
    this.log = log;
    this.replies = [...replies];
  }

  script(...replies: Reply[]): void {
    this.replies.push(...replies);
  }

  async send(notification: UserNotification, signal: AbortSignal): Promise<PushChannelAnswer> {
    const at = this.scheduler.now();
    this.calls.push({ at, message: notification, signal });
    this.log.push({ port: 'push', at });
    const status = await answer(this.replies.shift(), this.scheduler, signal);
    return { status };
  }
}

export class FakeInbox implements InboxWriter {
  readonly writes: UserNotification[] = [];
  failWith: Error | null = null;
  private readonly scheduler: ManualScheduler;
  private readonly log: LogEntry[];

  constructor(scheduler: ManualScheduler, log: LogEntry[]) {
    this.scheduler = scheduler;
    this.log = log;
  }

  write(notification: UserNotification): Promise<void> {
    this.log.push({ port: 'inbox', at: this.scheduler.now() });
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.writes.push(notification);
    return Promise.resolve();
  }
}

export interface PushRig {
  readonly scheduler: ManualScheduler;
  readonly log: LogEntry[];
  readonly push: FakePushChannel;
  readonly inbox: FakeInbox;
}

export function pushRig(replies: readonly Reply[]): PushRig {
  const scheduler = new ManualScheduler();
  const log: LogEntry[] = [];
  return {
    scheduler,
    log,
    push: new FakePushChannel(scheduler, log, replies),
    inbox: new FakeInbox(scheduler, log),
  };
}

export function notification(n = 1): UserNotification {
  return {
    app_id: 'app-synthetic',
    user_id: 'user-synthetic',
    notification_id: `ntf-${String(n)}`,
    title: '合成标题',
    body: '合成正文',
  };
}

/** 先让排队的回调跑完（不推进时间），再返回结果。 */
export async function settle<T>(
  scheduler: ManualScheduler,
  observed: Observed<T>,
): Promise<Observed<T>> {
  await scheduler.advance(0);
  return observed;
}
