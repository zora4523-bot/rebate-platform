// Stage ⑬ of the request decision order (规划/08 BR-ID-01 判定顺序 ⑬ 限流; 02 §12.2 限流行: user,
// device and IP token buckets, thresholds configurable per interface group, 42901 + Retry-After;
// 02 §14 Redis: every key carries a TTL; 02 §15: a Redis outage refuses limited operations). Task
// B1-03e; the HTTP wiring (guard after ④a, idempotency post-miss hook after ④a) is in
// ./rate-limit-gate.ts and ../risk.module.ts.
//
// Thresholds (createRateLimitThresholdReader): config_items through content's reader, assembled by
// app.module so risk never imports content.
// - `rate_limit.ops`: `{ "<operationId>": "<group>" | null }`, merged over DEFAULT_GROUPS (null
//   removes an operation from its default group).
// - `rate_limit.<group>`: `{ "user": [{ "limit": n, "window_sec": s }, …], "device": […],
//   "ip": […] }`; a valid value replaces the group's defaults as a whole (an absent dimension has no
//   rule). A missing key, malformed JSON, a wrong shape or a failed read falls back to the code
//   defaults (06 Q-B4 as ruled in B1-03e §9.2): never a refusal.
// Buckets (createRateLimitService): one Redis key per (app, group, dimension, identity, window),
// `rl:<app_id>:<group>:<dim>:<sha256 of the identity, 32 hex>:<window_sec>`. The identity is hashed
// so no uid, device id or IP is stored in Redis and keys stay bounded. Token arithmetic is integer:
// a bucket holds `limit × window_ms` units, one token is `window_ms` units and every elapsed
// millisecond adds `limit` units, so refill is exact (no floating rounding at window boundaries).
// One Lua script judges every bucket of the request first and spends one token from each only when
// all of them can pay: a refused request spends nothing in any bucket. The time is the injected
// Clock's milliseconds (never Redis TIME). Each written key expires after twice its window (capped by
// the script TTL, ARGV[1]); an expired bucket would be full again anyway.
// Store outage (any failure of the Redis call): 42901 with Retry-After 1, never a pass. Alerts
// carry no user, device, IP or key: `rate_limit_store_unavailable` (error) on the first failure of
// an outage, `rate_limit_store_unavailable_summary` (warn) at most once per 60 s of the Clock while
// it lasts (refusals per operationId, flat), `rate_limit_store_recovered` (info) on the next success.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import { createHash } from 'node:crypto';
import type {
  Clock,
  RedisHandle,
  RootLogger,
  TokenPrincipal,
  VerifiedDevice,
} from '../../platform/index.ts';

/** ContentReader is structurally compatible; composition belongs in AppModule. */
export interface RateLimitConfigReader {
  configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: unknown; readonly version: number } | null>;
}

export interface RateLimitRule {
  readonly limit: number;
  readonly window_sec: number;
}

/** App/group/dimension policy port, also reusable by the following risk tasks. */
export interface RateLimitThresholdReader {
  groupFor(appId: string, operationId: string): Promise<string | null>;
  rules(
    appId: string,
    group: string,
    dimension: 'user' | 'device' | 'ip',
  ): Promise<readonly RateLimitRule[]>;
}

export type RateLimitDimension = 'user' | 'device' | 'ip';

const DIMENSIONS: readonly RateLimitDimension[] = ['user', 'device', 'ip'];

/** Operation → interface group of the code defaults (06 Q-B4; ruling B1-03e §9.2). */
const DEFAULT_GROUPS: Readonly<Record<string, string>> = Object.freeze({
  openLink: 'convert',
  convertLink: 'convert',
  searchProducts: 'search',
});

type GroupRules = Readonly<Partial<Record<RateLimitDimension, readonly RateLimitRule[]>>>;

/** Code defaults per group (06 Q-B4): no default for a dimension the planning does not name. */
const DEFAULT_RULES: Readonly<Record<string, GroupRules>> = Object.freeze({
  convert: {
    user: [
      { limit: 30, window_sec: 60 },
      { limit: 500, window_sec: 86_400 },
    ],
  },
  search: {
    user: [{ limit: 60, window_sec: 60 }],
    ip: [{ limit: 120, window_sec: 60 }],
  },
});

