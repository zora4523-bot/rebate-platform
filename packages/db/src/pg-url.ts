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

// Parameter names whose value is a secret: the connection password, the client-key passphrase
// (`sslpassword`), the OAuth client secret and the PostgreSQL 18 pass-through SCRAM keys (libpq);
// the pg driver also accepts `password` and `sslpassword`.
const SECRET_NAMES = new Set([
  'password',
  'sslpassword',
  'oauth_client_secret',
  'scram_client_key',
  'scram_server_key',
]);

/**
 * True when a query or keyword parameter name is one of `SECRET_NAMES` (any case,
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
 * password and each secret query parameter (`SECRET_NAMES`; any case, percent-encoded name,
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
// A parameter name: letters, `_` or percent escapes.
const NAME = '(?:[A-Za-z_]|%[0-9A-Fa-f]{2})+';
// A parameter name not glued to a preceding name character, then `=`: query parameters of an
// embedded URL and libpq keyword/value strings (`host=… password=…`).
const PARAMETER = new RegExp(`(?<![A-Za-z0-9_%])(${NAME})\\s*=\\s*`, 'g');
// Where a plain (unquoted) URL query value ends: whitespace, `&` or `#`.
const QUERY_VALUE_END = /[\s&#]/;
// libpq connection keywords (lowercase, as libpq accepts them; PostgreSQL 18). A secret value is
// masked up to a place that is certainly the start of a new parameter: whitespace followed by one
// of these or a secret name and `=` (in a URL query also `&` followed by one), or the end of the
// text.
const LIBPQ_KEYWORDS = new Set([
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
  'oauth_client_id',
  'oauth_client_secret',
  'oauth_issuer',
  'oauth_scope',
  'options',
  'passfile',
  'password',
  'port',
  'replication',
  'require_auth',
  'requirepeer',
  'requiressl',
  'scram_client_key',
  'scram_server_key',
  'service',
  'servicefile',
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
  'uselibpqcompat',
]);
const NEXT_AFTER_SPACE = new RegExp(`\\s+(${NAME})\\s*=`, 'y');
const NEXT_AFTER_AMPERSAND = new RegExp(`&(${NAME})\\s*=`, 'y');
// A secret assignment right after a closing quote, separated by any run of whitespace and `&`
// (`'…'&sslpassword='…`, `'…' &password=…`, `'…'password=…`).
const GLUED_SECRET = new RegExp(`[\\s&]*(${NAME})\\s*=\\s*`, 'y');
// Text ending in a parameter assignment (`…&sslpassword=`), name not glued to a name character.
const ENDS_IN_ASSIGNMENT = new RegExp(`(?<![A-Za-z0-9_%])(${NAME})\\s*=\\s*$`);

function isQuote(char: string | undefined): boolean {
  return char === "'" || char === '"';
}

/**
 * True when a new parameter certainly starts at `index`: whitespace (in a URL query also `&`), then
 * a libpq keyword (`LIBPQ_KEYWORDS`, exact) or a secret name (`isSecretName`), then `=`.
 */
function parameterStartsAt(text: string, index: number, query: boolean): boolean {
  for (const next of query ? [NEXT_AFTER_SPACE, NEXT_AFTER_AMPERSAND] : [NEXT_AFTER_SPACE]) {
    next.lastIndex = index;
    const name = next.exec(text)?.[1];
    if (name !== undefined && (LIBPQ_KEYWORDS.has(name) || isSecretName(name))) {
      return true;
    }
  }
  return false;
}

/** True when `segment` (text inside quotes) ends in a secret assignment such as `&sslpassword=`. */
function endsInSecretAssignment(segment: string): boolean {
  const name = ENDS_IN_ASSIGNMENT.exec(segment)?.[1];
  return name !== undefined && isSecretName(name);
}

/**
 * Index just past the secret value that starts at `start`.
 *
 * A plain value in a URL query (parameter right after `?` or `&`, not quoted) ends at whitespace,
 * `&` or `#`, as URL parameters do. Every other value (libpq keyword/value form, or quoted) is read
 * by one scanner with two states:
 *
 * - unquoted: a backslash escapes the next character; the value ends only where a new parameter
 *   certainly starts (`parameterStartsAt`) or at the end of the text;
 * - quoted (remembering `'` or `"`): a backslash escapes the next character; only the same quote
 *   closes it, and nothing inside it ends the value.
 *
 * After a closing quote the value ends if a new parameter certainly starts there. Otherwise the
 * scanner stays inside the secret: a secret assignment after the quote, separated by nothing or
 * by any run of whitespace and `&` (`'…'&sslpassword='…`, `'…' &password=…`), is masked with it; a closing quote that really is the opening quote of such a glued assignment
 * (`'…\'&sslpassword='Tail …'`: the quote right after `sslpassword=`, or an empty `''`) opens a
 * new quoted part; any other glued text continues unquoted. So no malformed or adversarial
 * construction leaves a piece of a secret readable; at worst some text between the secret and the
 * next parameter is masked too.
 */
function valueEnd(text: string, start: number, query: boolean): number {
  let index = start;
  if (query && !isQuote(text[start])) {
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
  let quote = '';
  let segment = index;
  const open = (at: number): void => {
    quote = text[at] ?? '';
    index = at + 1;
    segment = index;
  };
  if (isQuote(text[index])) {
    open(index);
  }
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (quote === '') {
      if (parameterStartsAt(text, index, query)) {
        return index;
      }
      index++;
      continue;
    }
    if (char !== quote) {
      index++;
      continue;
    }
    // A closing quote.
    const closing = index;
    index++;
    if (index >= text.length || parameterStartsAt(text, index, query)) {
      return index;
    }
    GLUED_SECRET.lastIndex = index;
    const glued = GLUED_SECRET.exec(text);
    if (glued !== null && isSecretName(glued[1] ?? '')) {
      index = GLUED_SECRET.lastIndex;
      if (isQuote(text[index])) {
        open(index);
      } else {
        quote = '';
      }
      continue;
    }
    if (closing === segment || endsInSecretAssignment(text.slice(segment, closing))) {
      open(closing);
      continue;
    }
    quote = '';
  }
  return text.length;
}

/**
 * `text` with the value of every secret parameter (`SECRET_NAMES`) replaced by `***` (see
 * `valueEnd` for where a value ends). Every secret assignment is scanned from its own value start,
 * also one that lies inside an already masked value: the masked stretch then runs to the farther
 * of the two ends, so no reading of where a value ends leaves a piece of either secret readable.
 */
function maskPasswordParameters(text: string): string {
  let result = '';
  let done = 0;
  for (const match of text.matchAll(PARAMETER)) {
    if (!isSecretName(match[1] ?? '')) {
      continue;
    }
    const before = match.index > 0 ? text[match.index - 1] : '';
    const start = match.index + match[0].length;
    const end = valueEnd(text, start, before === '?' || before === '&');
    if (match.index < done) {
      done = Math.max(done, end);
      continue;
    }
    result += text.slice(done, start) + MASK;
    done = end;
  }
  return result + text.slice(done);
}

/**
 * `text` with every connection password masked: the password of each embedded
 * `scheme://user:password@host` URL, and the value of every secret parameter (`password`,
 * `sslpassword`, `oauth_client_secret`, `scram_client_key`, `scram_server_key`; query string or
 * keyword form; any case, percent-encoded name, repeated; quoted and backslash-escaped values
 * masked whole). For log lines and error messages.
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
