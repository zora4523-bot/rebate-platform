import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  JobPayload,
  JobQueue,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
  UnionOrder,
} from '../../../../apps/api/src/modules/union/index.ts';
import type { OrderRescanSchedulerDeps } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import type { OrderPipelinePort } from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import type {
  OrderRescanWindow,
  RescanCursorStore,
  RescanStream,
  SyncAccessPort,
  SyncAccount,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import { RESCAN_START_MARGIN_MS } from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import type { OrderRescanHandlerDeps } from '../../../../apps/api/src/modules/orders/jobs/order-rescan.ts';

export const NOW = '2026-10-17T02:00:00.000Z';
export const NOW_MS = Date.parse(NOW);
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const JD_CAP_MS = HOUR_MS;
export const ACCOUNT = '20000000-0000-4000-8000-000000000001';
export const PDD_ACCOUNT = '20000000-0000-4000-8000-000000000002';
export const TAOBAO_ACCOUNT = '20000000-0000-4000-8000-000000000003';
export const OTHER_ACCOUNT = '20000000-0000-4000-8000-000000000004';
export const JD_ENABLED = 'order_sync.rescan.jd.enabled';
export const JD_DAYS = 'order_sync.rescan.jd.days';
export const PDD_ENABLED = 'order_sync.rescan.pdd.enabled';

export const iso = (ms: number): string => new Date(ms).toISOString();
export const daysAgo = (days: number, nowMs = NOW_MS): string => iso(nowMs - days * DAY_MS);
/** A round starts the margin after now − days; call it only after the code under test ran. */
export const roundStart = (days: number, nowMs = NOW_MS): string =>
  iso(nowMs - days * DAY_MS + RESCAN_START_MARGIN_MS);

export const account: SyncAccount = {
  app_id: 'rescan-spec',
  platform: 'jd',
  union_account_id: ACCOUNT,
  sync_start_at: '2026-01-01T00:00:00.000Z',
};
export const pddAccount: SyncAccount = {
  ...account,
  platform: 'pdd',
  union_account_id: PDD_ACCOUNT,
};
export const stream: RescanStream = {
  app_id: account.app_id,
  platform: 'jd',
  union_account_id: ACCOUNT,
  query_kind: 'rescan',
  scene: '-',
};
export const pddStream: RescanStream = {
  ...stream,
  platform: 'pdd',
  union_account_id: PDD_ACCOUNT,
};

export function rescanWindow(
  start: string,
  capMs = JD_CAP_MS,
  base: RescanStream = stream,
): OrderRescanWindow {
  return { ...base, window_start: start, window_end: iso(Date.parse(start) + capMs) };
}

/** A window of the fixture's jd stream, 16 days back: inside the default range. */
export const window = rescanWindow('2026-10-01T00:00:00.000Z');

export function job(payload: JobPayload = window, attempt = 1): ReceivedJob {
  return {
    id: 'synthetic-rescan-job',
    queue: 'order-sync',
    name: 'rescan-window',
    payload,
    attempt,
  };
}

export function order(id: string, raw = '101'): UnionOrder {
  // Synthetic normalized DTO, not a fabricated platform response.
  return {
    platform: 'jd',
    order_id: id,
    sub_order_id: id,
    paid_fen: 1000n,
    commission_fen: 100n,
    raw_payload_id: raw,
  };
}

interface MockLike {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

/** The fields of every pino-style call with this message. */
export function logged(fn: MockLike, message: string): unknown[] {
  return fn.mock.calls.filter((call) => call[1] === message).map((call) => call[0]);
}

/** Calls that mention a text anywhere in their arguments. */
export function mentioning(fn: MockLike, text: string): (readonly unknown[])[] {
  return fn.mock.calls.filter((call) => JSON.stringify(call).includes(text));
}

interface FixtureOptions {
  readonly cursor?: string | null;
  readonly accounts?: readonly SyncAccount[];
  readonly config?: Readonly<Record<string, unknown>>;
}

const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

/** Cursors behave like infra/sync-cursors.ts: both moves are compare-and-set on one value. */
export function fixture(options: FixtureOptions = {}) {
  const clock = new FixedClock(NOW);
  let cursor = options.cursor ?? null;
  const send = vi.fn<JobQueue['send']>().mockResolvedValue('queued-rescan');
  const read = vi.fn<RescanCursorStore['read']>(async () => cursor);
  const advance = vi.fn<RescanCursorStore['advance']>(async (win) => {
    if (cursor !== null && !sameInstant(cursor, win.window_start)) return false;
    cursor = win.window_end;
    return true;
  });
  const rewind = vi.fn<RescanCursorStore['rewind']>(async (_stream, expected, to) => {
    if (cursor === null || !sameInstant(cursor, expected)) return false;
    cursor = to;
    return true;
  });
  const listEnabledAccounts = vi
    .fn<SyncAccessPort['listEnabledAccounts']>()
    .mockResolvedValue(options.accounts ?? [account]);
  const siteAuthAvailable = vi.fn<SyncAccessPort['siteAuthAvailable']>().mockResolvedValue(true);
  const offlineCircuitOpen = vi.fn<SyncAccessPort['offlineCircuitOpen']>().mockResolvedValue(false);
  const owners: Readonly<Record<RegisteredPlatform, string>> = {
    jd: ACCOUNT,
    pdd: PDD_ACCOUNT,
    taobao: TAOBAO_ACCOUNT,
  };
  const queryableAccount = vi.fn<NonNullable<SyncAccessPort['queryableAccount']>>(
    async (platform) => owners[platform],
  );
  const access = { listEnabledAccounts, siteAuthAvailable, offlineCircuitOpen, queryableAccount };
  const cursors = { read, advance, rewind };
  const values = options.config ?? {};
  const config = { get: vi.fn<(key: string) => Promise<unknown>>(async (key) => values[key]) };
  const listOrders = vi
    .fn<UnionAdapter['listOrders']>()
    .mockResolvedValue({ items: [], nextCursor: null });
  const get = vi.fn(() => ({ listOrders }));
  const process = vi.fn<OrderPipelinePort['process']>().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // The rule table's cap, as production: jd has none until B1-04zr, so `scheduler` injects it.
  const ruleTableCaps: OrderRescanSchedulerDeps = {
    clock,
    queue: { send },
    access,
    cursors,
    config,
    logger,
  };
  const scheduler: OrderRescanSchedulerDeps = { ...ruleTableCaps, capsMs: { jd: JD_CAP_MS } };
  const handler: OrderRescanHandlerDeps = {
    access,
    cursors,
    registry: { get },
    pipeline: { process },
    platforms: ['jd', 'pdd'],
    logger,
  };
  return {
    clock,
    send,
    read,
    advance,
    rewind,
    listEnabledAccounts,
    siteAuthAvailable,
    offlineCircuitOpen,
    queryableAccount,
    config,
    listOrders,
    get,
    process,
    logger,
    ruleTableCaps,
    scheduler,
    handler,
    cursor: () => cursor,
    sent: () => send.mock.calls.map(([, , payload]) => payload),
  };
}
