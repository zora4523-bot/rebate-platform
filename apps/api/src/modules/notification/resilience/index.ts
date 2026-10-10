// Degrade wiring of notification's two external channels (规划/02 §14 短信、推送 rows; §1 原则 4:
// every external call goes through the governance layer; §4.1: SMS, push and the inbox belong to
// notification). Task B1-14c. The rule tests in test/spec/notification/resilience/** import this
// file by path; names, signatures and the semantics written here are the contract.
//
// Both composites take their policy from the degrade registry of platform (B1-14a,
// `createResilienceRegistry`; rows `sms` and `push`) and run every channel call through
// `createGovernor` of platform (timeout per attempt, breaker), with kind `write`: a channel write
// is never retried automatically (the registry rows have maxRetries 0; SMS primary → backup is a
// degrade, not a retry). The channels are ports: no vendor client, protocol, message format or
// credential lives here. The only vendor named by 规划/02 §14 is the primary SMS channel (阿里云,
// provider id `aliyun`); the backup SMS vendor is not decided yet, so the backup is just a port
// with a provider id.
//
// ---------------------------------------------------------------------------------------------
// createSmsSender(deps): SmsSender                                  (§14 短信: 切备用通道, sms.provider)
//
// Construction
//   - One governor per channel: createGovernor(`sms.${provider}`, registry.entry('sms').policy,
//     { scheduler }). Each channel has its own breaker; the backup's breaker never sees the
//     primary's failures. Overrides given to the registry (timeoutMs, breaker) take effect.
//   - Throws GovernanceError('invalid_policy') when a provider id is not a non-empty string, or
//     when the backup's provider id equals the primary's. The switch is not read here.
//
// send(message) — never rejects because of a channel or the switch; it always resolves an
// `SmsSendResult`:
//   1. Read the switch once per send (`providerSwitch.current()`, the value of `sms.provider`).
//      The value equal to the backup's provider id selects the backup (only when a backup is
//      registered). Every other case selects the primary: the primary's id, null, '', an unknown
//      id, a rejected promise or a synchronous throw — a broken switch never stops sending.
//   2. Call the selected channel once through its governor with the same message object.
//      - accepted → outcome `sent` on that route, degraded false;
//      - rejected (the channel answered and said no, e.g. an invalid number) → outcome
//        `rejected`, no failover (the other channel would refuse the same message); it counts as
//        a good attempt in the breaker;
//      - failure (the governor's timeout, circuit_open, or any error the port throws: 5xx, 429,
//        connection reset, …) → step 3.
//   3. Failover: call the other registered channel once, the same way (after a manual switch to
//      the backup, the other channel is the primary). accepted → `sent`, degraded true;
//      rejected → `rejected`, degraded true; failure → outcome `failed`, reason
//      `all_channels_down`. When no other channel is registered → `failed`, reason `no_backup`.
//   An open breaker means its channel is not invoked: the attempt is recorded as `circuit_open`
//   and the send goes on to the other channel at once. Each channel is invoked at most once per
//   send. `attempts` lists every attempt in order, including `circuit_open` ones.
//   What the caller does with `failed` (login page offers WeChat / Apple sign-in, site-owner
//   alerts fall back to the admin console, BR-ID-24) is outside this file.
//
// ---------------------------------------------------------------------------------------------
// createPushDispatcher(deps): PushDispatcher                  (§14 推送: 站内消息 + 回前台拉取兜底, 自动)
//
// Rule chosen here (规划/02 §14 「站内消息 + 回前台拉取兜底」): the inbox message is the record the
// app pulls when it comes back to the foreground, so every notification is written to the inbox
// exactly once, BEFORE the push is attempted; the push is only the fast path. A failed push
// therefore needs no second write: the result just says the push fell back to the inbox. A
// successful push writes nothing more either. There is no switch port (the row says 自动).
//
// Construction: one governor, createGovernor('push', registry.entry('push').policy, { scheduler }).
//
// deliver(notification):
//   1. inbox.write(notification) — not governed (own store). When it rejects, deliver rejects
//      with that same error and the push is not attempted (the job is redelivered at least once;
//      pushing without the record would duplicate pushes on redelivery).
//   2. push.send(notification, signal) once through the governor, kind `write`:
//      accepted → { inbox: 'written', push: 'delivered', pushFailure: null };
//      rejected → { inbox: 'written', push: 'fallback', pushFailure: 'rejected' } (good attempt
//      in the breaker); timeout / circuit_open / any thrown error →
//      { inbox: 'written', push: 'fallback', pushFailure: 'timeout' | 'circuit_open' |
//      'channel_error' }. Channel failures never make deliver reject.
//
// ---------------------------------------------------------------------------------------------
// Attempt results: GovernanceError `timeout` → 'timeout'; GovernanceError `circuit_open` →
// 'circuit_open'; any other thrown error → 'channel_error'; a `rejected` answer → 'rejected';
// an `accepted` answer → 'ok'.
//
// Time comes only from the injected `Scheduler` (the governor's monotonic time; tests drive it by
// hand). Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// `.ts` extensions, import platform values only from '../../platform/index.ts', no NestJS, no
// `process.env`, no logging, no wall clock. Not exported from ../index.ts and not wired into any
// flow yet (later task).
import type { ResilienceRegistry, Scheduler } from '../../platform/index.ts';
import { createGovernor, GovernanceError } from '../../platform/index.ts';

