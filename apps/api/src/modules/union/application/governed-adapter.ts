// Governance wiring of a union adapter (规划/02 §6.2): every call runs through the
// platform/http Governor with the union policy. Online calls (3 s) and offline calls (order
// sync, pool refresh, reminders: 10 s) use two governors because the time limit is per
// governor; each keeps its own breaker, shared by every method of that class. Idempotent reads
// retry; writes (convert, bindPublisher, createTaolijin) never do — the client replays the
// same idempotency key instead. The quota limiter is shared and takes one token per attempt
// for the call's purpose; its bucket key comes from configuration (CAP-*-12 decide the unit).
// Business refusals from the adapter (UnionError with a business code) are classified
// `rejected`: not retried and not counted by the breaker; only timeouts, upstream throttling,
// network and 5xx failures are.
import {
  createGovernor,
  unionPolicy,
  type CallKind,
  type Governor,
  type QuotaLimiter,
  type Scheduler,
} from '../../platform/index.ts';
import {
  classifyUnionError,
  isServerIdentity,
  UnionError,
  type CallCtx,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionIdentity,
} from '../domain/types.ts';

export interface GovernedAdapterOptions {
  readonly endpoint: UnionEndpoint;
  readonly scheduler: Scheduler;
  /** Must match endpoint.quotaKey. Shared instances allow account-wide quota sharing. */
  readonly quota: QuotaLimiter;
}

/** Wraps every supported operation; optional operations the adapter lacks stay absent. */
export function createGovernedAdapter(
  adapter: UnionAdapter,
  options: GovernedAdapterOptions,
): UnionAdapter {
  const { endpoint, scheduler, quota } = options;
  if (adapter.platform !== endpoint.platform) {
    throw new UnionError(
      'invalid_endpoint',
      `Endpoint for ${endpoint.platform} cannot govern the ${adapter.platform} adapter`,
      adapter.platform,
    );
  }
  if (quota.bucketKey !== endpoint.quotaKey) {
    throw new UnionError(
      'invalid_endpoint',
      `Quota bucket does not match the configured key for ${endpoint.platform}`,
      endpoint.platform,
    );
  }
  const deps = { scheduler, quota };
  const governors = {
    online: createGovernor(`union:${endpoint.platform}:online`, unionPolicy('online'), deps),
    offline: createGovernor(`union:${endpoint.platform}:offline`, unionPolicy('offline'), deps),
  };
  const governorFor = (ctx: CallCtx): Governor =>
    ctx.purpose === 'online' ? governors.online : governors.offline;

  /** A copy of the caller's context; signal, base URL and headers come from configuration. */
  const callCtx = (ctx: CallCtx, signal: AbortSignal): CallCtx => ({
    ...ctx,
    signal,
    baseUrl: endpoint.baseUrl,
    headers:
      endpoint.mode === 'replay' && ctx.scenario !== undefined
        ? { 'X-Scenario': ctx.scenario }
        : {},
  });

  const run = <T>(
    kind: CallKind,
    ctx: CallCtx,
    operation: (governed: CallCtx) => Promise<T>,
  ): Promise<T> =>
    governorFor(ctx).call((signal) => operation(callCtx(ctx, signal)), {
      kind,
      purpose: ctx.purpose,
      classify: classifyUnionError,
    });

  const {
    bindPublisher,
    listRefunds,
    listPunishments,
    materialFeed,
    createTaolijin,
    queryPddAuthority,
  } = adapter;

  /** UnionIdentity is built only by linking on the server (BR-ATTR-05, BR-AI-03). */
  const assertIdentity = (identity: UnionIdentity, ctx: CallCtx, operation: string): void => {
    if (
      !isServerIdentity(identity) ||
      identity.claims.appId !== ctx.appId ||
      identity.claims.platform !== endpoint.platform
    ) {
      throw new UnionError(
        'invalid_identity',
        `${operation} requires a server-side identity of the same app and platform`,
        endpoint.platform,
      );
    }
  };
  const governed: UnionAdapter = {
    platform: adapter.platform,
    searchItems: (q, ctx) => run('idempotent_read', ctx, (c) => adapter.searchItems(q, c)),
    getItem: (ref, ctx) => run('idempotent_read', ctx, (c) => adapter.getItem(ref, c)),
    resolveLink: (raw, ctx) => run('idempotent_read', ctx, (c) => adapter.resolveLink(raw, c)),
    listOrders: (win, opt, ctx) =>
      run('idempotent_read', ctx, (c) => adapter.listOrders(win, opt, c)),
    async convert(req, identity, ctx) {
      assertIdentity(identity, ctx, 'convert');
      return await run('write', ctx, (c) => adapter.convert(req, identity, c));
    },
    ...(bindPublisher === undefined
      ? {}
      : {
          bindPublisher: (req, ctx) =>
            run('write', ctx, (c) => bindPublisher.call(adapter, req, c)),
        }),
    ...(listRefunds === undefined
      ? {}
      : {
          listRefunds: (win, ctx) =>
            run('idempotent_read', ctx, (c) => listRefunds.call(adapter, win, c)),
        }),
    ...(listPunishments === undefined
      ? {}
      : {
          listPunishments: (win, ctx) =>
            run('idempotent_read', ctx, (c) => listPunishments.call(adapter, win, c)),
        }),
    ...(materialFeed === undefined
      ? {}
      : {
          materialFeed: (req, ctx) =>
            run('idempotent_read', ctx, (c) => materialFeed.call(adapter, req, c)),
        }),
    ...(createTaolijin === undefined
      ? {}
      : {
          createTaolijin: (req, ctx) =>
            run('write', ctx, (c) => createTaolijin.call(adapter, req, c)),
        }),
    // B1-06v: the Pinduoduo authority query is an idempotent read of a server-built identity.
    ...(queryPddAuthority === undefined
      ? {}
      : {
          async queryPddAuthority(identity: UnionIdentity, ctx: CallCtx) {
            assertIdentity(identity, ctx, 'queryPddAuthority');
            return await run('idempotent_read', ctx, (c) =>
              queryPddAuthority.call(adapter, identity, c),
            );
          },
        }),
  };
  return Object.freeze(governed);
}
