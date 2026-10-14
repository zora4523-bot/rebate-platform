// B3-03d helpers (unit tier): fakes of every port of createAgentHttp (access ①, identity ②,
// consent ③, the session store ④, admission ⑥–⑩, cancel, Redis signal, limits source, redactor,
// labels), a reply that records JSON answers and SSE chunks, a real RunManager (B3-03b) on the
// stream-run fakes, and contract lookups (openapi.yaml responses, error-codes.yaml, the stream
// schema through the stream-run kit). Expected values stay in the rule tests. Ports are built
// only inside tests, so the NotImplemented of the skeleton reddens each test itself.
import { expect } from 'vitest';

import {
  createAgentHttp,
  type AgentCaller,
  type AgentHttp,
  type AgentHttpReply,
  type AgentHttpSettings,
  type AgentStreamSink,
  type RunBodyInput,
} from '../../../../apps/api/src/modules/agent/http/index.ts';
import type {
  AgentOwner,
  AgentSessionRow,
  AgentSessionStore,
  OwnedSession,
} from '../../../../apps/api/src/modules/agent/store/index.ts';
import type {
  AdmissionLimits,
  AdmissionRequest,
  AdmissionResult,
  AdmissionTicket,
  RedactedText,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type {
  CancelQuery,
  QuotaLimitsSource,
} from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  createRunManager,
  runConfigDefaults,
  type RunBody,
  type RunStart,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  FakeAdmission,
  FakeCards,
  FakeGuard,
  FakeRegistry,
  ManualTime,
  START_MS,
  texts,
} from '../stream-run/kit.ts';
import {
  compile,
  contract,
  errorCodes,
  liveCode,
  object,
  operation,
} from '../../contracts/agent-http/kit.ts';

export {
  errorData,
  flush,
  framesOf,
  isTerminal,
  parseSse,
  START_MS,
  streamProblems,
  texts,
  type Frame,
} from '../stream-run/kit.ts';

export type Row = Record<string, unknown>;

export const APP = 'couli';

/**
 * BR-AI-23 ⑤: a text longer than 500 Unicode code points is 20001 (08, SPEC_REF 7c268cb; K10 code
 * points). Injected as configuration; agentHttpDefaults() must give the same value.
 */
export const TEXT_MAX = 500;
/** BR-AI-20: a session expires at last_active_at + 24 hours. */
export const IDLE_MS = 86_400_000;
export const SETTINGS: AgentHttpSettings = { textMaxCodePoints: TEXT_MAX };

/** Limits the source hands out: none equals admissionDefaults(), so a default shows. */
export const SOURCE_LIMITS: AdmissionLimits = {
  memberDaily: 7,
  guestDaily: 2,
  guestIpDaily: 9,
  perMinute: 4,
  maxRounds: 11,
};

export const LABELS = {
  promptVersion: 'agent-prompt@test-3',
  modelSnapshot: 'snap-current',
  aiLabel: '内容由 AI 生成（测试）',
};
export function modelLabelOf(snapshot: string | null): string {
  return `模型展示名:${snapshot ?? 'none'}`;
}

// ---- ids and callers -------------------------------------------------------------------------

let idNo = 0;
/** A UUIDv7-shaped id, unique within the test run. */
export function newId(): string {
  idNo += 1;
  return `019a0000-0000-7000-8000-${idNo.toString(16).padStart(12, '0')}`;
}

let traceNo = 0;
export function guest(): AgentCaller {
  traceNo += 1;
  const deviceId = newId();
  return {
    appId: APP,
    traceId: `trace_b3_03d_${traceNo}`,
    deviceId,
    deviceHash: `dh-${deviceId}`,
    ipKey: `ipk-${deviceId}`,
    userId: null,
    phoneBound: false,
  };
}

