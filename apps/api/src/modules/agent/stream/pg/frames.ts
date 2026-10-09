// The two forms of a terminal frame (B3-03g design §3.4). In memory: {event, data}
// (run/types.ts TerminalFrame / TerminalDraft). Persisted (agent_runs.final_event, end_draft;
// 0021 / 0023 CHECKs): {type, data}, exactly these two top-level keys, type 'done' | 'error',
// data an object. Conversion happens only here.
//
// toStored(frame): {type: frame.event, data: frame.data} (data copied, nothing added or dropped).
// fromStored(value, kind): the inverse; throws StoredFrameInvalid when `value` is not an object of
//   exactly {type, data}, type is not 'done' | 'error', data is not an object, a done frame's
//   finish_reason is not a FinishReason (writer/index.ts), or (kind 'final') a
//   done frame lacks a non-negative integer quota_left / (kind 'draft') a done draft carries one,
//   or the error data is not {code, msg, retryable, fallback[, fallback_q]}.
//   fromStored(toStored(f), kind) deep-equals f for every valid frame of that kind.
// withQuota(draft, quotaLeft): a done draft gets data.quota_left = quotaLeft; an error draft is
//   returned as it is (error frames carry no quota_left).
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { TerminalDraft, TerminalFrame } from '../run/types.ts';

export interface StoredFrame {
  readonly type: 'done' | 'error';
  readonly data: Readonly<Record<string, unknown>>;
}

export class StoredFrameInvalid extends Error {}

export function toStored(frame: TerminalFrame | TerminalDraft): StoredFrame {
  void frame;
  throw new Error('NotImplemented: toStored');
}

export function fromStored(value: unknown, kind: 'final' | 'draft'): TerminalFrame | TerminalDraft {
  void value;
  void kind;
  throw new Error('NotImplemented: fromStored');
}

export function withQuota(draft: TerminalDraft, quotaLeft: number): TerminalFrame {
  void draft;
  void quotaLeft;
  throw new Error('NotImplemented: withQuota');
}
