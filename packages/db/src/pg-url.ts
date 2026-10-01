// Connection-string helpers. Pure functions, no I/O.

export type PgUrlOverrides = {
  user?: string;
  password?: string;
  database?: string;
};

/**
 * Returns `base` with user, password and/or database replaced. Values are percent-encoded;
 * host, port and query parameters are kept.
 */
export function pgUrl(base: string, overrides: PgUrlOverrides): string {
  const url = new URL(base);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TypeError(`not a PostgreSQL connection URL (protocol ${url.protocol})`);
  }
  if (overrides.user !== undefined) {
    url.username = encodeURIComponent(overrides.user);
  }
  if (overrides.password !== undefined) {
    url.password = encodeURIComponent(overrides.password);
  }
  if (overrides.database !== undefined) {
    url.pathname = `/${encodeURIComponent(overrides.database)}`;
  }
  return url.toString();
}

export type PgUrlParts = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

/** Splits a connection URL into its parts (percent-decoded). The port defaults to 5432. */
export function parsePgUrl(value: string): PgUrlParts {
  const url = new URL(value);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TypeError(`not a PostgreSQL connection URL (protocol ${url.protocol})`);
  }
  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

/** The same URL with the password replaced by `***`, for log and error messages. */
export function redactPgUrl(value: string): string {
  const url = new URL(value);
  if (url.password !== '') {
    url.password = '***';
  }
  return url.toString();
}
