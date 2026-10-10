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

// Parameter names whose value is a secret: the connection password and the client-key passphrase
// (`sslpassword`), both accepted by libpq and by the pg driver.
const SECRET_NAMES = new Set(['password', 'sslpassword']);

/**
 * True when a query or keyword parameter name is `password` or `sslpassword` (any case,
 * percent-encoded).
 */
function isSecretName(raw: string): boolean {
  let name = raw.replace(/\+/g, ' ');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Malformed escapes: compare the raw text.
  }
  return SECRET_NAMES.has(name.trim().toLowerCase());
}

/**
 * The same URL with every secret replaced by `***`, for log and error messages: the userinfo
 * password and each `password` / `sslpassword` query parameter (any case, percent-encoded name,
 * repeated), which the pg driver also accepts. Other query parameters are kept as written.
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
        return isSecretName(name) ? `${name}=${MASK}` : pair;
      })
      .join('&');
  }
  return url.toString();
}

// `scheme://user:password@` anywhere in a text: the password part is replaced. The password runs
// to the LAST `@` of the same whitespace-free stretch, so a password with unencoded `@ / ? #` is
// masked whole (at worst the host part is masked too, never a piece of the password left).
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*):\S*@/gi;
// A parameter name (letters or percent escapes) not glued to a preceding name character, then `=`:
// query parameters of an embedded URL and libpq keyword/value strings (`host=… password=…`).
const PARAMETER = /(?<![A-Za-z0-9_%])((?:[A-Za-z]|%[0-9A-Fa-f]{2})+)\s*=\s*/g;
// Where a plain (unquoted) URL query value ends: whitespace, `&` or `#`.
const QUERY_VALUE_END = /[\s&#]/;
// libpq connection keywords (lowercase, as libpq accepts them). A secret value is masked up to a
// place that is certainly the start of a new parameter: whitespace followed by one of these and
// `=` (in a URL query also `&` followed by one), or the end of the text.
const LIBPQ_KEYWORDS = [
  'application_name',
  'channel_binding',
  'client_encoding',
  'connect_timeout',
  'dbname',
  'fallback_application_name',
  'gssdelegation',
  'gssencmode',
  'gsslib',
  'host',
  'hostaddr',
  'keepalives',
  'keepalives_count',
  'keepalives_idle',
  'keepalives_interval',
  'krbsrvname',
  'load_balance_hosts',
  'max_protocol_version',
  'min_protocol_version',
  'options',
  'passfile',
  'password',
  'port',
  'replication',
  'require_auth',
  'requirepeer',
  'service',
  'ssl_max_protocol_version',
  'ssl_min_protocol_version',
  'sslcert',
  'sslcertmode',
  'sslcompression',
  'sslcrl',
  'sslcrldir',
  'sslkey',
  'sslkeylogfile',
  'sslmode',
  'sslnegotiation',
  'sslpassword',
  'sslrootcert',
  'sslsni',
  'target_session_attrs',
  'tcp_user_timeout',
  'user',
];
const KEYWORDS = LIBPQ_KEYWORDS.join('|');
const NEXT_AFTER_SPACE = new RegExp(`\\s+(?:${KEYWORDS})\\s*=`, 'y');
const NEXT_AFTER_AMPERSAND = new RegExp(`&(?:${KEYWORDS})\\s*=`, 'y');

/** True when a new libpq parameter certainly starts at `index` (see `LIBPQ_KEYWORDS`). */
function parameterStartsAt(text: string, index: number, query: boolean): boolean {
  for (const next of query ? [NEXT_AFTER_SPACE, NEXT_AFTER_AMPERSAND] : [NEXT_AFTER_SPACE]) {
    next.lastIndex = index;
    if (next.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Index just past the secret value that starts at `start`.
 *
 * A plain value in a URL query (parameter right after `?` or `&`, not quoted) ends at whitespace,
 * `&` or `#`, as URL parameters do. Every other value (libpq keyword/value form, or quoted) is
 * masked up to the next place where a new parameter certainly starts (`parameterStartsAt`) or the
 * end of the text, so that no malformed or adversarial construction (escaped quotes, a second
 * password assignment glued into the value, text glued to the closing quote) leaves a piece of the
 * secret readable; at worst some text between the secret and the next parameter is masked too.
 * Within that: a backslash escapes the next character (an escaped space never ends the value),
 * and nothing inside the opening quoted part (up to its first unescaped closing quote) can end it.
 */
function valueEnd(text: string, start: number, query: boolean): number {
  const quote = text[start];
  const quoted = quote === "'" || quote === '"';
  let index = start;
  if (query && !quoted) {
    while (index < text.length) {
      const char = text[index] ?? '';
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (QUERY_VALUE_END.test(char)) {
        return index;
      }
      index++;
    }
    return text.length;
  }
  if (quoted) {
    index = start + 1;
    for (;;) {
      if (index >= text.length) {
        return text.length;
      }
      const char = text[index];
      index += char === '\\' ? 2 : 1;
      if (char === quote) {
        break;
      }
    }
  }
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (parameterStartsAt(text, index, query)) {
      return index;
    }
    index++;
  }
  return text.length;
}

/**
 * `text` with the value of every `password=` / `sslpassword=` parameter replaced by `***` (see
 * `valueEnd` for where a value ends). A password-looking assignment inside a masked value is
 * masked with it.
 */
function maskPasswordParameters(text: string): string {
  let result = '';
  let done = 0;
  for (const match of text.matchAll(PARAMETER)) {
    if (match.index < done || !isSecretName(match[1] ?? '')) {
      continue;
    }
    const before = match.index > 0 ? text[match.index - 1] : '';
    const start = match.index + match[0].length;
    result += text.slice(done, start) + MASK;
    done = valueEnd(text, start, before === '?' || before === '&');
  }
  return result + text.slice(done);
}

/**
 * `text` with every connection password masked: the password of each embedded
 * `scheme://user:password@host` URL, and the value of every `password=` and `sslpassword=`
 * parameter (query string or keyword form; any case, percent-encoded name, repeated; quoted
 * and backslash-escaped values masked whole). For log lines and error messages.
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
