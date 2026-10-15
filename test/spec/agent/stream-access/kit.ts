// B3-03i helpers (unit tier): a fake ContentReader (config_items per app, a switch to make reads
// reject), callers of the three identities, a fake of identity's AiConsentReader that reads the
// injected version source first (as B1-02r's reader does), and a RunManager rig that runs several
// runs at once on the B3-03b fakes (test/spec/agent/stream-run/kit.ts, used as is). Expected
// values stay in the rule tests. Ports and factories are built only inside tests, so the
// NotImplemented of the skeleton reddens each test itself.
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { ContentConfig } from '../../../../apps/api/src/modules/content/index.ts';
import type { AgentConsentReader } from '../../../../apps/api/src/modules/agent/stream/access/index.ts';
import type {
  AdmissionLimits,
  AdmissionTicket,
  RunOutcome,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  createRunManager,
  type RunBody,
  type RunBodyResult,
  type RunConfig,
  type RunFacts,
  type RunFinal,
  type RunGuard,
  type RunGuardTarget,
  type RunManager,
  type RunStart,
  type TerminalDraft,
  type TerminalFrame,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  FakeAdmission,
  FakeCards,
  FakeGuard,
  FakeRegistry,
  LIMITS,
  ManualTime,
  META,
  START_MS,
  TestSink,
  texts,
} from '../stream-run/kit.ts';

export { FakeGuard, ManualTime, errorData, framesOf, isTerminal } from '../stream-run/kit.ts';

/** The app of most tests, and a second brand whose configuration must never leak into it. */
export const APP = 'couli';
export const OTHER_APP = 'couli-brand-b';

// ---- ids and callers -------------------------------------------------------------------------

let idNo = 0;
/** A UUIDv7-shaped id, unique within the test run. */
export function newId(): string {
  idNo += 1;
  return `019a0000-0000-7000-8000-${(0xb303900 + idNo).toString(16).padStart(12, '0')}`;
}

export function guest(appId = APP): AgentCaller {
  const deviceId = newId();
  return {
    appId,
    traceId: `trace_b3_03i_${deviceId.slice(-6)}`,
    deviceId,
    deviceHash: `dh-${deviceId}`,
    ipKey: `ipk-${deviceId}`,
    userId: null,
    phoneBound: false,
  };
}

export function member(options: { phoneBound: boolean; appId?: string }): AgentCaller {
  return { ...guest(options.appId), userId: newId(), phoneBound: options.phoneBound };
}

// ---- configuration ---------------------------------------------------------------------------

/** config_items of each app; a key that is absent reads as null (ContentReader: no such key). */
export class FakeConfig {
  readonly apps = new Map<string, Map<string, unknown>>();
  readonly asked: string[] = [];
  /** When set, every read rejects (a database or cache refresh failure). */
  fail = false;
  set(appId: string, key: string, value: unknown): this {
    let items = this.apps.get(appId);
    if (items === undefined) {
      items = new Map<string, unknown>();
      this.apps.set(appId, items);
    }
    items.set(key, value);
    return this;
  }
  unset(appId: string, key: string): this {
    this.apps.get(appId)?.delete(key);
    return this;
  }
  configValue(appId: string, key: string): Promise<ContentConfig | null> {
    this.asked.push(`${appId}:${key}`);
    if (this.fail) return Promise.reject(new Error('config_items read failed'));
    const items = this.apps.get(appId);
    if (items === undefined || !items.has(key)) return Promise.resolve(null);
    return Promise.resolve({ value: structuredClone(items.get(key)) as never, version: 1 });
  }
}

/** Agent switches of one app: open to everyone unless the test says otherwise. */
export function openConfig(appId = APP): FakeConfig {
  return new FakeConfig()
    .set(appId, 'agent.enabled', true)
    .set(appId, 'agent.whitelist_only', false)
    .set(appId, 'agent.whitelist_user_ids', []);
}

// ---- consent ---------------------------------------------------------------------------------

export type Reason = 'missing' | 'withdrawn' | 'outdated';
type AiConsentSubject = Parameters<AgentConsentReader['check']>[0];
type AiConsentVerdict = Awaited<ReturnType<AgentConsentReader['check']>>;

function subjectKey(s: AiConsentSubject): string {
  return s.userId === null ? `${s.appId}|d:${s.deviceId}` : `${s.appId}|u:${s.userId}`;
}