export function member(options: { phoneBound?: boolean; deviceId?: string } = {}): AgentCaller {
  const base = guest();
  const deviceId = options.deviceId ?? base.deviceId;
  return {
    ...base,
    deviceId,
    deviceHash: `dh-${deviceId}`,
    ipKey: `ipk-${deviceId}`,
    userId: newId(),
    phoneBound: options.phoneBound ?? true,
  };
}

export function ownerKeyOf(caller: AgentCaller): string {
  return caller.userId === null ? `d:${caller.deviceId}` : `u:${caller.userId}`;
}

function keyOfOwner(owner: AgentOwner): string {
  return owner.kind === 'user' ? `u:${owner.userId}` : `d:${owner.deviceId}`;
}

// ---- ports -----------------------------------------------------------------------------------

/** A gate (①, ②, ③) whose answer the test sets; null lets the request pass. */
export class Gate<C extends number> {
  answer: { code: C } | null = null;
  /** When set, the answer depends on the caller of this request (overrides `answer`). */
  decide: ((caller: AgentCaller) => { code: C } | null) | null = null;
  readonly calls: AgentCaller[] = [];
  readonly name: string;
  readonly log: string[];
  constructor(name: string, log: string[]) {
    this.name = name;
    this.log = log;
  }
  check(caller: AgentCaller): Promise<null | { code: C }> {
    this.calls.push(structuredClone(caller));
    this.log.push(this.name);
    const answer = this.decide === null ? this.answer : this.decide(structuredClone(caller));
    return Promise.resolve(answer === null ? null : { ...answer });
  }
}

/** The same subject as `caller` with a fresh trace id (one request). */
export function request(caller: AgentCaller, traceId: string): AgentCaller {
  return { ...caller, traceId };
}

/** True when `a` is the subject `b` (every identity field; the trace id is per request). */
export function sameSubject(a: AgentCaller, b: AgentCaller): boolean {
  return (
    a.appId === b.appId &&
    a.userId === b.userId &&
    a.deviceId === b.deviceId &&
    a.deviceHash === b.deviceHash &&
    a.ipKey === b.ipKey &&
    a.phoneBound === b.phoneBound
  );
}

/** The store owner BR-AI-20 derives from a caller. */
export function ownerOf(caller: AgentCaller): AgentOwner {
  return caller.userId === null
    ? { kind: 'device', appId: caller.appId, deviceId: caller.deviceId }
    : { kind: 'user', appId: caller.appId, userId: caller.userId, deviceId: caller.deviceId };
}

interface StoredSession {
  row: AgentSessionRow;
  ownerKey: string;
  expired: boolean;
}

