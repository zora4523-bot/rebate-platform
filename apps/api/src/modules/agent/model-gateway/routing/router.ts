import { createGovernor, GovernanceError } from '../../../platform/index.ts';
import type { Governor } from '../../../platform/index.ts';
import { assertOnlineVendor, VendorError } from '../vendors/index.ts';
import {
  assembleChunks,
  buildModelRequest,
  ModelProtocolError,
  quirksFor,
  toVendorRequest,
} from '../openai-compat/index.ts';
import type { ModelErrorKind } from '../openai-compat/index.ts';
import type { DegradeReason } from '../degraded/index.ts';
import { RunDeadlineError, withinRun } from './attempt.ts';
import type {
  AttemptRecord,
  ModelOutcome,
  ModelRouter,
  ModelRouterOptions,
  RouteEntry,
  RouterChatInput,
} from './types.ts';

function failureKind(error: unknown): ModelErrorKind | 'circuit_open' {
  if (error instanceof ModelProtocolError) return error.kind;
  if (error instanceof GovernanceError) {
    if (error.code === 'timeout' || error.code === 'circuit_open') return error.code;
    return 'bad_request';
  }
  if (error instanceof VendorError) return error.code === 'aborted' ? 'aborted' : 'bad_request';
  return 'network';
}

/** 网关只为正常返回计量；只在 invoke 拒绝的边界补记错误中的有效用量。 */
async function invoke(
  options: ModelRouterOptions,
  entry: RouteEntry,
  input: RouterChatInput,
  signal: AbortSignal,
) {
  const vendor = assertOnlineVendor(entry.vendor);
  const request = toVendorRequest(
    buildModelRequest({ ...input, vendor, model: entry.model }, quirksFor(vendor)),
  );
  const response = await options.gateway
    .invoke({ ...request, vendor, purpose: 'online', dataClass: 'user_input' }, signal)
    .catch((error: unknown) => {
      if (error instanceof ModelProtocolError && error.usage !== null) {
        options.meter.record({
          vendor,
          purpose: 'online',
          use: null,
          model: entry.model,
          ...error.usage,
          recorded_at: options.clock.now(),
        });
      }
      throw error;
    });
  // 组装失败或内容拒绝时，response 已由网关计量，不得在此重复计量。
  const events = assembleChunks(response.chunks);
  if (events.some((event) => event.t === 'done' && event.reason === 'content_filter')) {
    throw new ModelProtocolError('content_refused', 'Model declined content');
  }
  return { events, usage: response.usage };
}

export function createModelRouter(inputOptions: ModelRouterOptions): ModelRouter {
  const options = {
    ...inputOptions,
    config: {
      ...inputOptions.config,
      breaker: { ...inputOptions.config.breaker },
    },
  };
  const policy = {
    timeoutMs: options.config.attemptTimeoutMs,
    retries: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    breaker: options.config.breaker,
  };
  // 立即校验配置；每条目仍有独立、持久的 Governor，不按每次调用重建。
  createGovernor('model.routing', policy, { scheduler: options.scheduler });
  const governors = new Map<string, Governor>();
  const governorFor = (id: string): Governor => {
    let governor = governors.get(id);
    if (governor === undefined) {
      governor = createGovernor(`model.${id}`, policy, { scheduler: options.scheduler });
      governors.set(id, governor);
    }
    return governor;
  };
  return {
    breakerState: (id) => governors.get(id)?.breakerState() ?? 'closed',
    async complete(input, ctx): Promise<ModelOutcome> {
      const attempts: AttemptRecord[] = [];
      const degrade = (reason: DegradeReason): ModelOutcome => ({
        kind: 'degraded',
        reason,
        attempts,
      });
      if (ctx.signal.aborted) return { kind: 'aborted', attempts };
      if (options.budgetExhausted()) return degrade('budget');
      // 后台切换仅影响下一次 complete；当前调用使用独立快照。
      const route = structuredClone(options.route());
      for (const drop of route.dropped) {
        options.onAlert?.({ kind: 'route_dropped', entryId: drop.id });
      }
      if (route.mode === 'no_model') return degrade('route_no_model');
      if (route.attempts.length === 0) return degrade('route_unavailable');
      for (const entry of route.attempts) {
        if (ctx.signal.aborted) return { kind: 'aborted', attempts };
        const remaining = ctx.clock.remainingMs();
        if (!(remaining > 0) || !Number.isFinite(remaining)) return degrade('model_timeout');
        const governor = governorFor(entry.id);
        if (governor.breakerState() === 'open') {
          attempts.push({ entryId: entry.id, result: 'circuit_open', elapsedMs: 0 });
          continue;
        }
        const started = options.scheduler.now();
        let result;
        let failure: ModelErrorKind | 'circuit_open' | undefined;
        try {
          result = await governor.call(
            (signal) =>
              withinRun(
                (upstream) => invoke(options, entry, input, upstream),
                signal,
                ctx.signal,
                options.scheduler,
                remaining < policy.timeoutMs ? remaining : Infinity,
              ),
            {
              kind: 'write',
              classify(error) {
                if (error instanceof RunDeadlineError) return 'rejected';
                const kind = failureKind(error);
                return kind === 'aborted' ||
                  kind === 'content_refused' ||
                  kind === 'auth' ||
                  kind === 'bad_request' ||
                  kind === 'model_not_pinned'
                  ? 'rejected'
                  : 'failure';
              },
            },
          );
        } catch (error) {
          failure = ctx.signal.aborted ? 'aborted' : failureKind(error);
        } finally {
          const elapsedMs = Math.max(0, options.scheduler.now() - started);
          ctx.clock.charge(elapsedMs);
          attempts.push({ entryId: entry.id, result: failure ?? 'ok', elapsedMs });
        }
        if (ctx.signal.aborted || failure === 'aborted') return { kind: 'aborted', attempts };
        if (failure === 'content_refused') return { kind: 'refused', entryId: entry.id, attempts };
        if (failure === 'auth' || failure === 'bad_request' || failure === 'model_not_pinned') {
          options.onAlert?.({
            kind: failure === 'auth' ? 'auth' : 'bad_request',
            entryId: entry.id,
          });
          return degrade('vendor_misconfigured');
        }
        if (ctx.clock.remainingMs() <= 0) return degrade('model_timeout');
        if (result !== undefined) {
          return { kind: 'model', entryId: entry.id, model: entry.model, ...result, attempts };
        }
      }
      return degrade('models_failed');
    },
  };
}
