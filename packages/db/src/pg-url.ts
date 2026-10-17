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

// The redaction below runs in linear time on any input. Every scan is a hand-written pass over
// UTF-16 code units (no backtracking regular expression), and the value scanner remembers the end
// it found for every state it passed through, so a secret assignment inside an already masked
// value never reads again text that an earlier scan has read.

const BACKSLASH = 0x5c;
const SINGLE_QUOTE = 0x27;
const DOUBLE_QUOTE = 0x22;
const AMPERSAND = 0x26;
const EQUALS = 0x3d;
const PERCENT = 0x25;
const UNDERSCORE = 0x5f;
const COLON = 0x3a;
const SLASH = 0x2f;
const QUESTION = 0x3f;
const HASH = 0x23;
const AT = 0x40;

/** True for the code units that `\s` matches in a JavaScript regular expression. */
function isSpace(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (code < 0xa0) return false;
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** `[A-Za-z]` */
function isLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHex(code: number): boolean {
  return isDigit(code) || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46);
}

/** `[A-Za-z0-9_%]`: the characters a parameter name may not follow. */
function isNameChar(code: number): boolean {
  return isLetter(code) || isDigit(code) || code === UNDERSCORE || code === PERCENT;
}

/** `[a-z0-9+.-]` in any case: the characters of a URL scheme. */
function isSchemeChar(code: number): boolean {
  return isLetter(code) || isDigit(code) || code === 0x2b || code === 0x2e || code === 0x2d;
}

function isQuoteCode(code: number): boolean {
  return code === SINGLE_QUOTE || code === DOUBLE_QUOTE;
}

/**
 * End of the parameter name `(?:[A-Za-z_]|%[0-9A-Fa-f]{2})+` read from `index`, or `index` when no
 * name starts there. The name syntax has a single reading, so the longest one is the only one.
 */
function nameEnd(text: string, index: number): number {
  let at = index;
  for (;;) {
    const code = text.charCodeAt(at);
    if (isLetter(code) || code === UNDERSCORE) {
      at++;
    } else if (
      code === PERCENT &&
      isHex(text.charCodeAt(at + 1)) &&
      isHex(text.charCodeAt(at + 2))
    ) {
      at += 3;
    } else {
      return at;
    }
  }
}

function skipSpace(text: string, index: number): number {
  let at = index;
  while (at < text.length && isSpace(text.charCodeAt(at))) at++;
  return at;
}

// Lengths of the shortest and longest secret name and of the longest libpq keyword. Decoding
// percent escapes and trimming only shorten a name, so a name shorter than the shortest secret
// name is never one; a name without `%` longer than the longest is not one either.
const SECRET_NAME_MIN = 8;
const SECRET_NAME_MAX = 19;
const KEYWORD_MAX = 25;
// A value scan that read more positions than this remembers its end for each of them.
const WALK_MEMO_AFTER = 64;

/** `isSecretName` for the parameter name (`NAME` syntax) at `text[from, to)`. */
function isSecretNameAt(text: string, from: number, to: number): boolean {
  const length = to - from;
  if (length < SECRET_NAME_MIN) {
    return false;
  }
  if (length <= SECRET_NAME_MAX) {
    const raw = text.slice(from, to);
    // Without `%` (a name has no `+` or whitespace) `isSecretName` only lowercases.
    return raw.includes('%') ? isSecretName(raw) : SECRET_NAMES.has(raw.toLowerCase());
  }
  const raw = text.slice(from, to);
  return raw.includes('%') && isSecretName(raw);
}

/**
 * True when a parameter assignment of a known name starts at `index`: a name (`NAME`), optional
 * whitespace and `=`, the name a libpq keyword (`LIBPQ_KEYWORDS`, exact) or a secret name.
 */
function assignsKnownName(text: string, index: number): boolean {
  const end = nameEnd(text, index);
  if (end === index || text.charCodeAt(skipSpace(text, end)) !== EQUALS) {
    return false;
  }
  return (
    (end - index <= KEYWORD_MAX && LIBPQ_KEYWORDS.has(text.slice(index, end))) ||
    isSecretNameAt(text, index, end)
  );
}

