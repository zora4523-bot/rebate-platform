// Stage ⑫ of the request decision order: the user-side step-up check of the four x-step-up
// operations (规划/08 BR-ID-08, BR-ID-01 判定顺序 ⑫ 10003; 04 §5 step-up row; 02 §18
// step_up_token row; task B1-02y, orchestrator ruling §9.3). Skeleton of the rule-test stage: the
// names and shapes below are the contract the rule tests in test/spec/identity/step-up-verify/**
// use; the bodies are the implementer's.
//
// When: only on the four x-step-up operations, keyed by the idempotent request's method and path
// (a fixed copy of 04 §5): POST /v1/withdrawals → withdraw, PUT /v1/me/payout-account →
// payout_account_change, POST /v1/me/phone → phone_change (only when the account already has a
// bound phone, read on the claim's transaction: a first binding needs no token), POST
// /v1/me/deletion → account_deletion. Every other request passes untouched. Only in the
// idempotency post-miss phase: a replay (also of a request whose token has since expired or been
// consumed), 40901, 20901, 20903 and a missing / malformed Idempotency-Key (20001) never read,
// judge or reserve the token.
//
// What (any failure → 10003, HTTP 403, no data): header X-Step-Up-Token present; ES256 signature
// under the access token's keys and issuer, aud=step_up; exp judged on the injected Clock
// (now ≥ exp is expired: second 299 after issue passes, second 300 is 10003); the claims uid,
// app_id and device_id equal the request's verified principal (stage ②) and the verified device;
// action equals the operation's step_up_action; jti neither reserved nor consumed. The token is
// only compared against, never a source of identity. sid is not compared.
//
// One use (D12): a passing token is reserved atomically in Redis (SET … NX with the token's
// remaining lifetime); a reservation that is already taken → 10003. After the business: HTTP 2xx
// and code 0 → consumed (kept until exp); any other outcome (non-zero code, thrown error, rolled
// back transaction, a later stage refusing) → only this request's own reservation is released
// (compare and delete), so the token can be retried while it is valid. Redis unavailable while
// judging → 50001 and the business does not run; Redis failing while settling → one pino `warn`
// line, the response is unchanged. Logs never carry the token or its jti.
//
// Placement: app.module hands createStepUpCheck's result to RiskModule.forRoot's
// `beforeRateLimit` list, so it is judged after ④a and ⑤ and before ⑬.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import type {
  Clock,
  IdempotencyPostMissCheck,
  IdempotentResponse,
  RedisHandle,
  RootLogger,
  TokenPrincipal,
} from '../../platform/index.ts';
import type { TokenKeyProvider } from './access-tokens.ts';

/**
 * The HTTP side of one request as its controller holds it after stages ① ② ③: the Fastify request
 * itself (headers, the verified principal copied onto it by the token check).
 */
export interface StepUpHttpRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly principal?: TokenPrincipal;
}

export interface StepUpCheckOptions {
  /** The access token's keys (TOKEN_KEYS): the step_up_token is signed with them. */
  readonly keys: TokenKeyProvider;
  readonly clock: Clock;
  /** Null (no REDIS on the entry): every x-step-up request fails closed with 50001. */
  readonly redis: RedisHandle | null;
  readonly logger: RootLogger;
}

/**
 * Stage ⑫ as an idempotency post-miss check (registered through RiskModule's `beforeRateLimit`).
 * It reads the request's step-up context from the enclosing withStepUp call; an x-step-up request
 * judged outside any withStepUp call fails closed.
 */
export function createStepUpCheck(options: StepUpCheckOptions): IdempotencyPostMissCheck {
  void options;
  throw new Error('NotImplemented: createStepUpCheck');
}

/**
 * The entry for the business handlers of the four x-step-up operations: `execute` is the
 * controller's own idempotency.executeInTransaction call. Runs it with this request's step-up
 * context (what stage ⑫ judges), then settles a reservation stage ⑫ made: the response of source
 * 'handler' with HTTP 2xx and code 0 consumes the token; any other response or a rejection releases
 * this request's reservation (a rejection is rethrown unchanged). A replay or an envelope built by
 * the idempotency module made no reservation and settles nothing. The response is returned
 * unchanged.
 */
export function withStepUp(
  request: StepUpHttpRequest,
  execute: () => Promise<IdempotentResponse>,
): Promise<IdempotentResponse> {
  void request;
  void execute;
  throw new Error('NotImplemented: withStepUp');
}