/** AgentSessionStore over in-memory sessions; owners compared by their key (u:… / d:…). */
export class FakeSessions implements AgentSessionStore {
  readonly sessions = new Map<string, StoredSession>();
  /** runId → sessionId. */
  readonly runs = new Map<string, string>();
  readonly calls: { method: string; owner: AgentOwner; arg?: string }[] = [];
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  /** A session of `caller` (the owner per BR-AI-20); returns its id. */
  add(caller: AgentCaller, options: { expired?: boolean; lastActiveMs?: number } = {}): string {
    const id = newId();
    const at = new Date(options.lastActiveMs ?? START_MS - 60_000);
    this.sessions.set(id, {
      row: { id, startedAt: new Date(at.getTime() - 60_000), lastActiveAt: at },
      ownerKey: ownerKeyOf(caller),
      expired: options.expired ?? false,
    });
    return id;
  }
  /** A guest session of the caller's device (what a user must not see after login). */
  addDeviceSession(caller: AgentCaller): string {
    return this.add({ ...caller, userId: null, phoneBound: false });
  }
  addRun(sessionId: string): string {
    const runId = newId();
    this.runs.set(runId, sessionId);
    return runId;
  }
  open(owner: AgentOwner, newId: string): Promise<AgentSessionRow> {
    this.calls.push({ method: 'open', owner: structuredClone(owner), arg: newId });
    this.log.push('sessions.open');
    const at = new Date(START_MS);
    const row = { id: newId, startedAt: at, lastActiveAt: at };
    this.sessions.set(newId, { row, ownerKey: keyOfOwner(owner), expired: false });
    return Promise.resolve({ ...row });
  }
  current(owner: AgentOwner): Promise<AgentSessionRow | null> {
    this.calls.push({ method: 'current', owner: structuredClone(owner) });
    this.log.push('sessions.current');
    const mine = [...this.sessions.values()]
      .filter((s) => s.ownerKey === keyOfOwner(owner) && !s.expired)
      .sort((a, b) => b.row.lastActiveAt.getTime() - a.row.lastActiveAt.getTime());
    return Promise.resolve(mine[0] === undefined ? null : { ...mine[0].row });
  }
  owned(owner: AgentOwner, sessionId: string): Promise<OwnedSession | null> {
    this.calls.push({ method: 'owned', owner: structuredClone(owner), arg: sessionId });
    this.log.push('sessions.owned');
    const s = this.sessions.get(sessionId);
    if (s === undefined || s.ownerKey !== keyOfOwner(owner)) return Promise.resolve(null);
    return Promise.resolve({ session: { ...s.row }, expired: s.expired });
  }
  ownsRun(owner: AgentOwner, runId: string): Promise<boolean> {
    this.calls.push({ method: 'ownsRun', owner: structuredClone(owner), arg: runId });
    this.log.push('sessions.ownsRun');
    const sessionId = this.runs.get(runId);
    const s = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    return Promise.resolve(s !== undefined && s.ownerKey === keyOfOwner(owner));
  }
}

export function ticketFor(req: AdmissionRequest): AdmissionTicket {
  return {
    runId: req.runId,
    messageId: req.messageId,
    sessionId: req.sessionId,
    subject: structuredClone(req.subject),
    dayKey: '2026-10-06',
    acceptedAtMs: START_MS,
    lockExpiresAtMs: START_MS + 50_000,
  };
}

export type AdmitAnswer = (req: AdmissionRequest, limits: AdmissionLimits) => AdmissionResult;

/** admit with a scripted answer (default: accepted with the request's ids); `fail` throws. */
export class ScriptedAdmission {
  readonly admits: { req: AdmissionRequest; limits: AdmissionLimits }[] = [];
  readonly tickets: AdmissionTicket[] = [];
  answer: AdmitAnswer | null = null;
  fail: unknown = undefined;
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  admit(req: AdmissionRequest, limits: AdmissionLimits): Promise<AdmissionResult> {
    this.admits.push(structuredClone({ req, limits }));
    this.log.push('admit');
    if (this.fail !== undefined) return Promise.reject(this.fail);
    if (this.answer !== null) return Promise.resolve(this.answer(req, limits));
    const ticket = ticketFor(req);
    this.tickets.push(ticket);
    return Promise.resolve({ kind: 'accepted', ticket, quotaLeft: 5 });
  }
}

/** The limits source; every call hands out a fresh copy of SOURCE_LIMITS. */
export class FakeLimits implements QuotaLimitsSource {
  readonly calls: string[] = [];
  readonly handed: AdmissionLimits[] = [];
  fail = false;
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  current(appId: string): Promise<AdmissionLimits> {
    this.calls.push(appId);
    this.log.push('limits');
    if (this.fail) return Promise.reject(new Error('config_items read failed'));
    const limits = { ...SOURCE_LIMITS };
    this.handed.push(limits);
    return Promise.resolve(limits);
  }
}

/** BR-AI-19 stand-in: digits masked, a marker in front (the raw text differs from the result). */
export function redacted(text: string): RedactedText {
  return `[r]${text.replace(/[0-9]/g, '*')}` as RedactedText;
}

export class FakeRedactor {
  readonly calls: { appId: string; text: string }[] = [];
  fail = false;
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  redact(appId: string, text: string): Promise<RedactedText> {
    this.calls.push({ appId, text });
    this.log.push('redact');
    if (this.fail) return Promise.reject(new Error('redaction rules unavailable'));
    return Promise.resolve(redacted(text));
  }
}