/**
 * identity's AiConsentReader as B1-02r defines it: reads currentVersion(appId) first (a rejection
 * or an invalid value rejects), then answers from the verdicts the test set per subject (default
 * allowed). `fail` makes the record read reject.
 */
export class FakeConsent implements AgentConsentReader {
  readonly calls: AiConsentSubject[] = [];
  readonly #refused = new Map<string, Reason>();
  fail = false;
  readonly currentVersion: (appId: string) => Promise<number>;
  constructor(currentVersion: (appId: string) => Promise<number>) {
    this.currentVersion = currentVersion;
  }
  refuseUser(appId: string, userId: string, reason: Reason): void {
    this.#refused.set(`${appId}|u:${userId}`, reason);
  }
  refuseDevice(appId: string, deviceId: string, reason: Reason): void {
    this.#refused.set(`${appId}|d:${deviceId}`, reason);
  }
  /** The subject's latest record becomes a valid consent again (e.g. consented once more). */
  allowUser(appId: string, userId: string): void {
    this.#refused.delete(`${appId}|u:${userId}`);
  }
  allowDevice(appId: string, deviceId: string): void {
    this.#refused.delete(`${appId}|d:${deviceId}`);
  }
  async check(subject: AiConsentSubject): Promise<AiConsentVerdict> {
    this.calls.push(structuredClone(subject));
    const version = await this.currentVersion(subject.appId);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid version');
    if (this.fail) throw new Error('consent_records read failed');
    const reason = this.#refused.get(subjectKey(subject));
    return reason === undefined ? { allowed: true, version } : { allowed: false, reason };
  }
}

/** A version source with a fixed answer; `fail` makes it reject. */
export class FakeVersion {
  readonly calls: string[] = [];
  value = 1;
  fail = false;
  readonly source = (appId: string): Promise<number> => {
    this.calls.push(appId);
    if (this.fail) return Promise.reject(new Error('version read failed'));
    return Promise.resolve(this.value);
  };
}

/** Settles a promise or a synchronous throw into what happened (never rethrows). */
export async function outcome<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The message of a thrown value (empty when it is not an Error). */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

// ---- several runs on one RunManager ----------------------------------------------------------

/** Defaults except a time limit long enough for the scenarios (guardPollMs 5 000, BR-AI-13). */
export const CONFIG: RunConfig = {
  maxRunMs: 60_000,
  heartbeatMs: 15_000,
  disconnectGraceMs: 30_000,
  guardPollMs: 5_000,
  signalPollMs: 500,
};

export interface Live {
  ownerKey: string;
  ticket: AdmissionTicket;
  sink: TestSink;
  promise: Promise<RunFinal>;
  /** Lets the body end with done stop. */
  finish: () => void;
  aborted: () => unknown;
  settled: () => boolean;
}

/** One persistence or settlement step of a run, in the order the manager made it. */
export type Step =
  | { kind: 'recordEnding'; facts: RunFacts; draft: TerminalDraft }
  | { kind: 'recordFacts'; facts: RunFacts; draft: TerminalDraft | null }
  | { kind: 'settle'; outcome: RunOutcome }
  | { kind: 'finish'; terminal: TerminalFrame };

/** The B3-03b in-memory registry that also records each step (and the PG ending write). */
export class TrailRegistry extends FakeRegistry {
  readonly trail: { runId: string; step: Step }[];
  constructor(trail: { runId: string; step: Step }[]) {
    super([]);
    this.trail = trail;
  }
  override async recordFacts(runId: string, facts: RunFacts, draft?: TerminalDraft): Promise<void> {
    this.trail.push({
      runId,
      step: { kind: 'recordFacts', facts: structuredClone(facts), draft: draft ?? null },
    });
    await super.recordFacts(runId, facts);
  }
  /** B3-03g S4: the ending written with the decision (optional on RunRegistry). */
  recordEnding(runId: string, facts: RunFacts, draft: TerminalDraft): Promise<void> {
    this.trail.push({
      runId,
      step: { kind: 'recordEnding', facts: structuredClone(facts), draft: structuredClone(draft) },
    });
    return Promise.resolve();
  }
  override async finish(runId: string, terminal: TerminalFrame): Promise<void> {
    this.trail.push({ runId, step: { kind: 'finish', terminal: structuredClone(terminal) } });
    await super.finish(runId, terminal);
  }
}