/**
 * `scheme://user:password@` anywhere in a text: the password part is replaced. The password runs
 * to the LAST `@` of the same whitespace-free stretch, so a password with unencoded `@ / ? #` is
 * masked whole (at worst the host part is masked too, never a piece of the password left).
 *
 * The same result as `text.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*):\S*@/gi, '$1:***@')`,
 * computed per `://`: a match can only start at a letter of the run of scheme characters right
 * before a `://` (all letters of that run are followed by the same rest, so the first one is the
 * leftmost start); after the `://` come a user part without whitespace and `/ ? # @ :`, a `:` and,
 * later in the same whitespace-free stretch, an `@` (the last one is taken). The next match is
 * searched from just after that `@`.
 */
function maskUrlCredentials(text: string): string {
  const length = text.length;
  let result = '';
  let searchFrom = 0;
  // The whitespace-free stretch last read (from a `:` on): its end and its last `@` (-1: none).
  let stretchEnd = -1;
  let stretchLastAt = -1;
  for (let separator = text.indexOf('://'); separator >= 0;) {
    let schemeStart = -1;
    for (let at = separator - 1; at >= searchFrom; at--) {
      const code = text.charCodeAt(at);
      if (!isSchemeChar(code)) break;
      if (isLetter(code)) schemeStart = at;
    }
    let colon = separator + 3;
    if (schemeStart >= 0) {
      for (; colon < length; colon++) {
        const code = text.charCodeAt(colon);
        if (
          code === COLON ||
          code === SLASH ||
          code === QUESTION ||
          code === HASH ||
          code === AT ||
          isSpace(code)
        ) {
          break;
        }
      }
    }
    if (schemeStart >= 0 && text.charCodeAt(colon) === COLON) {
      if (colon >= stretchEnd) {
        // The stretch from this colon on (an earlier stretch ended before it).
        stretchLastAt = -1;
        let at = colon + 1;
        for (; at < length; at++) {
          const code = text.charCodeAt(at);
          if (code === AT) {
            stretchLastAt = at;
          } else if (isSpace(code)) {
            break;
          }
        }
        stretchEnd = at;
      }
      if (stretchLastAt > colon) {
        result += `${text.slice(searchFrom, colon)}:${MASK}@`;
        searchFrom = stretchLastAt + 1;
        separator = text.indexOf('://', searchFrom);
        continue;
      }
    }
    separator = text.indexOf('://', separator + 1);
  }
  return searchFrom === 0 ? text : result + text.slice(searchFrom);
}

/**
 * Where secret values end (`valueEnd`), for one text. A scan moves through a few kinds of state
 * (plain URL query value, unquoted value, inside a quoted part, quoted part just opened); the rest
 * of a scan depends only on its state, so the end found from a state is remembered, and a later
 * scan reaching a remembered state takes the known end. So every position is read a bounded number
 * of times however many secret assignments overlap.
 *
 * Unquoted and plain query values are remembered per position, in a table allocated once a scan
 * has read more than `WALK_MEMO_AFTER` positions (shorter scans cost at most that each); quoted
 * parts are remembered per quote position.
 */
class ValueScanner {
  private readonly text: string;
  private readonly length: number;
  // `parameterStartsAt` per position: 1 no, 2 whitespace before a known assignment, 3 `&` before
  // one.
  private starts: Uint8Array | undefined;
  // End of a plain query value (0) or an unquoted value (1, 2: in a URL query) read from a
  // position, plus 1; 0 while unknown.
  private readonly walkMemo: (Int32Array | undefined)[] = [undefined, undefined, undefined];
  // End of a value whose quoted part was just opened at a position (outside, inside a URL query).
  private readonly openMemo = [new Map<number, number>(), new Map<number, number>()] as const;
  // Per quote position: the closing quote a quoted part of that kind reaching it ends at.
  private readonly singleClose = new Map<number, number>();
  private readonly doubleClose = new Map<number, number>();
  private readonly passed: number[] = [];
  // Per closing quote: the glued secret assignment after it (value start, -1: none) and whether
  // the quoted part before it ends in a secret assignment.
  private readonly gluedMemo = new Map<number, number>();
  private readonly endsMemo = new Map<number, boolean>();
  private readonly chain: number[] = [];