export class FakeLabels {
  readonly calls: string[] = [];
  fail = false;
  current(): Promise<{ promptVersion: string; modelSnapshot: string | null }> {
    this.calls.push('current');
    if (this.fail) return Promise.reject(new Error('prompt registry unavailable'));
    return Promise.resolve({
      promptVersion: LABELS.promptVersion,
      modelSnapshot: LABELS.modelSnapshot,
    });
  }
  modelLabel(_appId: string, snapshot: string | null): Promise<string> {
    this.calls.push(`modelLabel:${snapshot ?? 'null'}`);
    return Promise.resolve(modelLabelOf(snapshot));
  }
  aiLabel(): Promise<string> {
    this.calls.push('aiLabel');
    return Promise.resolve(LABELS.aiLabel);
  }
}

export class FakeCancel {
  readonly calls: CancelQuery[] = [];
  answer: 'accepted' | 'not_running' = 'accepted';
  fail = false;
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  cancel(query: CancelQuery): Promise<'accepted' | 'not_running'> {
    this.calls.push(structuredClone(query));
    this.log.push('cancel');
    if (this.fail) return Promise.reject(new Error('could not serialize access'));
    return Promise.resolve(this.answer);
  }
}

/** Redis cancel signal: ok, rejects, throws synchronously or never settles. */
export class FakeSignals {
  readonly calls: [string, string][] = [];
  mode: 'ok' | 'reject' | 'throw' | 'hang' = 'ok';
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  requestCancel(runId: string, ownerKey: string): Promise<'ok' | 'not_found'> {
    this.calls.push([runId, ownerKey]);
    this.log.push('signal');
    switch (this.mode) {
      case 'ok':
        return Promise.resolve('ok');
      case 'reject':
        return Promise.reject(new Error('redis: connection reset'));
      case 'throw':
        throw new Error('redis: client closed');
      case 'hang':
        return new Promise<'ok'>(() => undefined);
    }
  }
}

// ---- reply -----------------------------------------------------------------------------------

export interface JsonCall {
  status: number;
  headers: Record<string, string>;
  body: Row;
}

/** Records JSON answers and the SSE stream; close() is the client going away. */
export class FakeReply implements AgentHttpReply {
  readonly jsons: JsonCall[] = [];
  readonly streams: Record<string, string>[] = [];
  readonly chunks: string[] = [];
  /** Write calls made after the client was gone (each one threw). */
  writesAfterClose = 0;
  ended = 0;
  closed = false;
  /** Close as soon as the stream is opened (before any write). */
  closeOnOpen = false;
  /** Close right after this many successful writes. */
  closeAfterWrites: number | null = null;
  readonly #listeners: (() => void)[] = [];
  readonly log: string[];
  constructor(log: string[] = []) {
    this.log = log;
  }
  json(status: number, headers: Readonly<Record<string, string>>, body: unknown): void {
    this.log.push('reply.json');
    this.jsons.push(structuredClone({ status, headers: { ...headers }, body: body as Row }));
  }
  stream(headers: Readonly<Record<string, string>>): AgentStreamSink {
    this.log.push('reply.stream');
    this.streams.push({ ...headers });
    if (this.closeOnOpen) this.closed = true;
    return {
      write: (chunk: string) => {
        if (this.closed) {
          this.writesAfterClose += 1;
          throw new Error('socket closed');
        }
        this.chunks.push(chunk);
        if (this.closeAfterWrites !== null && this.chunks.length >= this.closeAfterWrites) {
          this.close();
        }
      },
      onClose: (listener: () => void) => {
        this.#listeners.push(listener);
        if (this.closed) queueMicrotask(listener);
      },
      end: () => {
        this.ended += 1;
      },
    };
  }
  /** The client goes away: later writes throw; listeners registered so far are told once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.#listeners) listener();
  }
  /** The single JSON answer (and no stream). */
  single(): JsonCall {
    expect(this.streams, 'no SSE stream for a JSON answer').toEqual([]);
    expect(this.jsons, 'exactly one JSON answer').toHaveLength(1);
    return this.jsons[0]!;
  }
}

