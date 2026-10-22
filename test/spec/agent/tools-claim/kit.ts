import { expect, vi } from 'vitest';
import type {
  ClaimEntryLog,
  ClaimEntryReader,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  ToolContext,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { createFrameValidator } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import {
  createPrefillClaimHandler,
  type ClaimDraftDeps,
} from '../../../../apps/api/src/modules/agent/tools/claim/index.ts';
import {
  createToolRegistry,
  type ToolCallContext,
} from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';

export const NOW = '2026-10-23T12:00:00.000Z';
export const ORDER_NO = '990000000001'; // Synthetic order, never resolved against an order store.
export const rejected = { kind: 'rejected', modelView: { error: 'invalid_args' } };

export function context(patch: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
    phoneBound: true,
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {},
    ...patch,
  };
}

export function registryContext(ctx: ToolCallContext): ToolContext {
  return {
    subject: {
      appId: ctx.appId,
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      phoneBound: ctx.phoneBound,
      deviceHash: 'synthetic-device-hash',
      ipKey: 'synthetic-ip-key',
      traceId: 'synthetic-trace',
    },
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    placeholders: ctx.placeholders,
  };
}

export function fixture(patch: Partial<ClaimDraftDeps> = {}) {
  const clock = new FixedClock(NOW);
  const read = vi.fn<ClaimEntryReader['read']>(async () => ({ logs: [], bindings: [] }));
  const config = vi.fn<ClaimDraftDeps['config']>(async () => undefined);
  const deps: ClaimDraftDeps = {
    clicks: { read },
    clock,
    config,
    platforms: ['taobao', 'jd', 'pdd'],
    ...patch,
  };
  return { deps, read, config, clock };
}

export function setup(patch: Partial<ClaimDraftDeps> = {}) {
  const f = fixture(patch);
  // Every registry test reaches this factory outside any expected-error assertion/catch.
  const handler = createPrefillClaimHandler(f.deps);
  const run = vi.spyOn(handler, 'run');
  const warn = vi.fn();
  const registry = createToolRegistry({
    handlers: [handler],
    switches: { get: async () => true },
    logger: { warn },
  });
  return {
    ...f,
    handler,
    run,
    warn,
    registry,
    execute(args: unknown = { platform: 'jd', order_no: ORDER_NO }, ctx = context()) {
      return registry.execute(
        { id: 'synthetic-call', name: 'prefill_claim', args },
        registryContext(ctx),
      );
    },
  };
}

export function log(at: string, patch: Partial<ClaimEntryLog> = {}): ClaimEntryLog {
  return {
    id: 1n,
    app_id: 'synthetic-app',
    user_id: 'synthetic-user',
    opener_user_id: null,
    platform: 'jd',
    event: 'open',
    result_code: 0,
    pid_scene: 'synthetic-scene',
    no_rebate: false,
    no_rebate_reason: null,
    created_at: new Date(at),
    ...patch,
  };
}

export function expectCard(card: UnnumberedCard): Readonly<Record<string, unknown>> {
  expect(card).toMatchObject({ type: 'claim_draft', schema_version: 1 });
  expect(card).not.toHaveProperty('card_id');
  expect(card.data).not.toHaveProperty('paid_date');
  expect(
    createFrameValidator()({
      event: 'card',
      id: 1,
      data: { ...card, seq: 1, card_id: 'c1' },
    }),
  ).toEqual({ ok: true });
  return card.data;
}

export function draftOf(outcome: ToolOutcome): Readonly<Record<string, unknown>> {
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') return {};
  expect(outcome.cards).toHaveLength(1);
  const card = outcome.cards[0];
  expect(card).toBeDefined();
  return card === undefined ? {} : expectCard(card);
}
