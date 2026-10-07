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

const MASK = '***';

/** True when a query or keyword parameter name means `password` (any case, percent-encoded). */
function isPasswordName(raw: string): boolean {
  let name = raw.replace(/\+/g, ' ');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Malformed escapes: compare the raw text.
  }
  return name.trim().toLowerCase() === 'password';
}

/**
 * The same URL with every password replaced by `***`, for log and error messages: the userinfo
 * password and each `password` query parameter (any case, percent-encoded name, repeated), which
 * the pg driver also accepts. Other query parameters are kept as written.
 */
export function redactPgUrl(value: string): string {
  const url = new URL(value);
  if (url.password !== '') {
    url.password = MASK;
  }
  if (url.search !== '') {
    url.search = url.search
      .slice(1)
      .split('&')
      .map((pair) => {
        const split = pair.indexOf('=');
        const name = split < 0 ? pair : pair.slice(0, split);
        return isPasswordName(name) ? `${name}=${MASK}` : pair;
      })
      .join('&');
  }
  return url.toString();
}

// `scheme://user:password@` anywhere in a text: the password part is replaced.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*):[^\s/?#@]*@/gi;
// A parameter name (letters or percent escapes) not glued to a preceding name character, then `=`:
// query parameters of an embedded URL and libpq keyword/value strings (`host=… password=…`).
const PARAMETER = /(?<![A-Za-z0-9_%])((?:[A-Za-z]|%[0-9A-Fa-f]{2})+)\s*=\s*/g;
// An unquoted value ends at whitespace, `&`, `#` or `;`; everything up to there is masked.
const VALUE_END = /[\s&#;]/;

/** `text` with the value of every `password=` parameter replaced by `***`. */
function maskPasswordParameters(text: string): string {
  let result = '';
  let done = 0;
  for (const match of text.matchAll(PARAMETER)) {
    if (match.index < done || !isPasswordName(match[1] ?? '')) {
      continue;
    }
    const start = match.index + match[0].length;
    let end = start;
    const quote = text[start];
    if (quote === "'" || quote === '"') {
      const close = text.indexOf(quote, start + 1);
      end = close < 0 ? text.length : close + 1;
    } else {
      while (end < text.length && !VALUE_END.test(text[end] ?? '')) {
        end++;
      }
    }
    result += text.slice(done, start) + MASK;
    done = end;
  }
  return result + text.slice(done);
}

/**
 * `text` with every connection password masked: the password of each embedded
 * `scheme://user:password@host` URL, and the value of every `password=` parameter (query string or
 * keyword form; any case, percent-encoded name, repeated). For log lines and error messages.
 */
export function redactCredentials(text: string): string {
  return maskPasswordParameters(text.replace(URL_CREDENTIALS, `$1:${MASK}@`));
}

/**
 * A one-line description of a thrown value that is safe to print: the error name, its `code`
 * when it is a short identifier, and the message with every connection password masked. The raw
 * object is never described, because Node and driver errors carry the connection string in fields
 * such as `input` (ERR_INVALID_URL), `cause` and the stack.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return `非 Error 异常（${typeof error}）`;
  }
  const code = (error as { code?: unknown }).code;
  const tag =
    typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code)
      ? `${error.name} [${code}]`
      : error.name;
  return `${tag}: ${redactCredentials(error.message)}`;
}