/** Case-insensitive header lookup. */
export function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

// ---- the rig ---------------------------------------------------------------------------------

export interface HttpRig {
  time: ManualTime;
  /** Shared order log of the ports. */
  log: string[];
  http: AgentHttp;
  access: Gate<30501>;
  identity: Gate<10001 | 10005>;
  consent: Gate<10004>;
  sessions: FakeSessions;
  admission: ScriptedAdmission;
  limits: FakeLimits;
  redactor: FakeRedactor;
  labels: FakeLabels;
  cancel: FakeCancel;
  signals: FakeSignals;
  /** Every RunStart handed to the RunManager. */
  starts: RunStart[];
  bodyInputs: RunBodyInput[];
  /** Every id deps.ids() handed out, in order. */
  ids: string[];
  /** The run body of the next accepted message. */
  body: RunBody;
}

/** A body that reports a tool, writes text and ends with done stop. */
export const talkingBody: RunBody = (ctx) => {
  ctx.toolStatus('search_products', 'start', '正在查找');
  ctx.text('提现记录在「我的-提现记录」里');
  return Promise.resolve({ kind: 'done', finishReason: 'stop' });
};

export function rig(options: { signals?: boolean } = {}): HttpRig {
  const time = new ManualTime();
  const log: string[] = [];
  const starts: RunStart[] = [];
  const bodyInputs: RunBodyInput[] = [];
  const ids: string[] = [];
  const manager = createRunManager({
    admission: new FakeAdmission([], 5),
    registry: new FakeRegistry([]),
    cards: new FakeCards(),
    texts,
    guard: new FakeGuard(),
    clock: time.clock,
    scheduler: time.scheduler,
    config: runConfigDefaults(),
  });
  const r: HttpRig = {
    time,
    log,
    access: new Gate<30501>('access', log),
    identity: new Gate<10001 | 10005>('identity', log),
    consent: new Gate<10004>('consent', log),
    sessions: new FakeSessions(log),
    admission: new ScriptedAdmission(log),
    limits: new FakeLimits(log),
    redactor: new FakeRedactor(log),
    labels: new FakeLabels(),
    cancel: new FakeCancel(log),
    signals: new FakeSignals(log),
    starts,
    bodyInputs,
    ids,
    body: talkingBody,
    http: undefined as unknown as AgentHttp,
  };
  r.http = createAgentHttp({
    access: r.access,
    identity: r.identity,
    consent: r.consent,
    sessions: r.sessions,
    admission: r.admission,
    runs: {
      start: (start, body) => {
        starts.push(start);
        log.push('runs.start');
        return manager.start(start, body);
      },
    },
    cancel: (query) => r.cancel.cancel(query),
    ...(options.signals === false ? {} : { signals: r.signals }),
    limits: r.limits,
    body: (input) => {
      bodyInputs.push(structuredClone(input));
      return r.body;
    },
    redactor: r.redactor,
    labels: r.labels,
    settings: SETTINGS,
    texts,
    ids: () => {
      const id = newId();
      ids.push(id);
      return id;
    },
    clock: time.clock,
  });
  return r;
}

export function message(text = '提现记录在哪看', clientMsgId?: string): Row {
  return { client_msg_id: clientMsgId ?? `msg-${newId().slice(-12)}`, text };
}

/** Sends and drives the manual time until the handler settles; asserts it settled. */
export async function send(
  r: HttpRig,
  caller: AgentCaller,
  sessionId: string,
  body: unknown,
  reply: FakeReply = new FakeReply(r.log),
): Promise<FakeReply> {
  const done = r.http.sendMessage(caller, sessionId, body, reply);
  const settled = await r.time.drive(done, 300_000);
  expect(settled, 'sendMessage settles').toBe(true);
  await done;
  return reply;
}

