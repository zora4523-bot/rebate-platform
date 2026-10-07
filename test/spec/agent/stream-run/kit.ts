// B3-03b helpers: manual time (one Clock and one monotonic Scheduler moved together), fakes of the
// ports (Admission, RunRegistry, CardSequence, RunGuard, RunTexts, sink, Redis get/set), an SSE
// reader, the test's own contract check and fixture cards. Expected values stay in the rule tests.
// Shapes: contracts/agent-stream.schema.json (04 §8.1–8.2); fixtures contracts/fixtures/agent-streams.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type {
  Clock,
  RedisNamespace,
  Scheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  Admission,
  AdmissionLimits,
  AdmissionTicket,
  RunOutcome,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  createRunManager,
  type CardSequence,
  type RunConfig,
  type RunFacts,
  type RunGuard,
  type RunManager,
  type RunRegistration,
  type RunRegistry,
  type RunSink,
  type RunStart,
  type RunTexts,
  type TerminalFrame,
  type UnnumberedCard,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';

const ROOT = new URL('../../../../', import.meta.url);

// ---- time ----------------------------------------------------------------------------------

/** Epoch ms of the test start (2026-10-06T10:00:00+08:00). */
export const START_MS = 1_791_252_000_000;
/** The monotonic source starts far from the epoch so that mixing the two clocks shows. */
const MONO_BASE = 7_000_000;

interface Wait {
  due: number;
  order: number;
  resolve: () => void;
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((r) => setImmediate(r));
}

