// A business refusal a post-miss check wants stored like a handler result (orchestrator ruling
// B1-02za E21; BR-WDR-07 / 04 §5: results with code 0 or 30000–39999 are stored). A stage judged
// in the post-miss phase whose code is a 3xxxx (today BR-ID-01 ⑨ 30304) must answer a retry of
// the same key with the same result, and it sits before stages that may not run first (⑫ step-up),
// so it cannot wait for the handler. The check throws StoredRejection; ./index.ts catches it after
// the miss and, in both execute modes, writes the key `completed` with this response exactly as it
// does for a handler's stored result (the handler and later checks do not run) and returns it.
// Only 30000–39999 are accepted here: a 1xxxx refusal (e.g. ⑧ 10005, ⑤ 10006) stays an ordinary
// throw that rolls back and stores nothing, so the same key may be retried after the user acts.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
// The two shapes below match HandlerResult / ResponseEnvelope in ./index.ts structurally; they are
// declared here rather than imported because ./index.ts imports this file (no-circular).
interface ResponseEnvelope {
  readonly code: number;
  readonly msg: string;
  readonly data?: unknown;
  readonly trace_id: string;
}

interface HandlerResult {
  readonly status: number;
  readonly envelope: ResponseEnvelope;
}

/** Thrown by a post-miss check: stored and replayed like a handler's result (code 30000–39999). */
export class StoredRejection extends Error {
  readonly result: HandlerResult;

  constructor(status: number, envelope: ResponseEnvelope) {
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      !Number.isInteger(envelope.code) ||
      envelope.code < 30000 ||
      envelope.code > 39999
    ) {
      throw new TypeError('StoredRejection takes only codes 30000–39999');
    }
    super(envelope.msg);
    this.name = 'StoredRejection';
    this.result = { status, envelope };
  }
}