export class TrailAdmission extends FakeAdmission {
  readonly trail: { runId: string; step: Step }[];
  constructor(trail: { runId: string; step: Step }[], quotaLeft: number) {
    super([], quotaLeft);
    this.trail = trail;
  }
  override settle(
    ticket: AdmissionTicket,
    outcome: RunOutcome,
    limits: AdmissionLimits,
  ): Promise<{ refunded: boolean; quotaLeft: number }> {
    this.trail.push({
      runId: ticket.runId,
      step: { kind: 'settle', outcome: structuredClone(outcome) },
    });
    return super.settle(ticket, outcome, limits);
  }
}

export interface MultiRig {
  time: ManualTime;
  manager: RunManager;
  admission: TrailAdmission;
  registry: TrailRegistry;
  /** The persistence and settlement steps of one run, in order (error data without a null fallback_q). */
  steps(runId: string): Step[];
  /** The shared RunManagerDeps.guard. */
  guard: FakeGuard;
  /** Every argument guardFor was called with. */
  guardForCalls: RunGuardTarget[];
  /** Starts a run of `ownerKey` whose body waits until finish(); appId goes into RunStart. */
  start(ownerKey: string, appId?: string): Live;
}

export function multiRig(options: {
  guardFor?: (run: RunGuardTarget) => RunGuard;
  config?: RunConfig;
}): MultiRig {
  const time = new ManualTime();
  const log: string[] = [];
  const trail: { runId: string; step: Step }[] = [];
  const admission = new TrailAdmission(trail, 11);
  const registry = new TrailRegistry(trail);
  const guard = new FakeGuard();
  const guardForCalls: RunGuardTarget[] = [];
  const config = options.config ?? CONFIG;
  const guardFor = options.guardFor;
  const manager = createRunManager({
    admission,
    registry,
    cards: new FakeCards(),
    texts,
    guard,
    ...(guardFor === undefined
      ? {}
      : {
          guardFor: (run: RunGuardTarget) => {
            guardForCalls.push(structuredClone(run));
            return guardFor(run);
          },
        }),
    clock: time.clock,
    scheduler: time.scheduler,
    config,
  });
  return {
    time,
    manager,
    admission,
    registry,
    guard,
    guardForCalls,
    steps: (runId) =>
      trail.filter((t) => t.runId === runId).map((t) => withoutNullFallbackQ(t.step)),
    start(ownerKey, appId) {
      const runId = newId();
      const ticket: AdmissionTicket = {
        runId,
        messageId: newId(),
        sessionId: newId(),
        subject: { tier: 'member', userId: 'u-demo-1' },
        dayKey: '2026-10-06',
        acceptedAtMs: START_MS,
        lockExpiresAtMs: START_MS + config.maxRunMs + 30_000,
      };
      const sink = new TestSink(log, time);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let signal: AbortSignal | undefined;
      const body: RunBody = async (ctx) => {
        signal = ctx.signal;
        ctx.text('正在找');
        await gate;
        return { kind: 'done', finishReason: 'stop' } satisfies RunBodyResult;
      };
      const start: RunStart = {
        ticket,
        ownerKey,
        limits: LIMITS,
        meta: META,
        sink,
        ...(appId === undefined ? {} : { appId }),
      };
      const promise = manager.start(start, body);
      let done = false;
      promise.then(
        () => (done = true),
        () => (done = true),
      );
      return {
        ownerKey,
        ticket,
        sink,
        promise,
        finish: () => release(),
        aborted: () => (signal?.aborted === true ? signal.reason : undefined),
        settled: () => done,
      };
    },
  };
}

/** A RunGuard per owner key whose answer the test changes. */
export class GuardsByOwner {
  readonly guards = new Map<string, FakeGuard>();
  of(ownerKey: string): FakeGuard {
    let guard = this.guards.get(ownerKey);
    if (guard === undefined) {
      guard = new FakeGuard();
      this.guards.set(ownerKey, guard);
    }
    return guard;
  }
  readonly guardFor = (run: RunGuardTarget): RunGuard => this.of(run.ownerKey);
}

/** fallback_q absent and null mean the same (schema): compare without a null one. */
function withoutNullFallbackQ(step: Step): Step {
  const copy = structuredClone(step);
  const strip = (frame: TerminalDraft | TerminalFrame | null): void => {
    if (frame?.event !== 'error') return;
    const data = frame.data as unknown as Record<string, unknown>;
    if (data['fallback_q'] === null) delete data['fallback_q'];
  };
  if (copy.kind === 'recordEnding' || copy.kind === 'recordFacts') strip(copy.draft);
  if (copy.kind === 'finish') strip(copy.terminal);
  return copy;
}