export class ManualTime {
  #t = 0;
  #order = 0;
  #waits: Wait[] = [];
  readonly clock: Clock = { now: () => new Date(START_MS + this.#t) };
  readonly scheduler: Scheduler = {
    now: () => MONO_BASE + this.#t,
    sleep: (ms, signal) => this.sleep(ms, signal),
  };

  /** Milliseconds since the test start. */
  get t(): number {
    return this.#t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      const wait: Wait = {
        due: this.#t + Math.max(0, Number.isNaN(ms) ? 0 : ms),
        order: (this.#order += 1),
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = (): void => {
        this.#waits = this.#waits.filter((w) => w !== wait);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waits.push(wait);
    });
  }

  /** Moves time to `target` (ms since start), waking every due wait in order. */
  async to(target: number): Promise<void> {
    await flush();
    for (;;) {
      const next = this.#waits
        .filter((w) => w.due <= target)
        .sort((a, b) => a.due - b.due || a.order - b.order)[0];
      if (next === undefined) break;
      this.#waits = this.#waits.filter((w) => w !== next);
      this.#t = Math.max(this.#t, next.due);
      next.resolve();
      await flush();
    }
    this.#t = Math.max(this.#t, target);
    await flush();
  }

  async by(ms: number): Promise<void> {
    await this.to(this.#t + ms);
  }

  /** Advances until `promise` settles or `limit` ms since start pass; true when it settled. */
  async drive(promise: Promise<unknown>, limit: number): Promise<boolean> {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await flush();
    while (!settled && this.#t < limit) {
      const due = this.#waits.map((w) => w.due).sort((a, b) => a - b)[0];
      await this.to(Math.min(limit, due ?? limit));
    }
    return settled;
  }
}

/** A promise that never settles (a body ignoring its signal). */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

// ---- fakes ---------------------------------------------------------------------------------

export const LIMITS: AdmissionLimits = {
  memberDaily: 30,
  guestDaily: 3,
  guestIpDaily: 30,
  perMinute: 10,
  maxRounds: 30,
};

export const IDS = {
  session: '019a0000-0000-7000-8000-000000000001',
  run: '019a0000-0000-7000-8000-000000000101',
  message: '019a0000-0000-7000-8000-000000000201',
};

export function ticketOf(acceptedBeforeMs: number, maxRunMs: number): AdmissionTicket {
  const acceptedAtMs = START_MS - acceptedBeforeMs;
  return {
    runId: IDS.run,
    messageId: IDS.message,
    sessionId: IDS.session,
    subject: { tier: 'member', userId: 'u-demo-1' },
    dayKey: '2026-10-06',
    acceptedAtMs,
    lockExpiresAtMs: acceptedAtMs + maxRunMs + 30_000,
  };
}

export const META = {
  message_id: IDS.message,
  prompt_version: 'demo-prompt-v1',
  model_label: '演示模型',
  ai_label: '内容由 AI 生成，仅供参考',
};

export const TIMEOUT_TEXT = '本轮回答超时了，已给出的结果仍可查看';
export const texts: RunTexts = {
  text: () => TIMEOUT_TEXT,
  errorMsg: (code) => `错误提示-${code}`,
};

export interface SettleCall {
  ticket: AdmissionTicket;
  outcome: RunOutcome;
  limits: AdmissionLimits;
}

/** A manually released barrier: `hold()` makes the next waits block until `release()`. */
export class Barrier {
  #gate: Promise<void> | null = null;
  #open: (() => void) | null = null;
  hold(): void {
    this.#gate = new Promise<void>((resolve) => (this.#open = resolve));
  }
  release(): void {
    this.#open?.();
    this.#gate = null;
    this.#open = null;
  }
  async pass(): Promise<void> {
    if (this.#gate !== null) await this.#gate;
  }
}

export class FakeAdmission implements Admission {
  readonly calls: SettleCall[] = [];
  readonly barrier = new Barrier();
  readonly log: string[];
  readonly quotaLeft: number;
  constructor(log: string[], quotaLeft: number) {
    this.log = log;
    this.quotaLeft = quotaLeft;
  }
  admit(): never {
    throw new Error('admit is not part of RunManager');
  }
  async settle(
    ticket: AdmissionTicket,
    outcome: RunOutcome,
    limits: AdmissionLimits,
  ): Promise<{ refunded: boolean; quotaLeft: number }> {
    this.log.push('settle');
    this.calls.push(structuredClone({ ticket, outcome, limits }));
    await this.barrier.pass();
    this.log.push('settle:done');
    return { refunded: false, quotaLeft: this.quotaLeft };
  }
}

export class FakeRegistry implements RunRegistry {
  readonly registered: RunRegistration[] = [];
  readonly finished: { runId: string; terminal: TerminalFrame }[] = [];
  /** Every recordFacts call, in order (a call, not yet a saved fact). */
  readonly factLog: { runId: string; facts: RunFacts }[] = [];
  /** Facts as saved (what another instance reads); updated only after factsBarrier. */
  readonly savedFacts = new Map<string, RunFacts>();
  /** Terminal frames as saved; updated only after finishBarrier. */
  readonly savedFinal = new Map<string, TerminalFrame>();
  readonly factsBarrier = new Barrier();
  readonly finishBarrier = new Barrier();
  readonly #cancel = new Set<string>();
  cancelPolls = 0;
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  register(run: RunRegistration): Promise<void> {
    this.registered.push(structuredClone(run));
    return Promise.resolve();
  }
  requestCancel(runId: string, ownerKey: string): Promise<'ok' | 'not_found'> {
    const run = this.registered.find((r) => r.runId === runId && r.ownerKey === ownerKey);
    if (run === undefined || this.savedFinal.has(runId)) {
      return Promise.resolve('not_found');
    }
    this.#cancel.add(runId);
    return Promise.resolve('ok');
  }
  cancelRequested(runId: string): Promise<boolean> {
    this.cancelPolls += 1;
    return Promise.resolve(this.#cancel.has(runId));
  }
  async recordFacts(runId: string, facts: RunFacts): Promise<void> {
    const tag = `${facts.ending ?? 'none'}:${facts.cardsDelivered}`;
    this.log.push(`facts:${tag}`);
    this.factLog.push(structuredClone({ runId, facts }));
    await this.factsBarrier.pass();
    this.savedFacts.set(runId, structuredClone(facts));
    this.log.push(`facts:saved:${tag}`);
  }
  facts(runId: string): Promise<RunFacts | null> {
    const saved = this.savedFacts.get(runId);
    return Promise.resolve(saved === undefined ? null : structuredClone(saved));
  }
  async finish(runId: string, terminal: TerminalFrame): Promise<void> {
    this.log.push('finish');
    this.finished.push(structuredClone({ runId, terminal }));
    await this.finishBarrier.pass();
    this.savedFinal.set(runId, structuredClone(terminal));
    this.log.push('finish:done');
  }
  final(runId: string): Promise<TerminalFrame | null> {
    const saved = this.savedFinal.get(runId);
    return Promise.resolve(saved === undefined ? null : structuredClone(saved));
  }
}

export class FakeCards implements CardSequence {
  readonly calls: { sessionId: string; count: number }[] = [];
  /** Explicit first numbers to hand out in order; without them, a plain counter from 1. */
  readonly firsts: number[] | undefined;
  #next = 1;
  constructor(firsts?: number[]) {
    this.firsts = firsts === undefined ? undefined : [...firsts];
  }
  reserve(sessionId: string, count: number): Promise<number> {
    this.calls.push({ sessionId, count });
    if (this.firsts === undefined) {
      const first = this.#next;
      this.#next += count;
      return Promise.resolve(first);
    }
    const first = this.firsts.shift();
    if (first === undefined) return Promise.reject(new Error('no more numbers in this fake'));
    return Promise.resolve(first);
  }
}

/** A guard whose answer the test changes; `throws` makes check() reject. */
export class FakeGuard implements RunGuard {
  answer: null | { code: 30501 | 10004 } = null;
  throws = false;
  checks = 0;
  check(): Promise<null | { code: 30501 | 10004 }> {
    this.checks += 1;
    if (this.throws) return Promise.reject(new Error('config read failed'));
    return Promise.resolve(this.answer === null ? null : { ...this.answer });
  }
}

function eventOf(chunk: string): string {
  return chunk === ': ping\n\n' ? 'ping' : (/^event: ([a-z.]+)\n/.exec(chunk)?.[1] ?? '?');
}

export class TestSink implements RunSink {
  readonly chunks: string[] = [];
  /** Every write call, also failed ones, with the time it was made. */
  readonly attempts: { t: number; event: string }[] = [];
  closed = false;
  /** Time of close(), null while open. */
  closedAt: number | null = null;
  /** Write calls that threw (closed sink or failAt). */
  failures = 0;
  /** 1-based index of the write call that throws (delivery uncertain). */
  failAt: number | null = null;
  readonly #listeners: (() => void)[] = [];
  readonly log: string[];
  readonly time: ManualTime;
  constructor(log: string[], time: ManualTime) {
    this.log = log;
    this.time = time;
  }
  write(chunk: string): void {
    this.attempts.push({ t: this.time.t, event: eventOf(chunk) });
    if (this.closed || this.failAt === this.attempts.length) {
      this.failures += 1;
      throw new Error(this.closed ? 'socket closed' : 'socket reset');
    }
    this.chunks.push(chunk);
    this.log.push(`write:${eventOf(chunk)}`);
  }
  onClose(listener: () => void): void {
    this.#listeners.push(listener);
  }
  close(): void {
    this.closed = true;
    this.closedAt = this.time.t;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * In-memory Redis namespace: get / set with the TTL recorded; no Lua. `view()` is another
 * instance's connection to the same data with its own barriers: a held `setBarrier` records the
 * set call (and its TTL) but applies the value only after release; a held `getBarrier` delays the
 * read result. Used to interleave read-modify-write sequences of two instances.
 */
export class FakeRedis implements RedisNamespace {
  readonly values: Map<string, string>;
  readonly ttls: number[] = [];
  readonly setBarrier = new Barrier();
  readonly getBarrier = new Barrier();
  constructor(values?: Map<string, string>) {
    this.values = values ?? new Map<string, string>();
  }
  view(): FakeRedis {
    return new FakeRedis(this.values);
  }
  async get(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    await this.getBarrier.pass();
    return value;
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.ttls.push(ttlSeconds);
    await this.setBarrier.pass();
    this.values.set(key, value);
  }
  eval(): Promise<unknown> {
    return Promise.reject(new Error('eval is not available in this fake'));
  }
}

// ---- one run -------------------------------------------------------------------------------

export interface Rig {
  time: ManualTime;
  log: string[];
  sink: TestSink;
  admission: FakeAdmission;
  /** The in-memory registry (used by the manager unless `registry` was passed to rig). */
  registry: FakeRegistry;
  cards: FakeCards;
  guard: FakeGuard;
  manager: RunManager;
  start: RunStart;
}

export function rig(options: {
  config: RunConfig;
  acceptedBeforeMs?: number;
  quotaLeft?: number;
  cardFirsts?: number[];
  registry?: RunRegistry;
  time?: ManualTime;
}): Rig {
  const time = options.time ?? new ManualTime();
  const log: string[] = [];
  const sink = new TestSink(log, time);
  const admission = new FakeAdmission(log, options.quotaLeft ?? 17);
  const registry = new FakeRegistry(log);
  const cards = new FakeCards(options.cardFirsts);
  const guard = new FakeGuard();
  const manager = createRunManager({
    admission,
    registry: options.registry ?? registry,
    cards,
    texts,
    guard,
    clock: time.clock,
    scheduler: time.scheduler,
    config: options.config,
  });
  const start: RunStart = {
    ticket: ticketOf(options.acceptedBeforeMs ?? 0, options.config.maxRunMs),
    ownerKey: 'u:u-demo-1',
    limits: LIMITS,
    meta: META,
    sink,
  };
  return { time, log, sink, admission, registry, cards, guard, manager, start };
}

// ---- reading the output --------------------------------------------------------------------

export type Frame = { event: string; id: number; data: Record<string, unknown> };
export type Line = Frame | { comment: 'ping' };

/** Parses SSE text (04 §8.1 layout); undefined when the layout is broken. */
export function parseSse(chunks: readonly string[]): Line[] | undefined {
  const text = chunks.join('');
  if (text === '') return [];
  if (/\r/.test(text) || !text.endsWith('\n\n')) return undefined;
  const out: Line[] = [];
  for (const block of text.slice(0, -2).split('\n\n')) {
    if (block === ': ping') {
      out.push({ comment: 'ping' });
      continue;
    }
    const m = /^event: ([a-z.]+)\nid: ([1-9][0-9]*)\ndata: (.*)$/s.exec(block);
    if (m === null || m[3]!.includes('\n')) return undefined;
    try {
      out.push({ event: m[1]!, id: Number(m[2]), data: JSON.parse(m[3]!) as Frame['data'] });
    } catch {
      return undefined;
    }
  }
  return out;
}

export function framesOf(chunks: readonly string[]): Frame[] {
  const lines = parseSse(chunks);
  if (lines === undefined) throw new Error(`broken SSE: ${JSON.stringify(chunks)}`);
  return lines.filter((l): l is Frame => 'event' in l);
}

export function isTerminal(frame: Frame): boolean {
  return frame.event === 'done' || frame.event === 'error';
}

/** fallback_q absent and null mean the same (schema); compare without a null one. */
export function errorData(data: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(data);
  if (copy['fallback_q'] === null) delete copy['fallback_q'];
  return copy;
}

type Validate = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvLike {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): Validate;
}
let compiled: Validate | undefined;

/** The test's own Ajv2020 check of one frame against the contract. */
export function frameIsValid(frame: unknown): boolean {
  if (compiled === undefined) {
    const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
    const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
      Ajv2020: new (options: { strict: true; allErrors: true }) => AjvLike;
    };
    const addFormats = apiRequire('ajv-formats') as (ajv: AjvLike) => void;
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    ajv.addFormat('int32', {
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= -(2 ** 31) && v <= 2 ** 31 - 1,
    });
    ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
    const schema = readFileSync(new URL('contracts/agent-stream.schema.json', ROOT), 'utf8');
    compiled = ajv.compile(JSON.parse(schema) as object);
  }
  return compiled(frame);
}

/**
 * The stream checks of the contract test (CT-08): every frame valid, meta first and once, ids
 * 1..n, data.seq = id on text.delta / tool.status / card, card ids never repeated, at most one
 * terminal frame and only last. Returns the problems found (empty when fine).
 */
export function streamProblems(frames: readonly Frame[]): string[] {
  const problems: string[] = [];
  const cardIds = new Set<string>();
  frames.forEach((frame, i) => {
    if (!frameIsValid(frame)) problems.push(`frame ${i + 1} fails the contract`);
    if (frame.id !== i + 1) problems.push(`frame ${i + 1} has id ${frame.id}`);
    if ((frame.event === 'meta') !== (i === 0)) problems.push(`meta misplaced at ${i + 1}`);
    if (
      ['text.delta', 'tool.status', 'card'].includes(frame.event) &&
      frame.data['seq'] !== frame.id
    ) {
      problems.push(`frame ${i + 1} data.seq differs from id`);
    }
    if (isTerminal(frame) && i !== frames.length - 1) problems.push(`terminal at ${i + 1}`);
    if (frame.event === 'card') {
      const data = frame.data['data'] as Record<string, unknown>;
      const nested =
        frame.data['type'] === 'product_list'
          ? (data['items'] as { card_id: string }[]).map((x) => x.card_id)
          : frame.data['type'] === 'rebate_quote'
            ? [(data['product'] as { card_id: string }).card_id]
            : [];
      for (const id of [frame.data['card_id'] as string, ...nested]) {
        if (cardIds.has(id)) problems.push(`card id ${id} reused`);
        cardIds.add(id);
      }
    }
  });
  return problems;
}

// ---- fixture cards -------------------------------------------------------------------------

export function fixtureLines(name: string): Line[] {
  const text = readFileSync(
    new URL(`contracts/fixtures/agent-streams/${name}.ndjson`, ROOT),
    'utf8',
  );
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Line);
}

/** normal.ndjson card frames: c1 product_list (items c2, c3) and c4 rebate_quote (product c5). */
export function fixtureCardFrame(type: 'product_list' | 'rebate_quote'): Record<string, unknown> {
  const frame = fixtureLines('normal').find(
    (l): l is Frame => 'event' in l && l.event === 'card' && l.data['type'] === type,
  );
  if (frame === undefined) throw new Error(`normal.ndjson has no ${type} card`);
  return structuredClone(frame.data);
}

/** The caller's input for a numbered card: no seq, no card_id at any level (a fresh copy). */
export function unnumbered(cardFrameData: Record<string, unknown>): UnnumberedCard {
  const copy = structuredClone(cardFrameData);
  delete copy['seq'];
  delete copy['card_id'];
  const data = copy['data'] as Record<string, unknown>;
  if (copy['type'] === 'product_list') {
    for (const item of data['items'] as Record<string, unknown>[]) delete item['card_id'];
  }
  if (copy['type'] === 'rebate_quote')
    delete (data['product'] as Record<string, unknown>)['card_id'];
  return copy as unknown as UnnumberedCard;
}