  constructor(text: string) {
    this.text = text;
    this.length = text.length;
  }

  /**
   * Records `end` for every position a scan passed from `start` up to (not including) `stop`,
   * stepping as the scans do (two after a backslash, else one), once the scan was long.
   */
  private remember(kind: number, start: number, stop: number, end: number): void {
    if (stop - start <= WALK_MEMO_AFTER) {
      return;
    }
    const { text } = this;
    const memo = (this.walkMemo[kind] ??= new Int32Array(this.length + 1));
    for (let index = start; index < stop;) {
      memo[index] = end + 1;
      index += text.charCodeAt(index) === BACKSLASH ? 2 : 1;
    }
  }

  /**
   * True when a new parameter certainly starts at `index`: whitespace (in a URL query also `&`),
   * then a libpq keyword (`LIBPQ_KEYWORDS`, exact) or a secret name (`isSecretName`), then `=`.
   * A whitespace run is decided once for all its positions.
   */
  private startsAt(index: number, query: boolean): boolean {
    const { text } = this;
    const code = text.charCodeAt(index);
    const space = isSpace(code);
    if (!space && !(query && code === AMPERSAND)) {
      return false;
    }
    const starts = (this.starts ??= new Uint8Array(this.length));
    let known = starts[index] ?? 0;
    if (known === 0) {
      if (space) {
        let first = index;
        while (first > 0 && isSpace(text.charCodeAt(first - 1))) first--;
        const next = skipSpace(text, index);
        known = next < this.length && assignsKnownName(text, next) ? 2 : 1;
        starts.fill(known, first, next);
      } else {
        known = assignsKnownName(text, index + 1) ? 3 : 1;
        starts[index] = known;
      }
    }
    return known === 2 || known === 3;
  }

  /**
   * Index just past the secret value that starts at `start`.
   *
   * A plain value in a URL query (parameter right after `?` or `&`, not quoted) ends at
   * whitespace, `&` or `#`, as URL parameters do. Every other value (libpq keyword/value form, or
   * quoted) is read by one scanner with two states:
   *
   * - unquoted: a backslash escapes the next character; the value ends only where a new parameter
   *   certainly starts (`startsAt`) or at the end of the text;
   * - quoted (remembering `'` or `"`): a backslash escapes the next character; only the same quote
   *   closes it, and nothing inside it ends the value.
   *
   * After a closing quote the value ends if a new parameter certainly starts there. Otherwise the
   * scanner stays inside the secret: a secret assignment after the quote, separated by nothing or
   * by any run of whitespace and `&` (`'…'&sslpassword='…`, `'…' &password=…`), is masked with it;
   * a closing quote that really is the opening quote of such a glued assignment
   * (`'…\'&sslpassword='Tail …'`: the quote right after `sslpassword=`, or an empty `''`) opens a
   * new quoted part; any other glued text continues unquoted. So no malformed or adversarial
   * construction leaves a piece of a secret readable; at worst some text between the secret and the
   * next parameter is masked too.
   */
  valueEnd(start: number, query: boolean): number {
    const quoted = isQuoteCode(this.text.charCodeAt(start));
    if (query && !quoted) {
      return this.queryValueEnd(start);
    }
    return quoted ? this.openedEnd(start + 1, query) : this.plainEnd(start, query);
  }

  /** A plain URL query value read from `start`: ends at whitespace, `&` or `#`. */
  private queryValueEnd(start: number): number {
    const { text, length } = this;
    const memo = this.walkMemo[0];
    let index = start;
    let end: number;
    for (;;) {
      if (index >= length) {
        end = length;
        break;
      }
      const known = memo === undefined ? 0 : (memo[index] ?? 0);
      if (known !== 0) {
        end = known - 1;
        break;
      }
      const code = text.charCodeAt(index);
      if (code === BACKSLASH) {
        index += 2;
      } else if (code === AMPERSAND || code === HASH || isSpace(code)) {
        end = index;
        break;
      } else {
        index++;
      }
    }
    this.remember(0, start, index, end);
    return end;
  }

