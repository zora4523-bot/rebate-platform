// B3-06a · BR-AI-03/05/06/18 · SPEC_REF e9fe98ab6e8890ca40923ccd5b6ae5b56dac5aba.
// Test-phase skeleton only. Runtime constants (including IDENTITY_FIELDS) are added by
// the implementer; this phase permits no variable declarations or initialized fields.
export type FilterHit = 'amount' | 'url' | 'tpwd';

export function filterSegment(text: string): {
  readonly text: string;
  readonly hits: readonly FilterHit[];
} {
  void text;
  throw new Error('NotImplemented: filterSegment');
}

export interface SentenceBuffer {
  push(delta: string): string[];
  end(): string[];
}

export function createSentenceBuffer(): SentenceBuffer {
  throw new Error('NotImplemented: createSentenceBuffer');
}

export type ReviewVerdict = 'pass' | 'block' | 'timeout';
export interface SentenceReviewPort {
  review(text: string): Promise<ReviewVerdict>;
}
export type GuardEmit =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'fixed';
      readonly key: 'agent.refuse.output_blocked' | 'agent.refuse.safety_timeout';
    };
export interface GuardSummary {
  readonly outputFiltered: boolean;
  readonly filterHits: readonly FilterHit[];
  readonly outputTruncated: boolean;
  readonly safety: 'none' | 'blocked' | 'timeout_replaced';
}
export interface OutputGuard {
  push(delta: string): Promise<GuardEmit[]>;
  end(): Promise<GuardEmit[]>;
  readonly stopped: boolean;
  summary(): GuardSummary;
}

export function createOutputGuard(deps: { readonly review: SentenceReviewPort }): OutputGuard {
  void deps;
  throw new Error('NotImplemented: createOutputGuard');
}

export function wrapUntrusted(text: string): string {
  void text;
  throw new Error('NotImplemented: wrapUntrusted');
}

export function unwrapUntrusted(wrapped: string): string {
  void wrapped;
  throw new Error('NotImplemented: unwrapUntrusted');
}

export function normalizeIdentityKey(key: string): string {
  void key;
  throw new Error('NotImplemented: normalizeIdentityKey');
}

export function findIdentityFields(args: unknown): string[] {
  void args;
  throw new Error('NotImplemented: findIdentityFields');
}

export type ToolCallDecision =
  | { readonly kind: 'execute' }
  | {
      readonly kind: 'reject';
      readonly result: { readonly error: 'invalid_args' };
      readonly status: 'rejected';
      readonly alert: boolean;
      readonly identityFields: readonly string[];
    };

export function decideToolCall(input: {
  readonly schemaValid: boolean;
  readonly args: unknown;
}): ToolCallDecision {
  void input;
  throw new Error('NotImplemented: decideToolCall');
}