const OPS_KEY = 'rate_limit.ops';
const GROUP_KEY_PREFIX = 'rate_limit.';
/** Group names usable in a config key; `ops` is the mapping key itself. */
const GROUP_NAME = /^[a-z0-9_]{1,32}$/;
const MAX_LIMIT = 1_000_000;
/** 31 days: limit × window_ms stays far below 2^53 (exact integers in Lua's doubles). */
const MAX_WINDOW_SEC = 2_678_400;
const MAX_RULES_PER_DIMENSION = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The stored JSON value; a JSON text stored as a string is parsed. Undefined when malformed. */
function jsonObject(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return isPlainObject(parsed) ? parsed : undefined;
}

function validGroup(value: unknown): value is string {
  return typeof value === 'string' && GROUP_NAME.test(value) && value !== 'ops';
}

function validRule(value: unknown): RateLimitRule | undefined {
  if (!isPlainObject(value)) return undefined;
  const { limit, window_sec: windowSec } = value;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit)) return undefined;
  if (typeof windowSec !== 'number' || !Number.isSafeInteger(windowSec)) return undefined;
  if (limit < 1 || limit > MAX_LIMIT || windowSec < 1 || windowSec > MAX_WINDOW_SEC) {
    return undefined;
  }
  return { limit, window_sec: windowSec };
}

/** A group's configured rules, or undefined when the value is not of the documented shape. */
function parseGroupRules(value: unknown): GroupRules | undefined {
  const object = jsonObject(value);
  if (object === undefined) return undefined;
  const rules: Partial<Record<RateLimitDimension, readonly RateLimitRule[]>> = {};
  for (const dimension of DIMENSIONS) {
    const list = object[dimension];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > MAX_RULES_PER_DIMENSION) return undefined;
    const parsed: RateLimitRule[] = [];
    for (const item of list as unknown[]) {
      const rule = validRule(item);
      if (rule === undefined) return undefined;
      parsed.push(rule);
    }
    rules[dimension] = parsed;
  }
  return rules;
}

/** The configured operation mapping, or undefined when not of the documented shape. */
function parseOps(value: unknown): Readonly<Record<string, string | null>> | undefined {
  const object = jsonObject(value);
  if (object === undefined) return undefined;
  const ops: Record<string, string | null> = {};
  for (const [operationId, group] of Object.entries(object)) {
    if (group !== null && !validGroup(group)) return undefined;
    ops[operationId] = group;
  }
  return ops;
}

/** AppModule supplies content's configValue reader; missing/bad/failed reads use defaults. */
export function createRateLimitThresholdReader(
  config: RateLimitConfigReader,
): RateLimitThresholdReader {
  /** The key's value; null when missing or unreadable (a read failure is not a store outage). */
  async function read(appId: string, key: string): Promise<unknown> {
    try {
      const found = await config.configValue(appId, key);
      return found === null ? null : found.value;
    } catch {
      return null;
    }
  }

  return {
    async groupFor(appId, operationId) {
      const raw = await read(appId, OPS_KEY);
      const ops = raw === null ? undefined : parseOps(raw);
      if (ops !== undefined && Object.hasOwn(ops, operationId)) return ops[operationId] ?? null;
      return Object.hasOwn(DEFAULT_GROUPS, operationId) ? DEFAULT_GROUPS[operationId]! : null;
    },
    async rules(appId, group, dimension) {
      if (!validGroup(group)) return [];
      const raw = await read(appId, `${GROUP_KEY_PREFIX}${group}`);
      const configured = raw === null ? undefined : parseGroupRules(raw);
      const rules = configured ?? (Object.hasOwn(DEFAULT_RULES, group) ? DEFAULT_RULES[group] : {});
      return [...(rules?.[dimension] ?? [])];
    },
  };
}

/** Only verified identity reaches this port; client_ip is Fastify request.ip. */
export interface RateLimitRequest {
  readonly entry: 'api' | 'admin';
  readonly operationId: string;
  readonly app_id: string;
  readonly principal?: TokenPrincipal;
  readonly verifiedDevice?: VerifiedDevice;
  readonly client_ip?: string;
}

export type RateLimitResult =
  { readonly code: 0 } | { readonly code: 42901; readonly retryAfterSec: number };