// ---- contract --------------------------------------------------------------------------------

export function httpStatusOf(code: number): number {
  const status = liveCode(errorCodes(), code)['http'];
  expect(status, `error-codes.yaml ${code}.http`).toBeTypeOf('number');
  return status as number;
}

export const OPS = {
  create: ['post', '/v1/agent/sessions'],
  current: ['get', '/v1/agent/sessions/current'],
  send: ['post', '/v1/agent/sessions/{id}/messages'],
  cancel: ['post', '/v1/agent/runs/{run_id}/cancel'],
} as const;
export type Op = keyof typeof OPS;

/** The JSON response schema the contract declares for `status` on that operation. */
export async function responseValidator(op: Op, status: number): Promise<(v: unknown) => void> {
  const [method, path] = OPS[op];
  const responses = object(operation(await contract(), method, path)['responses']);
  const key = Object.hasOwn(responses, String(status)) ? String(status) : `${String(status)[0]}XX`;
  expect(responses, `${op} declares a response for ${status}`).toHaveProperty(key);
  const content = object(object(responses[key])['content']);
  expect(content, `${op} ${key} is application/json`).toHaveProperty('application/json');
  const validate = compile(object(object(content['application/json'])['schema']));
  return (value: unknown) => {
    expect(validate(value), JSON.stringify({ value, errors: validate.errors })).toBe(true);
  };
}

/** The operation's x-error-codes. */
export async function errorCodesOf(op: Op): Promise<number[]> {
  const [method, path] = OPS[op];
  return operation(await contract(), method, path)['x-error-codes'] as number[];
}

/**
 * One JSON refusal: status per error-codes.yaml, application/json, the envelope (msg from texts,
 * trace_id of the caller), data exactly as given (absent when undefined), the operation's
 * response schema for that status, and the code listed in its x-error-codes (5xxxx excepted on
 * operations that do not list them: they fall under 5XX).
 */
export async function expectRefusal(
  reply: FakeReply,
  caller: AgentCaller,
  op: Op,
  code: number,
  data?: Row,
): Promise<JsonCall> {
  const call = reply.single();
  expect(call.body['code'], 'error code').toBe(code);
  expect(call.status, `HTTP status of ${code}`).toBe(httpStatusOf(code));
  expect(header(call.headers, 'content-type') ?? '').toMatch(/^application\/json/);
  expect(call.body['msg']).toBe(texts.errorMsg(code));
  expect(call.body['trace_id']).toBe(caller.traceId);
  if (data === undefined) expect(call.body).not.toHaveProperty('data');
  else expect(call.body['data']).toEqual(data);
  (await responseValidator(op, call.status))(call.body);
  if (code < 50000) expect(await errorCodesOf(op)).toContain(code);
  return call;
}

/** One 200 JSON answer, checked against the operation's 200 schema; returns data. */
export async function expectOk(reply: FakeReply, caller: AgentCaller, op: Op): Promise<Row> {
  const call = reply.single();
  expect(call.status).toBe(200);
  expect(header(call.headers, 'content-type') ?? '').toMatch(/^application\/json/);
  expect(call.body['code']).toBe(0);
  expect(call.body['trace_id']).toBe(caller.traceId);
  (await responseValidator(op, 200))(call.body);
  return object(call.body['data']);
}

/** The SSE answer: one stream with the SSE headers and no JSON. */
export function expectStream(reply: FakeReply): void {
  expect(reply.jsons, 'no JSON answer for a stream').toEqual([]);
  expect(reply.streams, 'exactly one stream').toHaveLength(1);
  const headers = reply.streams[0]!;
  expect(header(headers, 'content-type') ?? '').toMatch(/^text\/event-stream/);
  expect(header(headers, 'cache-control')).toBe('no-cache');
}
