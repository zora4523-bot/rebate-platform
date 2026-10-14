// Admission gate fixture on PostgreSQL (B3-03g replaces the B3-03c Redis fixture; design §7.3).
// Two service instances (`a`, `b`: two createPgRunPorts over one database) share one FixedClock
// and one in-memory limits source. `settle` runs the live tail the way RunManager does it (S4′
// with the draft, then admission.settle) after setting the limits source to the limits the old
// test passed: the PG settle reads the current limits there, not its argument. Stored values are
// compared as a snapshot of agent_sessions, agent_runs and agent_messages.
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  AdmissionLimits,
  AdmissionRequest,
  AdmissionResult,
  AdmissionTicket,
  QuotaSubject,
  RunOutcome,
  SettleResult,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { RunTimings } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  MutableLimits,
  START,
  TIMINGS,
  draftOf,
  instance,
  newSession,
  request,
  snapshot,
  type Inst,
  type Pg,
} from '../stream-finalize/kit.ts';

export {
  accepted,
  guest,
  limits,
  member,
  opaque,
  usePg,
  START_MS,
} from '../stream-finalize/kit.ts';
export { START };

export interface Side {
  readonly inst: Inst;
  admit(req: AdmissionRequest, limits: AdmissionLimits): Promise<AdmissionResult>;
  settle(
    ticket: AdmissionTicket,
    outcome: RunOutcome,
    limits: AdmissionLimits,
  ): Promise<SettleResult>;
}

export interface Gate {
  clock: FixedClock;
  a: Side;
  b: Side;
  /** A new session (started 1 s before the current clock). */
  session(): Promise<string>;
  /** A request; a new session when none is given. */
  req(subject: QuotaSubject, sessionId?: string, clientMsgId?: string): Promise<AdmissionRequest>;
  /** The three admission tables as text: equal = nothing was written. */
  values(): Promise<string>;
}

export async function withGate(
  pg: Pg,
  run: (gate: Gate) => Promise<void>,
  timings: RunTimings = TIMINGS,
): Promise<void> {
  const clock = new FixedClock(START);
  const source = new MutableLimits();
  const side = (): Side => {
    const inst = instance(pg.db, { clock, limits: source, timings });
    return {
      inst,
      admit: (req, quota) => {
        source.value = { ...quota };
        return inst.ports.admission.admit(req, quota);
      },
      settle: async (ticket, outcome, quota) => {
        source.value = { ...quota };
        await inst.ports.registry.recordFacts(ticket.runId, outcome, draftOf(outcome.ending));
        return inst.ports.admission.settle(ticket, outcome, quota);
      },
    };
  };
  const a = side();
  const b = side();
  await run({
    clock,
    a,
    b,
    session: () => newSession(pg.db, clock.now()),
    req: async (subject, sessionId, clientMsgId) =>
      request(subject, sessionId ?? (await newSession(pg.db, clock.now())), clientMsgId),
    values: () => snapshot(pg.db),
  });
}

/** Expected ticket of `req`: built anew (no reference shared with what the gate got). */
export function ticketOf(
  req: AdmissionRequest,
  dayKey: string,
  acceptedAtMs: number,
  lockExpiresAtMs: number,
): AdmissionTicket {
  return {
    runId: req.runId,
    messageId: req.messageId,
    sessionId: req.sessionId,
    subject: structuredClone(req.subject),
    dayKey,
    acceptedAtMs,
    lockExpiresAtMs,
  };
}

/** The 04 §8.1 original of a duplicate, from the request that was accepted. */
export function originalOf(req: AdmissionRequest) {
  return {
    runId: req.runId,
    userMessageId: req.messageId,
    assistantMessageId: req.reply.assistantMessageId,
    promptVersion: req.reply.promptVersion,
    modelSnapshot: req.reply.modelSnapshot,
  };
}