export interface RateLimitOptions {
  readonly clock: Clock;
  readonly redis: RedisHandle;
  readonly thresholds: RateLimitThresholdReader;
  readonly logger: RootLogger;
}

export interface RateLimitService {
  check(request: RateLimitRequest): Promise<RateLimitResult>;
}

/** Redis namespace of the buckets: keys read `rl:<app_id>:<group>:<dim>:…`. */
export const RATE_LIMIT_NAMESPACE = 'rl';
/** Retry-After of a refusal caused by the bucket store (ruling B1-03e §9.2). */
export const RATE_LIMIT_STORE_RETRY_AFTER_SEC = 1;
const SUMMARY_INTERVAL_MS = 60_000;
const ALLOW: RateLimitResult = Object.freeze({ code: 0 });

/**
 * KEYS: one bucket each. ARGV[1]: the TTL cap (seconds), ARGV[2]: now (ms, injected Clock), then
 * per key: limit, window_ms, ttl (seconds). Units: a bucket holds limit × window_ms units, a token
 * is window_ms units, a millisecond refills limit units (integers below 2^53, exact in Lua).
 * Judges every bucket before writing any: returns {1, 0} after spending one token from each, or
 * {0, wait_ms} (the longest wait until every refusing bucket holds a token) without writing.
 */
const BUCKET_SCRIPT = `
local cap_ttl = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local n = #KEYS
local tokens = {}
local stamps = {}
local wait = 0
for i = 1, n do
  local base = 3 + (i - 1) * 3
  local limit = tonumber(ARGV[base])
  local window = tonumber(ARGV[base + 1])
  local capacity = limit * window
  local level = capacity
  local stamp = now
  local stored = redis.call('HMGET', KEYS[i], 't', 'ts')
  local t = tonumber(stored[1])
  local ts = tonumber(stored[2])
  if t ~= nil and ts ~= nil then
    local elapsed = now - ts
    if elapsed < 0 then
      elapsed = 0
      stamp = ts
    end
    level = t + elapsed * limit
    if level > capacity then level = capacity end
  end
  if level < window then
    local need = math.ceil((window - level) / limit)
    if need > wait then wait = need end
  end
  tokens[i] = level
  stamps[i] = stamp
end
if wait > 0 then return {0, wait} end
for i = 1, n do
  local base = 3 + (i - 1) * 3
  local window = tonumber(ARGV[base + 1])
  local ttl = tonumber(ARGV[base + 2])
  if ttl > cap_ttl then ttl = cap_ttl end
  redis.call('HSET', KEYS[i], 't', string.format('%.0f', tokens[i] - window),
    'ts', string.format('%.0f', stamps[i]))
  redis.call('EXPIRE', KEYS[i], ttl)
end
return {1, 0}
`;

interface Bucket {
  readonly key: string;
  readonly rule: RateLimitRule;
}

/** Bounded, non-identifying key part for one identity of one dimension. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** One rule per window: two rules with the same window share a key, so keep the stricter. */
function byWindow(rules: readonly RateLimitRule[]): RateLimitRule[] {
  const windows = new Map<number, RateLimitRule>();
  for (const rule of rules) {
    const seen = windows.get(rule.window_sec);
    if (seen === undefined || rule.limit < seen.limit) windows.set(rule.window_sec, rule);
  }
  return [...windows.values()];
}

function identities(request: RateLimitRequest): Readonly<Record<RateLimitDimension, unknown>> {
  return {
    user: request.principal?.uid,
    device: request.principal?.device_id ?? request.verifiedDevice?.deviceId,
    ip: request.client_ip,
  };
}

/** The script's reply: [allowed (1/0), wait_ms]; undefined for anything else. */
function parseReply(reply: unknown): { allowed: boolean; waitMs: number } | undefined {
  if (!Array.isArray(reply) || reply.length !== 2) return undefined;
  const [allowed, waitMs] = reply as unknown[];
  if ((allowed !== 0 && allowed !== 1) || typeof waitMs !== 'number') return undefined;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) return undefined;
  return { allowed: allowed === 1, waitMs };
}

