// B3-03m · BR-AI-18: the stream entry's input check (B3-05d createInputCheck) and sentence review
// (B3-06b Aliyun content safety, llm_query_moderation / llm_response_moderation), signed with
// ACS3 (../../guard/review/sign.ts). Live only in staging / prod with a complete AccessKey pair and
// an https endpoint; anything else (no options, local / test, a missing or blank half, no
// endpoint) is the fail-closed pair: every message is refused as review unavailable
// (agent.refuse.safety_unavailable, ending input_review_timeout, refunded) and every sentence
// review answers timeout, with no network request at all (non-production external adapters are
// fakes only, AGENTS.md §6). Building performs no external work. Credentials are never logged.
// TODO(规划/11 §6): 真实调用验证 — blocked on 负责人在 staging 放入阿里云内容安全 Key
// TODO(规划/11 §2.3): agent.safety.timeout_ms 按 app 从内容配置读取 — blocked on 组合根尚无按 app 的配置读取端口（现用 options.timeoutMs，缺省 1000ms）
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
 * existing rule; never an unlimited wait). createProductionStreamAssembly passes its content
 * reader.
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

function budgetOf(options: StreamReviewOptions | undefined): number {
  const value = options?.timeoutMs;
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
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
 * Default safety budget is 1000ms. Construction performs no external work.
 */
export function createStreamReview(deps: {
  readonly options?: StreamReviewOptions;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly logger: RootLogger;
  readonly texts: Pick<AgentRunTexts, 'text'>;
}): StreamReviewPorts {
  const live = liveSettings(deps.options);
  if (live === undefined) return failClosed();
  const options = deps.options;
  const budget = budgetOf(options);
  const aliyun: AliyunReviewDeps = {
    fetch: options?.fetch ?? platformFetch,
    scheduler: deps.scheduler,
    timeoutMs: () => budget,
    credentials: () => live.credentials,
    sign: createAliyunAcs3Signer({ clock: deps.clock, nonce: options?.nonce ?? randomUUID }),
    endpoint: live.endpoint,
    logger: deps.logger,
  };
  return {
    inputCheck: createInputCheck({
      review: createAliyunInputReview(aliyun),
      scheduler: deps.scheduler,
      timeoutMs: () => budget,
      texts: deps.texts,
    }),
    review: createAliyunOutputReview(aliyun),
  };
}
