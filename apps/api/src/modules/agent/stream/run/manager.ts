import { createFrameValidator, StreamProtocolError, StreamWriter } from '../writer/index.ts';
import type { ErrorData, FinishReason, StreamEvent, StreamEventInput } from '../writer/index.ts';
import type { RunEnding } from '../admission/index.ts';
import { numberCard } from './cards.ts';
import type {
  AbortReason,
  RunBody,
  RunBodyResult,
  RunContext,
  RunFinal,
  RunManager,
  RunManagerDeps,
  RunStart,
  TerminalFrame,
} from './index.ts';

type End = { ending: RunEnding } & (
  { event: 'done'; finishReason: FinishReason } | { event: 'error'; error: ErrorData }
);

export function createRunManager(deps: RunManagerDeps): RunManager {
  for (const [name, ms] of Object.entries(deps.config)) {
    if (!Number.isSafeInteger(ms) || ms < (name === 'disconnectGraceMs' ? 0 : 1)) {
      throw new RangeError(`Invalid run duration: ${name}`);
    }
  }
  if (deps.config.guardPollMs > 10_000) {
    throw new RangeError('Run guard polling must respect the revocation deadline');
  }
  const validator = deps.validator ?? createFrameValidator();
  return {
    start: (start, body) => run(deps, validator, start, body),
    cancel: (runId, ownerKey) => deps.registry.requestCancel(runId, ownerKey),
  };
}