  /** An unquoted value read from `start`: ends where a new parameter certainly starts. */
  private plainEnd(start: number, query: boolean): number {
    const { text, length } = this;
    const kind = query ? 2 : 1;
    const memo = this.walkMemo[kind];
    let index = start;
    let end: number;
    for (;;) {
      if (index >= length) {
        end = length;
        break;
      }
      const known = memo === undefined ? 0 : (memo[index] ?? 0);
      if (known !== 0) {
        end = known - 1;
        break;
      }
      if (text.charCodeAt(index) === BACKSLASH) {
        index += 2;
      } else if (this.startsAt(index, query)) {
        end = index;
        break;
      } else {
        index++;
      }
    }
    this.remember(kind, start, index, end);
    return end;
  }

  /**
   * The closing quote of a quoted part read from `start`, of the same kind as `text[start - 1]`
   * (`length` when there is none).
   *
   * The scan steps one character at a time, two after a backslash. `text[start - 1]` is a quote,
   * so a backslash run never begins before `start` and the scan lands on the first backslash of
   * every run: a quote is skipped exactly when the backslash run right before it has odd length,
   * whichever quoted part the scan came from. The answer for a quote position therefore never
   * changes; it is remembered for each quote position passed.
   */
  private closingQuote(start: number): number {
    const { text, length } = this;
    const quote = text.charCodeAt(start - 1);
    const memo = quote === SINGLE_QUOTE ? this.singleClose : this.doubleClose;
    const quoteText = quote === SINGLE_QUOTE ? "'" : '"';
    const passed = this.passed;
    passed.length = 0;
    let closing = text.indexOf(quoteText, start);
    for (;;) {
      if (closing < 0) {
        closing = length;
        break;
      }
      const known = memo.get(closing);
      if (known !== undefined) {
        closing = known;
        break;
      }
      passed.push(closing);
      let backslashes = closing;
      while (text.charCodeAt(backslashes - 1) === BACKSLASH) backslashes--;
      if (((closing - backslashes) & 1) === 0) {
        break;
      }
      closing = text.indexOf(quoteText, closing + 1);
    }
    for (const at of passed) {
      memo.set(at, closing);
    }
    return closing;
  }

  /**
   * End of a value whose quoted part was just opened: `start` is just past the opening quote. A
   * chain of quoted parts (glued assignments, reopened quotes) is followed in a loop, and every
   * part start on it remembers the end.
   */
  private openedEnd(start: number, query: boolean): number {
    const { text, length, chain } = this;
    const memo = this.openMemo[query ? 1 : 0];
    chain.length = 0;
    let index = start;
    let end: number;
    for (;;) {
      if (index >= length) {
        end = length;
        break;
      }
      const known = memo.get(index);
      if (known !== undefined) {
        end = known;
        break;
      }
      chain.push(index);
      const closing = this.closingQuote(index);
      if (closing >= length) {
        end = length;
        break;
      }
      const after = closing + 1;
      if (after >= length || this.startsAt(after, query)) {
        end = after;
        break;
      }
      const glued = this.gluedSecret(closing);
      if (glued >= 0) {
        if (isQuoteCode(text.charCodeAt(glued))) {
          index = glued + 1;
          continue;
        }
        end = this.plainEnd(glued, query);
        break;
      }
      if (closing === index || this.endsInSecretAssignment(closing)) {
        // The closing quote opens a new quoted part.
        index = after;
        continue;
      }
      end = this.plainEnd(after, query);
      break;
    }
    for (const at of chain) {
      memo.set(at, end);
    }
    return end;
  }

