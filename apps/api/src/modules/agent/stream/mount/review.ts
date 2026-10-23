// B3-03m · BR-AI-18: the stream entry's input check (B3-05d createInputCheck) and sentence review
// (B3-06b Aliyun content safety, llm_query_moderation / llm_response_moderation), signed with
// ACS3 (../../guard/review/sign.ts). Live only in staging / prod with a complete AccessKey pair and
// an https endpoint; anything else (no options, local / test, a missing or blank half, no
// endpoint) is the fail-closed pair: every message is refused as review unavailable
// (agent.refuse.safety_unavailable, ending input_review_timeout, refunded) and every sentence
// review answers timeout, with no network request at all (non-production external adapters are
// fakes only, AGENTS.md §6). Building performs no external work. Credentials are never logged.
// TODO(规划/11 §6): 真实调用验证 — blocked on 负责人在 staging 放入阿里云内容安全 Key
// B3-03n: with deps.config, the input review budget is agent.safety.timeout_ms of each request's
// app, read per request (createStreamReview below); the sentence review keeps options.timeoutMs.
import { randomUUID } from 'node:crypto';
import type { AppEnv, Clock, RootLogger, Scheduler } from '../../../platform/index.ts';
import type { SentenceReviewPort } from '../../guard/index.ts';
import {
  createAliyunInputReview,
  createAliyunOutputReview,
  type AliyunCredentials,
  type AliyunReviewDeps,
  type AliyunReviewFetch,
} from '../../guard/review/index.ts';
import { createAliyunAcs3Signer } from '../../guard/review/sign.ts';
import {
  failClosedInputCheck,
  type AgentRunTexts,
  type InputCheckPort,
} from '../../orchestrator/index.ts';
import { createInputCheck } from '../../preprocess/input/index.ts';

/** Composition-root configuration, never process.env in agent code. Omitted configuration,
 * incomplete credentials or a local/test environment must fail closed without network I/O.
 * Production defaults for fetch/nonce are supplied by the implementation; tests inject both.
 */
export interface StreamReviewOptions {
  readonly appEnv: AppEnv;
  readonly credentials?: AliyunCredentials | undefined;
  readonly endpoint?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetch?: AliyunReviewFetch;
  readonly nonce?: () => string;
}

export interface StreamReviewPorts {
  readonly inputCheck: InputCheckPort;
  readonly review: SentenceReviewPort;
}

/** B3-03n: content's configuration read port (createContentReader's configValue). */
export interface StreamReviewConfigReader {
  configValue(appId: string, key: string): Promise<{ readonly value: unknown } | null>;
}

/**
 * B3-03n · BR-AI-18: createStreamReview's dependencies. With `config`, every input check reads
 * agent.safety.timeout_ms for that request's app (input.caller.appId) through it and uses that
 * value as the whole input review budget; a missing key is the BR-AI-18 default 1000 ms, a value
 * that is not a finite positive number takes the same default (the configuration layer's
 * existing rule; never an unlimited wait). options.timeoutMs, when the composition root sets
 * one, stands in for that default. A read that fails or hangs is fail-close (review unavailable,
 * refunded). createProductionStreamAssembly passes its content reader.
 */
export interface StreamReviewDeps {
  readonly options?: StreamReviewOptions;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly logger: RootLogger;
  readonly texts: Pick<AgentRunTexts, 'text'>;
  readonly config?: StreamReviewConfigReader;
}

/** BR-AI-18 default of agent.safety.timeout_ms. */
const DEFAULT_TIMEOUT_MS = 1000;

