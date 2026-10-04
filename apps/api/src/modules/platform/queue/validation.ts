import { ENTRY_PLAN, QUEUE_CATALOG } from './catalog.ts';
import {
  MAX_PAYLOAD_BYTES,
  QueueError,
  type JobPayload,
  type QueueRuntimeOptions,
  type QueueSpec,
  type SendOptions,
} from './types.ts';

const entries = ['api', 'stream', 'admin', 'worker', 'payout'] as const;
const specKeys = [
  'name',
  'policy',
  'retryLimit',
  'retryDelaySeconds',
  'retryBackoff',
  'retryDelayMaxSeconds',
  'expireInSeconds',
  'retentionSeconds',
  'deleteAfterSeconds',
  'deadLetter',
];

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Do not invoke getters while validating boundary objects. */
function keys(
  value: unknown,
  allowed: readonly string[],
  required = allowed,
): value is Record<string, unknown> {
  return (
    plain(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === 'string' &&
        allowed.includes(key) &&
        descriptor?.enumerable === true &&
        Object.hasOwn(descriptor, 'value')
      );
    })
  );
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function validCatalog(catalog: unknown, plan: unknown): boolean {
  if (!Array.isArray(catalog) || !keys(plan, entries)) return false;
  const queues = new Map<string, Record<string, unknown>>();
  for (const item of catalog) {
    if (
      !keys(item, specKeys) ||
      typeof item.name !== 'string' ||
      item.name.length > 50 ||
      !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(item.name) ||
      queues.has(item.name) ||
      (item.policy !== 'standard' && item.policy !== 'exclusive') ||
      !integer(item.retryLimit, 0, 20) ||
      !integer(item.retryDelaySeconds, 1, 3600) ||
      typeof item.retryBackoff !== 'boolean' ||
      (item.retryDelayMaxSeconds !== null &&
        (!item.retryBackoff ||
          !integer(item.retryDelayMaxSeconds, item.retryDelaySeconds, 86_400))) ||
      !integer(item.expireInSeconds, 1, 86_400) ||
      !integer(item.retentionSeconds, 60, 2_592_000) ||
      !integer(item.deleteAfterSeconds, 60, 2_592_000)
    )
      return false;
    queues.set(item.name, item);
  }
  const deadLetters = new Set<string>();
  for (const [name, item] of queues) {
    if (item.deadLetter === null) continue;
    if (typeof item.deadLetter !== 'string' || item.deadLetter === name) return false;
    const target = queues.get(item.deadLetter);
    if (target?.policy !== 'standard' || target.deadLetter !== null) return false;
    deadLetters.add(item.deadLetter);
  }
  const assigned = new Set<string>();
  for (const entry of entries) {
    const items = plan[entry];
    if (!Array.isArray(items)) return false;
    for (const item of items) {
      if (
        !keys(item, ['queue', 'concurrency', 'pollingIntervalSeconds']) ||
        typeof item.queue !== 'string' ||
        !queues.has(item.queue) ||
        deadLetters.has(item.queue) ||
        assigned.has(item.queue) ||
        (item.queue === 'payout' && entry !== 'payout') ||
        !integer(item.concurrency, 1, 10) ||
        typeof item.pollingIntervalSeconds !== 'number' ||
        !integer(item.pollingIntervalSeconds * 2, 1, 120)
      )
        return false;
      assigned.add(item.queue);
    }
  }
  return true;
}

export function runtimeOptions(options: QueueRuntimeOptions): Required<QueueRuntimeOptions> {
  const catalog = options?.catalog === undefined ? QUEUE_CATALOG : options.catalog;
  const plan = options?.plan === undefined ? ENTRY_PLAN : options.plan;
  if (!validCatalog(catalog, plan)) throw new QueueError('invalid_catalog');
  if (
    !keys(
      options,
      ['entry', 'db', 'logger', 'catalog', 'plan', 'stopTimeoutMs'],
      ['entry', 'db', 'logger'],
    ) ||
    !entries.includes(options.entry) ||
    (options.stopTimeoutMs !== undefined && !integer(options.stopTimeoutMs, 1, 60_000)) ||
    options.db === null ||
    typeof options.db !== 'object' ||
    typeof options.db.executeQuery !== 'function' ||
    options.logger === null ||
    typeof options.logger !== 'object' ||
    typeof options.logger.warn !== 'function' ||
    typeof options.logger.error !== 'function'
  ) {
    throw new QueueError('invalid_option');
  }
  // Snapshot configuration so a caller cannot change validated settings during a running process.
  return {
    entry: options.entry,
    db: options.db,
    logger: options.logger,
    stopTimeoutMs: options.stopTimeoutMs ?? 5000,
    catalog: catalog.map((spec) => ({ ...spec })),
    plan: Object.fromEntries(
      entries.map((entry) => [entry, plan[entry].map((work) => ({ ...work }))]),
    ) as unknown as Required<QueueRuntimeOptions>['plan'],
  };
}

function validString(value: string): boolean {
  return value.isWellFormed() && !value.includes('\u0000');
}

function json(value: unknown, level: number, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return validString(value);
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value !== 'object' || level > 32 || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (array && ownKeys.length !== value.length + 1) return false;
  ancestors.add(value);
  const valid = ownKeys.every((key) => {
    if (array && key === 'length') return true;
    if (typeof key !== 'string' || !validString(key)) return false;
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor?.enumerable === true &&
      Object.hasOwn(descriptor, 'value') &&
      json(descriptor.value, level + 1, ancestors)
    );
  });
  ancestors.delete(value);
  return valid;
}

export function validateSend(
  spec: QueueSpec,
  name: string,
  payload: JobPayload,
  options: SendOptions,
): void {
  if (
    typeof name !== 'string' ||
    name.length > 64 ||
    !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(name)
  ) {
    throw new QueueError('invalid_name');
  }
  if (!plain(payload) || !json(payload, 1, new Set())) throw new QueueError('invalid_payload');
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new QueueError('payload_too_large');
  }
  if (
    !keys(options, ['trx', 'id', 'singletonKey', 'delaySeconds'], ['trx']) ||
    (options.trx !== null &&
      (typeof options.trx !== 'object' || options.trx.isTransaction !== true)) ||
    (Object.hasOwn(options, 'id') &&
      (typeof options.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.id))) ||
    (spec.policy === 'standard'
      ? Object.hasOwn(options, 'singletonKey')
      : typeof options.singletonKey !== 'string' ||
        !/^[A-Za-z0-9:._+-]{1,200}$/.test(options.singletonKey)) ||
    (Object.hasOwn(options, 'delaySeconds') && !integer(options.delaySeconds, 0, 2_592_000))
  ) {
    throw new QueueError('invalid_option');
  }
}