  /**
   * A secret assignment glued to the closing quote at `closing`, separated by any run of
   * whitespace and `&` (`'…'&sslpassword='…`, `'…' &password=…`, `'…'password=…`): the index just
   * past its `=` and the whitespace after it, or -1.
   */
  private gluedSecret(closing: number): number {
    const known = this.gluedMemo.get(closing);
    if (known !== undefined) {
      return known;
    }
    const { text, length } = this;
    let index = closing + 1;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code !== AMPERSAND && !isSpace(code)) break;
      index++;
    }
    const end = nameEnd(text, index);
    let result = -1;
    if (end > index) {
      const equals = skipSpace(text, end);
      if (text.charCodeAt(equals) === EQUALS && isSecretNameAt(text, index, end)) {
        result = skipSpace(text, equals + 1);
      }
    }
    this.gluedMemo.set(closing, result);
    return result;
  }

  /**
   * True when the quoted part that closes at `closing` ends in a secret assignment such as
   * `&sslpassword=`: a name not glued to a preceding name character, optional whitespace, `=` and
   * optional whitespace. Read right to left; the opening quote of the part is none of these
   * characters, so the reading never leaves the part.
   */
  private endsInSecretAssignment(closing: number): boolean {
    const known = this.endsMemo.get(closing);
    if (known !== undefined) {
      return known;
    }
    const { text } = this;
    let index = closing - 1;
    while (index >= 0 && isSpace(text.charCodeAt(index))) index--;
    let result = false;
    if (index >= 0 && text.charCodeAt(index) === EQUALS) {
      index--;
      while (index >= 0 && isSpace(text.charCodeAt(index))) index--;
      const end = index + 1;
      while (index >= 0 && isNameChar(text.charCodeAt(index))) index--;
      const begin = index + 1;
      // The name starts at that boundary and reads exactly up to `end`.
      result = begin < end && nameEnd(text, begin) === end && isSecretNameAt(text, begin, end);
    }
    this.endsMemo.set(closing, result);
    return result;
  }
}

/**
 * `text` with the value of every secret parameter (`SECRET_NAMES`) replaced by `***` (see
 * `ValueScanner.valueEnd` for where a value ends). Every secret assignment is scanned from its own
 * value start, also one that lies inside an already masked value: the masked stretch then runs to
 * the farther of the two ends, so no reading of where a value ends leaves a piece of either secret
 * readable.
 *
 * A parameter assignment (query parameters of an embedded URL and libpq keyword/value strings,
 * `host=… password=…`) is a name `(?:[A-Za-z_]|%[0-9A-Fa-f]{2})+` not glued to a preceding
 * `[A-Za-z0-9_%]`, optional whitespace, `=` and optional whitespace; the next one is searched from
 * the end of the previous one. Each `=` belongs to at most one assignment, read right to left from
 * it.
 */
function maskPasswordParameters(text: string): string {
  let scanner: ValueScanner | undefined;
  let result = '';
  let done = 0;
  let searchFrom = 0;
  for (let equals = text.indexOf('='); equals >= 0;) {
    let nameStop = equals;
    while (nameStop > searchFrom && isSpace(text.charCodeAt(nameStop - 1))) nameStop--;
    let match = nameStop;
    while (match > searchFrom && isNameChar(text.charCodeAt(match - 1))) match--;
    if (
      match === nameStop ||
      (match > 0 && isNameChar(text.charCodeAt(match - 1))) ||
      nameEnd(text, match) !== nameStop
    ) {
      equals = text.indexOf('=', equals + 1);
      continue;
    }
    const start = skipSpace(text, equals + 1);
    searchFrom = start;
    equals = text.indexOf('=', start);
    if (!isSecretNameAt(text, match, nameStop)) {
      continue;
    }
    scanner ??= new ValueScanner(text);
    const before = match > 0 ? text.charCodeAt(match - 1) : -1;
    const end = scanner.valueEnd(start, before === QUESTION || before === AMPERSAND);
    if (match < done) {
      done = Math.max(done, end);
      continue;
    }
    result += text.slice(done, start) + MASK;
    done = end;
  }
  return scanner === undefined ? text : result + text.slice(done);
}

/**
 * `text` with every connection password masked: the password of each embedded
 * `scheme://user:password@host` URL, and the value of every secret parameter (`password`,
 * `sslpassword`, `oauth_client_secret`, `scram_client_key`, `scram_server_key`; query string or
 * keyword form; any case, percent-encoded name, repeated; quoted and backslash-escaped values
 * masked whole). For log lines and error messages; linear in the length of `text`.
 */
export function redactCredentials(text: string): string {
  return maskPasswordParameters(maskUrlCredentials(text));
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