interface LiveSettings {
  readonly credentials: AliyunCredentials;
  readonly endpoint: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function httpsEndpoint(value: unknown): string | undefined {
  if (!nonBlank(value)) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The environment is checked first: local / test never touch the credentials. */
function liveSettings(options: StreamReviewOptions | undefined): LiveSettings | undefined {
  if (options === undefined) return undefined;
  if (options.appEnv !== 'staging' && options.appEnv !== 'prod') return undefined;
  const endpoint = httpsEndpoint(options.endpoint);
  if (endpoint === undefined) return undefined;
  const credentials = options.credentials;
  if (credentials === undefined) return undefined;
  if (!nonBlank(credentials.accessKeyId) || !nonBlank(credentials.accessKeySecret)) {
    return undefined;
  }
  const frozen: AliyunCredentials = Object.freeze(
    credentials.securityToken === undefined
      ? { accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret }
      : {
          accessKeyId: credentials.accessKeyId,
          accessKeySecret: credentials.accessKeySecret,
          securityToken: credentials.securityToken,
        },
  );
  return { credentials: frozen, endpoint };
}

/** The configuration layer's rule for a budget: a finite positive number, else `fallback`. */
function validBudget(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function budgetOf(options: StreamReviewOptions | undefined): number {
  return validBudget(options?.timeoutMs, DEFAULT_TIMEOUT_MS);
}

const TIMEOUT_KEY = 'agent.safety.timeout_ms';
/** Distinct budgets kept with their built input check; beyond it the cache starts over. */
const CHECK_CACHE_LIMIT = 16;

const UNREADABLE: unique symbol = Symbol('unreadable');

/**
 * agent.safety.timeout_ms of one app, read now; a missing key or an invalid value is `fallback`
 * (options.timeoutMs when set, else the BR-AI-18 default). A read that fails, does not settle
 * within the default budget or outlives the run is UNREADABLE (fail-close: review unavailable).
 */
async function readBudget(
  config: StreamReviewConfigReader,
  scheduler: Scheduler,
  appId: string,
  signal: AbortSignal,
  fallback: number,
): Promise<number | typeof UNREADABLE> {
  if (signal.aborted) return UNREADABLE;
  const timer = new AbortController();
  const stop = (): void => {
    timer.abort();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const read = Promise.resolve()
      .then(() => config.configValue(appId, TIMEOUT_KEY))
      .then(
        (entry): number => validBudget(entry?.value, fallback),
        (): typeof UNREADABLE => UNREADABLE,
      );
    const deadline = scheduler.sleep(DEFAULT_TIMEOUT_MS, timer.signal).then(
      (): typeof UNREADABLE => UNREADABLE,
      (): typeof UNREADABLE => UNREADABLE,
    );
    const budget = await Promise.race([read, deadline]);
    return signal.aborted ? UNREADABLE : budget;
  } finally {
    timer.abort();
    signal.removeEventListener('abort', stop);
  }
}

/** Production transport: the platform fetch, called lazily (never captured at build). */
const platformFetch: AliyunReviewFetch = (url, init) => globalThis.fetch(url, init);

function failClosed(): StreamReviewPorts {
  return {
    inputCheck: failClosedInputCheck(),
    review: { review: async () => 'timeout' },
  };
}

/** Connects B3-05d input checking and B3-06b sentence review, with real ACS3 signing.
 * Default safety budget is 1000ms. Construction performs no external work (no configuration read).
 */
export function createStreamReview(deps: StreamReviewDeps): StreamReviewPorts {
  const live = liveSettings(deps.options);
  if (live === undefined) return failClosed();
  const options = deps.options;
  const aliyunFor = (budget: number): AliyunReviewDeps => ({
    fetch: options?.fetch ?? platformFetch,
    scheduler: deps.scheduler,
    timeoutMs: () => budget,
    credentials: () => live.credentials,
    sign: createAliyunAcs3Signer({ clock: deps.clock, nonce: options?.nonce ?? randomUUID }),
    endpoint: live.endpoint,
    logger: deps.logger,
  });
  const inputFor = (budget: number): InputCheckPort =>
    createInputCheck({
      review: createAliyunInputReview(aliyunFor(budget)),
      scheduler: deps.scheduler,
      timeoutMs: () => budget,
      texts: deps.texts,
    });
  const fixed = budgetOf(options);
  const review = createAliyunOutputReview(aliyunFor(fixed));
  const config = deps.config;
  if (config === undefined) return { inputCheck: inputFor(fixed), review };

  // One input check per budget value: the budget of a request is bound when its check is built,
  // so concurrent requests of apps with different budgets never share one.
  const checks = new Map<number, InputCheckPort>();
  const checkFor = (budget: number): InputCheckPort => {
    const known = checks.get(budget);
    if (known !== undefined) return known;
    if (checks.size >= CHECK_CACHE_LIMIT) checks.clear();
    const built = inputFor(budget);
    checks.set(budget, built);
    return built;
  };
  const unavailable = failClosedInputCheck();
  return {
    inputCheck: {
      async check(input, signal) {
        const budget = await readBudget(config, deps.scheduler, input.caller.appId, signal, fixed);
        if (budget === UNREADABLE) {
          if (signal.aborted) return unavailable.check(input, signal);
          deps.logger.warn({ app_id: input.caller.appId }, 'agent_safety_timeout_unreadable');
          return unavailable.check(input, signal);
        }
        return checkFor(budget).check(input, signal);
      },
    },
    review,
  };
}
