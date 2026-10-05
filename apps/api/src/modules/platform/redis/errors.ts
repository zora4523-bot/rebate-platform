// Errors of platform/redis (B1-01y §9.2, §10). Messages are fixed texts: they never carry the
// driver error, a key, a value or the URL, and there is no `cause`.

/** A call that cannot reach Redis: bad TTL, namespace, key, value, script, option or URL. */
export class RedisValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisValidationError';
  }
}

export type RedisUnavailableReason =
  | 'connect_failed'
  | 'connect_timeout'
  | 'command_failed'
  | 'command_timeout'
  | 'unexpected_reply'
  | 'closed';

/**
 * Redis could not answer this command (connection, timeout, error reply). The outcome of a
 * command that was sent is unknown; the caller decides whether to reject or fall back.
 */
export class RedisUnavailableError extends Error {
  readonly reason: RedisUnavailableReason;
  /** Redis error prefix (WRONGTYPE, OOM, …) or socket code (ECONNREFUSED, …); else null. */
  readonly code: string | null;

  constructor(reason: RedisUnavailableReason, code: string | null = null) {
    super(
      code === null ? `Redis unavailable: ${reason}` : `Redis unavailable: ${reason} (${code})`,
    );
    this.name = 'RedisUnavailableError';
    this.reason = reason;
    this.code = code;
  }
}

/** The handle was closed (application shutdown); nothing is sent any more. */
export class RedisClosedError extends RedisUnavailableError {
  constructor() {
    super('closed');
    this.name = 'RedisClosedError';
  }
}