async function run(
  deps: RunManagerDeps,
  validator: ReturnType<typeof createFrameValidator>,
  start: RunStart,
  body: RunBody,
): Promise<RunFinal> {
  const { ticket, sink } = start;
  const { runId, sessionId } = ticket;
  const { config, registry, scheduler } = deps;
  const writer = new StreamWriter({ sink, validator });
  const bodyAbort = new AbortController();
  const waits = new AbortController();
  const deadline = ticket.acceptedAtMs + config.maxRunMs;
  let stopped = false;
  let connected = true;
  let cardsDelivered = 0;
  let cardQueue = Promise.resolve();
  let factsQueue = Promise.resolve();
  let resolveEnd!: (end: End) => void;
  const ended = new Promise<End>((resolve) => {
    resolveEnd = resolve;
  });

  const errorEnd = (code: number, ending: RunEnding, retryable: boolean): End => ({
    ending,
    event: 'error',
    error: { code, msg: deps.texts.errorMsg(code), retryable, fallback: null },
  });

  // All contenders enter here synchronously, before any persistence or abort callbacks.
  // Normal completion stops context writes too, but does not abort the body's signal.
  function choose(end: End, reason?: AbortReason): void {
    if (stopped) return;
    stopped = true;
    waits.abort();
    if (reason !== undefined) bodyAbort.abort(reason);
    resolveEnd(end);
  }

  function interrupt(reason: AbortReason): void {
    if (stopped) return;
    if (reason === 'disabled' || reason === 'consent_withdrawn') {
      choose(errorEnd(reason === 'disabled' ? 30501 : 10004, reason, false), reason);
      return;
    }
    choose(
      {
        ending: reason,
        event: 'done',
        finishReason: reason === 'timeout' ? 'timeout' : 'cancelled',
      },
      reason,
    );
    if (reason === 'timeout') write('text.delta', { delta: deps.texts.text('agent.timeout') });
  }

  function background(work: () => Promise<void>): void {
    void work().catch(() => {
      if (!stopped) choose(errorEnd(50001, 'server_error', true));
    });
  }

  function disconnected(): void {
    if (!connected) return;
    connected = false;
    if (stopped) return;
    background(async () => {
      await scheduler.sleep(config.disconnectGraceMs, waits.signal);
      if (!stopped) interrupt('disconnected');
    });
  }

  function write<E extends StreamEvent>(event: E, data: StreamEventInput[E]): boolean {
    if (!connected || writer.closed) return false;
    try {
      writer.emit(event, data);
      return true;
    } catch (error) {
      // Protocol errors leave the writer open; socket failures close it, even when a sink
      // happens to throw a StreamProtocolError. Uncertain delivery must never be retried.
      if (!writer.closed) throw error;
      disconnected();
      return false;
    }
  }

  function live(): boolean {
    if (!stopped && deps.clock.now().getTime() >= deadline) interrupt('timeout');
    return !stopped;
  }

  const ctx: RunContext = {
    runId,
    sessionId,
    signal: bodyAbort.signal,
    get cardsDelivered() {
      return cardsDelivered;
    },
    text(delta): void {
      if (live()) write('text.delta', { delta });
    },
    toolStatus(tool, phase, displayText): void {
      if (live()) write('tool.status', { tool, phase, display_text: displayText });
    },
    suggestions(items): void {
      if (live()) write('suggestions', { items });
    },
    async card(input): Promise<void> {
      if (!live() || !connected) return;
      // Detach before awaiting a reservation. Serialize reservations and delivery so card ids
      // remain in delivery order even when the body calls card() concurrently.
      const snapshot = numberCard(input, 1);
      const pending = cardQueue.then(async () => {
        if (!live() || !connected) return;
        const first = await deps.cards.reserve(sessionId, snapshot.used);
        if (!live() || !connected) return;
        const numbered = numberCard(snapshot.card, first);
        if (!write('card', numbered.card)) return;
        cardsDelivered += 1;
        const facts = { ending: null, cardsDelivered };
        factsQueue = factsQueue.then(() => registry.recordFacts(runId, facts));
        await factsQueue;
      });
      // Rejected invalid cards do not poison subsequent calls. The caller still sees rejection.
      cardQueue = pending.catch(() => undefined);
      await pending;
    },
  };

  function bodyEnded(result: RunBodyResult): void {
    if (!live()) return;
    if (result.kind === 'error') {
      // Preserve a valid error verbatim, but never persist a malformed final frame.
      const error = structuredClone(result.error);
      if (!validator({ event: 'error', id: writer.seq + 1, data: error }).ok) {
        throw new StreamProtocolError('invalid_frame', 'Invalid body terminal');
      }
      choose({
        ending: error.code >= 50_000 && error.code < 60_000 ? 'server_error' : 'client_error',
        event: 'error',
        error,
      });
    } else {
      choose({
        ending:
          result.ending ?? (result.finishReason === 'error' ? 'server_error' : result.finishReason),
        event: 'done',
        finishReason: result.finishReason,
      });
    }
  }

  async function poll(ms: number, check: () => Promise<void>): Promise<void> {
    let due = scheduler.now() + ms;
    while (!stopped) {
      await scheduler.sleep(Math.max(0, due - scheduler.now()), waits.signal);
      if (stopped) return;
      // A failed read is retried on the next poll; it does not become a user cancellation.
      try {
        await check();
      } catch {
        // The acceptance deadline continues independently of this dependency.
      }
      // Read latency consumes this interval, rather than extending every polling period.
      due = Math.max(due + ms, scheduler.now());
    }
  }

  sink.onClose(disconnected);
  try {
    await registry.register({ runId, sessionId, ownerKey: start.ownerKey });
    const metaWritten = write('meta', { ...start.meta, session_id: sessionId, run_id: runId });
    if (!metaWritten) {
      interrupt('disconnected');
    } else if (live()) {
      background(async () => {
        await scheduler.sleep(Math.max(0, deadline - deps.clock.now().getTime()), waits.signal);
        interrupt('timeout');
      });
      background(async () => {
        // A fixed cadence bounds every gap between writes, including while frames are flowing.
        while (!stopped) {
          await scheduler.sleep(config.heartbeatMs, waits.signal);
          if (stopped || !connected) return;
          try {
            writer.ping();
          } catch (error) {
            if (!writer.closed) throw error;
            disconnected();
            return;
          }
        }
      });
      background(() =>
        poll(config.signalPollMs, async () => {
          if (await registry.cancelRequested(runId)) interrupt('cancelled');
        }),
      );
      background(() =>
        poll(config.guardPollMs, async () => {
          const answer = await deps.guard.check();
          if (answer !== null) interrupt(answer.code === 30501 ? 'disabled' : 'consent_withdrawn');
        }),
      );
      // A body ignoring its signal never blocks the tail. Both fulfillment and rejection of
      // a late body are observed, with choose() preventing any second ending.
      background(async () => bodyEnded(await body(ctx)));
    }

    const end = await ended;
    // Wait only for facts from writes that actually succeeded, never for an outstanding card
    // reservation or body. A late live fact cannot overwrite the final ending.
    await factsQueue;
    const outcome = { ending: end.ending, cardsDelivered };
    await registry.recordFacts(runId, outcome);
    const settled = await deps.admission.settle(ticket, outcome, start.limits);
    const terminal: TerminalFrame =
      end.event === 'done'
        ? {
            event: 'done',
            data: { finish_reason: end.finishReason, quota_left: settled.quotaLeft },
          }
        : { event: 'error', data: end.error };
    await registry.finish(runId, terminal);
    if (terminal.event === 'done') write('done', terminal.data);
    else write('error', terminal.data);
    return { terminal, ...outcome };
  } finally {
    stopped = true;
    waits.abort();
  }
}