// ---------- SMS ----------

/** One SMS; the composite hands the same object to whichever channel it calls. */
export interface SmsMessage {
  readonly app_id: string;
  /** Idempotency key of this SMS (the caller's record). */
  readonly message_id: string;
  readonly phone: string;
  readonly template: string;
  readonly params: Readonly<Record<string, string>>;
}

/** What a channel answers when it did answer. A channel failure is a thrown / rejected error. */
export type SmsChannelAnswer =
  | { readonly status: 'accepted'; readonly providerMessageId: string }
  | { readonly status: 'rejected' };

/** An SMS channel port. `provider` is the id `sms.provider` names (e.g. `aliyun`). */
export interface SmsChannel {
  readonly provider: string;
  send(message: SmsMessage, signal: AbortSignal): Promise<SmsChannelAnswer>;
}

/** Reads the current value of the switch `sms.provider`; null when unset. */
export interface SmsProviderSwitch {
  current(): Promise<string | null>;
}

export interface SmsSenderDeps {
  readonly registry: ResilienceRegistry;
  readonly primary: SmsChannel;
  /** Absent when no backup channel is registered. */
  readonly backup?: SmsChannel;
  readonly providerSwitch: SmsProviderSwitch;
  readonly scheduler: Scheduler;
}

export type SmsRoute = 'primary' | 'backup';

export type AttemptResult = 'ok' | 'rejected' | 'timeout' | 'circuit_open' | 'channel_error';

export interface SmsAttempt {
  readonly provider: string;
  readonly route: SmsRoute;
  readonly result: AttemptResult;
}

export type SmsSendResult =
  | {
      readonly outcome: 'sent';
      /** Provider id of the channel that accepted the SMS. */
      readonly provider: string;
      readonly route: SmsRoute;
      /** The route the switch selected. */
      readonly selected: SmsRoute;
      /** True when the SMS went out on the other channel because the selected one failed. */
      readonly degraded: boolean;
      readonly providerMessageId: string;
      readonly attempts: readonly SmsAttempt[];
    }
  | {
      readonly outcome: 'rejected';
      readonly provider: string;
      readonly route: SmsRoute;
      readonly selected: SmsRoute;
      readonly degraded: boolean;
      readonly attempts: readonly SmsAttempt[];
    }
  | {
      readonly outcome: 'failed';
      readonly reason: 'all_channels_down' | 'no_backup';
      readonly selected: SmsRoute;
      readonly attempts: readonly SmsAttempt[];
    };

export interface SmsSender {
  send(message: SmsMessage): Promise<SmsSendResult>;
}

