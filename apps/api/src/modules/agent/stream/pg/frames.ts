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
import type { FinishReason } from '../writer/index.ts';

const FINISH_REASONS: readonly FinishReason[] = [
  'stop',
  'cancelled',
  'limit',
  'budget',
  'error',
  'auth_required',
  'safety',
  'fallback',
  'timeout',
];

export interface StoredFrame {
  readonly type: 'done' | 'error';
  readonly data: Readonly<Record<string, unknown>>;
}

export class StoredFrameInvalid extends Error {}

export function toStored(frame: TerminalFrame | TerminalDraft): StoredFrame {
  return { type: frame.event, data: { ...frame.data } };
}

export function fromStored(value: unknown, kind: 'final'): TerminalFrame;
export function fromStored(value: unknown, kind: 'draft'): TerminalDraft;
export function fromStored(value: unknown, kind: 'final' | 'draft'): TerminalFrame | TerminalDraft;
export function fromStored(value: unknown, kind: 'final' | 'draft'): TerminalFrame | TerminalDraft {
  if (
    !object(value) ||
    Object.keys(value).length !== 2 ||
    !('type' in value) ||
    !('data' in value) ||
    !object(value['data'])
  ) {
    throw new StoredFrameInvalid('Invalid stored envelope');
  }
  const event = value['type'];
  const data = { ...value['data'] };
  if (event !== 'done' && event !== 'error') throw new StoredFrameInvalid('Invalid event');
  if (event === 'done') {
    if (
      !FINISH_REASONS.includes(data['finish_reason'] as FinishReason) ||
      Object.keys(data).some((key) => !['finish_reason', 'quota_left'].includes(key)) ||
      (kind === 'draft'
        ? 'quota_left' in data
        : typeof data['quota_left'] !== 'number' ||
          !Number.isSafeInteger(data['quota_left']) ||
          data['quota_left'] < 0)
    ) {
      throw new StoredFrameInvalid('Invalid stored done data');
    }
  } else if (
    !Number.isSafeInteger(data['code']) ||
    typeof data['msg'] !== 'string' ||
    typeof data['retryable'] !== 'boolean' ||
    !nullableText(data['fallback']) ||
    ('fallback_q' in data && !nullableText(data['fallback_q'])) ||
    Object.keys(data).some(
      (key) => !['code', 'msg', 'retryable', 'fallback', 'fallback_q'].includes(key),
    )
  ) {
    throw new StoredFrameInvalid('Invalid stored error data');
  }
  return { event, data } as TerminalFrame | TerminalDraft;
}

export function withQuota(draft: TerminalDraft, quotaLeft: number): TerminalFrame {
  return draft.event === 'done'
    ? { event: 'done', data: { ...draft.data, quota_left: quotaLeft } }
    : draft;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nullableText(value: unknown): boolean {
  return value === null || typeof value === 'string';
}
