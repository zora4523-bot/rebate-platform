// StreamWriter: the SSE side of the Agent stream (B3-03a; 规划/04 §8.1–8.2, 02 §9 StreamWriter).
// Frame shapes are contracts/agent-stream.schema.json (CT-08a/b); the rule tests in
// test/spec/agent/stream-writer/** import this file by path, so the names, signatures and the
// semantics written here are the contract.
//
// encodeFrame(frame) → string
//   One SSE frame, exactly three lines in this order and a blank line:
//   `event: <event>\nid: <id>\ndata: <JSON of data>\n\n`. The data line is one line: the JSON
//   text never contains a raw CR or LF (JSON.stringify escapes them); nothing else is written.
//
// encodePing() → string
//   The heartbeat comment `: ping\n\n` (04 §8.1). It is not a frame: no id, no event.
//
// createFrameValidator(schema?) → FrameValidator
//   Validates one frame {event, id, data} against contracts/agent-stream.schema.json (the root
//   schema; `schema` replaces it, used by tests). Ajv2020 strict, ajv-formats, with `int32` and
//   `int64` as integers in their ranges (the same formats as platform/validation). Returns
//   { ok: true } or { ok: false, errors } with at least one message.
//
// new StreamWriter({ sink, validator? }) — one writer per run; `validator` defaults to
// createFrameValidator().
//   emit(event, data) assigns the next seq and writes one frame:
//   - seq starts at 1 and increases by exactly 1 per frame written; the frame id is the seq.
//     text.delta, tool.status and card carry the same number as data.seq (the writer sets it;
//     callers pass data without seq); meta, suggestions, error and done carry no seq.
//   - the first frame must be meta and meta is written once; otherwise StreamProtocolError
//     'meta_order'.
//   - every frame is checked by the validator before anything is written; a refused frame throws
//     StreamProtocolError 'invalid_frame', writes nothing, consumes no seq and leaves the stream
//     open (the caller may still end it with error or done).
//   - done and error are terminal: exactly one per run. After it, emit() and ping() throw
//     StreamProtocolError 'stream_closed' and write nothing.
//   - each frame (and each ping) is written with a single sink.write call holding the whole
//     block; the caller's data object is not modified. Returns the frame that was written.
//   ping() writes encodePing() without consuming a seq; scheduling the 15-second heartbeat, cancel,
//   disconnect and time limits belong to RunManager (B3-03b), the HTTP wiring to B3-03d.
//
// Rules for the implementation: this file is also compiled by the `test` project: erasable syntax
// only, `import type` for type-only imports, relative imports with `.ts`, no NestJS import, no
// `process.env`, no clock. Allowed packages: ajv, ajv-formats (already dependencies of @couli/api).

export type StreamEvent =
  'meta' | 'text.delta' | 'tool.status' | 'card' | 'suggestions' | 'error' | 'done';

export type FinishReason =
  | 'stop'
  | 'cancelled'
  | 'limit'
  | 'budget'
  | 'error'
  | 'auth_required'
  | 'safety'
  | 'fallback'
  | 'timeout';

export interface MetaData {
  readonly session_id: string;
  readonly run_id: string;
  readonly message_id: string;
  readonly prompt_version: string;
  readonly model_label: string;
  readonly ai_label: string;
}

export interface TextDeltaInput {
  readonly delta: string;
}

export interface ToolStatusInput {
  readonly tool: string;
  readonly phase: 'start' | 'end' | 'failed';
  readonly display_text: string;
}

export interface CardInput {
  readonly card_id: string;
  readonly type: string;
  readonly schema_version: number;
  readonly data: Readonly<Record<string, unknown>>;
  readonly fallback_text: string;
}

export interface SuggestionsData {
  readonly items: readonly { readonly text: string; readonly send_text: string }[];
}

export interface ErrorData {
  readonly code: number;
  readonly msg: string;
  readonly retryable: boolean;
  readonly fallback: string | null;
}

export interface DoneData {
  readonly finish_reason: FinishReason;
  readonly quota_left: number;
}

/** What the caller passes per event (seq is added by the writer). */
export interface StreamEventInput {
  readonly meta: MetaData;
  readonly 'text.delta': TextDeltaInput;
  readonly 'tool.status': ToolStatusInput;
  readonly card: CardInput;
  readonly suggestions: SuggestionsData;
  readonly error: ErrorData;
  readonly done: DoneData;
}

/** One frame as written: event, id (= seq) and data. */
export interface StreamFrame {
  readonly event: StreamEvent;
  readonly id: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export type FrameCheck =
  { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] };

export type FrameValidator = (frame: unknown) => FrameCheck;

export interface StreamSink {
  write(chunk: string): void;
}

export interface StreamWriterOptions {
  readonly sink: StreamSink;
  readonly validator?: FrameValidator;
}

export type StreamProtocolErrorCode = 'meta_order' | 'invalid_frame' | 'stream_closed';

export class StreamProtocolError extends Error {
  readonly code: StreamProtocolErrorCode;

  constructor(code: StreamProtocolErrorCode, message: string) {
    super('NotImplemented');
    void code;
    void message;
    throw new Error('NotImplemented: StreamProtocolError');
  }
}

export function encodeFrame(frame: StreamFrame): string {
  void frame;
  throw new Error('NotImplemented: encodeFrame');
}

export function encodePing(): string {
  throw new Error('NotImplemented: encodePing');
}

export function createFrameValidator(schema?: object): FrameValidator {
  void schema;
  throw new Error('NotImplemented: createFrameValidator');
}

export class StreamWriter {
  constructor(options: StreamWriterOptions) {
    void options;
    throw new Error('NotImplemented: StreamWriter');
  }

  /** The last seq written; 0 before the first frame. */
  get seq(): number {
    throw new Error('NotImplemented: StreamWriter.seq');
  }

  /** True once done or error has been written. */
  get closed(): boolean {
    throw new Error('NotImplemented: StreamWriter.closed');
  }

  emit<E extends StreamEvent>(event: E, data: StreamEventInput[E]): StreamFrame {
    void event;
    void data;
    throw new Error('NotImplemented: StreamWriter.emit');
  }

  ping(): void {
    throw new Error('NotImplemented: StreamWriter.ping');
  }
}
