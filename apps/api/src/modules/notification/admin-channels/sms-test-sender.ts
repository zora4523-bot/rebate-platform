// B1-12z · The test send of the console's SMS registrations (CT-24t adminRegisterNotifySms /
// adminRetestNotifySms; BR-TEXT-20 细则「短信渠道登记与后台渠道开关」; orchestrator rulings
// D10-335 ③, D10-337 ①, D10-339 ⑤, D10-342 ②). Skeleton: every function throws NotImplemented.
//
// NotifySmsTestSender.send(message) — one SMS, synchronously, to the operator's own verify phone,
// with the signature and template CODE of the registration being tested (never resolved by code:
// the pending registration is not in use yet), filled with `params` (one value per variable the
// code defines for the variant: the operator's sample, else the server's built-in sample):
//   - 'accepted' → the provider accepted it (accepted is not delivered);
//   - 'rejected' → the provider rejected it (including a wrong signature or template CODE) or
//     errored → the operation answers 50301;
//   - 'unknown'  → timed out or the outcome is unknown → the operation answers 50401.
// In staging / prod the entry sends through the B1-12w Aliyun SendSms channel (credentials of the
// deployment configuration only; AccessKeys never reach the database, the audit or the logs).
//
// createFakeNotifySmsTestSender(appEnv): local / test only (any other APP_ENV throws). By default
// every message is accepted; enqueueResult() queues the outcome of the next sends. outbox() holds
// every attempted message in order, whatever its outcome (appId, phone, signName, templateCode,
// params). beforeNextAnswer(callback) is a deterministic hook for concurrency tests: the next send
// (only that one; the hook is taken off before it runs) records its message in the outbox, then
// awaits callback(message), then answers its outcome; sends made inside the callback answer
// normally. Each send takes its queued outcome (or the default accepted) when it starts, before
// the hook runs: the outcome of the in-flight send is fixed then, and a rival's send made inside
// the callback does not consume it (it takes the next queued outcome, else accepted). Nothing is
// logged.
//
// notifySmsTestSenderToken(): the stable Nest token of the entry's sender. The admin entry provides
// the fake under it in local / test (one per entry instance); tests read and script it through
// app.get(notifySmsTestSenderToken()).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.

export type NotifySmsTestResult = 'accepted' | 'rejected' | 'unknown';

export interface NotifySmsTestMessage {
  readonly appId: string;
  /** The operator's verify phone (BR-ID-45), 11 digits; never logged or audited unmasked. */
  readonly phone: string;
  readonly signName: string;
  readonly templateCode: string;
  /** Variable name → value, exactly the variables the code defines for the variant. */
  readonly params: Readonly<Record<string, string>>;
}

export interface NotifySmsTestSender {
  send(message: NotifySmsTestMessage): Promise<NotifySmsTestResult>;
}

export interface FakeNotifySmsTestSender extends NotifySmsTestSender {
  enqueueResult(result: NotifySmsTestResult): void;
  outbox(): readonly NotifySmsTestMessage[];
  /**
   * Runs `callback` once, inside the next send: after its outbox entry, before its answer. That
   * send's outcome was taken from the queue when it started; sends inside `callback` never take it.
   */
  beforeNextAnswer(callback: (message: NotifySmsTestMessage) => Promise<void>): void;
}

/** Only local / test may construct this adapter; default outcome accepted. */
export function createFakeNotifySmsTestSender(appEnv: string): FakeNotifySmsTestSender {
  void appEnv;
  throw new Error('NotImplemented: createFakeNotifySmsTestSender');
}

/** Stable Nest token of the entry's test sender, also used to script the HTTP tests' fake. */
export function notifySmsTestSenderToken(): symbol {
  throw new Error('NotImplemented: notifySmsTestSenderToken');
}