class UnexpectedReply extends Error {
  constructor() {
    super('rate limit script returned an unexpected reply');
    this.name = 'UnexpectedReply';
  }
}

/** Flat, non-identifying fields of a store failure. */
function failureFields(error: unknown): { reason: string; error_class: string } {
  const reason =
    typeof error === 'object' && error !== null && typeof Reflect.get(error, 'reason') === 'string'
      ? String(Reflect.get(error, 'reason'))
      : 'unknown';
  const errorClass = error instanceof Error ? error.name : typeof error;
  return { reason, error_class: errorClass };
}

/** B1-03e: reusable three-dimensional Redis buckets, policy lookup and outage alerts. */
export function createRateLimitService(options: RateLimitOptions): RateLimitService {
  const { clock, redis, thresholds, logger } = options;

  /** Outage state of this process; null while the store answers. */
  let outage: { since: number; intervalStart: number; refused: Map<string, number> } | null = null;

  function storeFailed(operationId: string, error: unknown): RateLimitResult {
    const now = clock.now().getTime();
    if (outage === null) {
      outage = { since: now, intervalStart: now, refused: new Map() };
      logger.error(
        { stage: '13', operation_id: operationId, ...failureFields(error) },
        'rate_limit_store_unavailable',
      );
    }
    const current = outage;
    current.refused.set(operationId, (current.refused.get(operationId) ?? 0) + 1);
    if (now - current.intervalStart >= SUMMARY_INTERVAL_MS) {
      const operations = [...current.refused.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, count]) => `${id}=${String(count)}`)
        .join(',');
      let rejected = 0;
      for (const count of current.refused.values()) rejected += count;
      logger.warn(
        { stage: '13', operations, rejected, outage_ms: now - current.since },
        'rate_limit_store_unavailable_summary',
      );
      current.intervalStart = now;
      current.refused = new Map();
    }
    return { code: 42901, retryAfterSec: RATE_LIMIT_STORE_RETRY_AFTER_SEC };
  }

  function storeAnswered(): void {
    if (outage === null) return;
    const now = clock.now().getTime();
    let rejected = 0;
    for (const count of outage.refused.values()) rejected += count;
    logger.info(
      { stage: '13', outage_ms: now - outage.since, rejected_since_summary: rejected },
      'rate_limit_store_recovered',
    );
    outage = null;
  }

  async function bucketsOf(request: RateLimitRequest, group: string): Promise<Bucket[]> {
    const ids = identities(request);
    const buckets: Bucket[] = [];
    for (const dimension of DIMENSIONS) {
      const id = ids[dimension];
      if (typeof id !== 'string' || id === '') continue;
      const rules = byWindow(await thresholds.rules(request.app_id, group, dimension));
      const hashed = digest(id);
      for (const rule of rules) {
        buckets.push({
          key: `${request.app_id}:${group}:${dimension}:${hashed}:${String(rule.window_sec)}`,
          rule,
        });
      }
    }
    return buckets;
  }

  return {
    async check(request) {
      if (request.entry !== 'api') return ALLOW;
      const group = await thresholds.groupFor(request.app_id, request.operationId);
      if (group === null) return ALLOW;
      const buckets = await bucketsOf(request, group);
      if (buckets.length === 0) return ALLOW;
      const args: string[] = [String(clock.now().getTime())];
      let ttlCap = 1;
      for (const { rule } of buckets) {
        const ttl = rule.window_sec * 2;
        if (ttl > ttlCap) ttlCap = ttl;
        args.push(String(rule.limit), String(rule.window_sec * 1000), String(ttl));
      }
      let verdict: { allowed: boolean; waitMs: number };
      try {
        const reply = await redis.namespace(RATE_LIMIT_NAMESPACE).eval(BUCKET_SCRIPT, {
          keys: buckets.map((bucket) => bucket.key),
          args,
          ttlSeconds: ttlCap,
        });
        const parsed = parseReply(reply);
        if (parsed === undefined) throw new UnexpectedReply();
        verdict = parsed;
      } catch (error) {
        return storeFailed(request.operationId, error);
      }
      storeAnswered();
      if (verdict.allowed) return ALLOW;
      return { code: 42901, retryAfterSec: Math.max(1, Math.ceil(verdict.waitMs / 1000)) };
    },
  };
}