export function createSmsSender(deps: SmsSenderDeps): SmsSender {
  const { primary, backup, providerSwitch, registry, scheduler } = deps;
  if (
    typeof primary.provider !== 'string' ||
    primary.provider.trim() === '' ||
    (backup !== undefined &&
      (typeof backup.provider !== 'string' ||
        backup.provider.trim() === '' ||
        backup.provider === primary.provider))
  ) {
    throw new GovernanceError('invalid_policy', 'sms', 'Invalid SMS provider identifiers');
  }

  const policy = registry.entry('sms').policy;
  const channelRoute = (channel: SmsChannel, route: SmsRoute) => ({
    channel,
    provider: channel.provider,
    route,
    governor: createGovernor(`sms.${channel.provider}`, policy, { scheduler }),
  });
  // Keep each breaker across sends, independently of the current switch value.
  const primaryRoute = channelRoute(primary, 'primary');
  const backupRoute = backup === undefined ? undefined : channelRoute(backup, 'backup');

  return {
    async send(message) {
      let selectedRoute = primaryRoute;
      try {
        const provider = await providerSwitch.current();
        if (backupRoute !== undefined && provider === backupRoute.provider) {
          selectedRoute = backupRoute;
        }
      } catch {
        // A failed switch read (including a synchronous throw) uses the primary.
      }
      const selected = selectedRoute.route;
      const otherRoute = selected === 'primary' ? backupRoute : primaryRoute;
      const attempts: SmsAttempt[] = [];
      for (const target of [selectedRoute, otherRoute]) {
        if (target === undefined) continue;
        const { channel, provider, route, governor } = target;
        let answer: SmsChannelAnswer;
        try {
          answer = await governor.call((signal) => channel.send(message, signal), {
            kind: 'write',
          });
        } catch (error) {
          attempts.push({ provider, route, result: channelFailure(error) });
          continue;
        }
        // A refusal is a completed channel response, so the governor counts it as healthy.
        attempts.push({
          provider,
          route,
          result: answer.status === 'accepted' ? 'ok' : 'rejected',
        });
        const result = { provider, route, selected, degraded: route !== selected, attempts };
        if (answer.status === 'accepted') {
          return { ...result, outcome: 'sent', providerMessageId: answer.providerMessageId };
        }
        return { ...result, outcome: 'rejected' };
      }
      return {
        outcome: 'failed',
        reason: otherRoute === undefined ? 'no_backup' : 'all_channels_down',
        selected,
        attempts,
      };
    },
  };
}

function channelFailure(error: unknown): 'timeout' | 'circuit_open' | 'channel_error' {
  if (
    error instanceof GovernanceError &&
    (error.code === 'timeout' || error.code === 'circuit_open')
  ) {
    return error.code;
  }
  return 'channel_error';
}

// ---------- Push with inbox fallback ----------

/** One notification; written to the inbox and pushed as the same object. */
export interface UserNotification {
  readonly app_id: string;
  readonly user_id: string;
  /** Idempotency key of this notification. */
  readonly notification_id: string;
  readonly title: string;
  readonly body: string;
}

export type PushChannelAnswer = { readonly status: 'accepted' } | { readonly status: 'rejected' };

/** The push channel port; a channel failure is a thrown / rejected error. */
export interface PushChannel {
  send(notification: UserNotification, signal: AbortSignal): Promise<PushChannelAnswer>;
}

/** The inbox port (notification's own store). */
export interface InboxWriter {
  write(notification: UserNotification): Promise<void>;
}

export interface PushDispatcherDeps {
  readonly registry: ResilienceRegistry;
  readonly push: PushChannel;
  readonly inbox: InboxWriter;
  readonly scheduler: Scheduler;
}

export interface PushDeliveryResult {
  readonly inbox: 'written';
  readonly push: 'delivered' | 'fallback';
  readonly pushFailure: Exclude<AttemptResult, 'ok'> | null;
}

export interface PushDispatcher {
  deliver(notification: UserNotification): Promise<PushDeliveryResult>;
}

export function createPushDispatcher(deps: PushDispatcherDeps): PushDispatcher {
  const { registry, scheduler, push, inbox } = deps;
  const governor = createGovernor('push', registry.entry('push').policy, { scheduler });
  return {
    async deliver(notification) {
      // Store failure must propagate unchanged; only push failures become a fallback.
      await inbox.write(notification);
      try {
        const answer = await governor.call((signal) => push.send(notification, signal), {
          kind: 'write',
        });
        return answer.status === 'accepted'
          ? { inbox: 'written', push: 'delivered', pushFailure: null }
          : { inbox: 'written', push: 'fallback', pushFailure: 'rejected' };
      } catch (error) {
        return { inbox: 'written', push: 'fallback', pushFailure: channelFailure(error) };
      }
    },
  };
}
