import { expect, it } from 'vitest';

import { describeError, parsePgUrl, pgUrl, redactCredentials, redactPgUrl } from './pg-url.ts';

const BASE = 'postgres://postgres:secret@127.0.0.1:54329/postgres';

it('pgUrl replaces user, password and database and keeps host and port', () => {
  expect(pgUrl(BASE, { user: 'couli_app', password: 'pw', database: 'couli' })).toBe(
    'postgres://couli_app:pw@127.0.0.1:54329/couli',
  );
  expect(pgUrl(BASE, { database: 'couli_tpl_ab12' })).toBe(
    'postgres://postgres:secret@127.0.0.1:54329/couli_tpl_ab12',
  );
});

it('pgUrl percent-encodes reserved characters and parsePgUrl decodes them again', () => {
  const url = pgUrl(BASE, { user: 'couli_app', password: 'p@ss:w/rd#1 ?', database: 'couli' });
  expect(url).toBe('postgres://couli_app:p%40ss%3Aw%2Frd%231%20%3F@127.0.0.1:54329/couli');
  expect(parsePgUrl(url)).toEqual({
    host: '127.0.0.1',
    port: 54329,
    user: 'couli_app',
    password: 'p@ss:w/rd#1 ?',
    database: 'couli',
  });
});

it('parsePgUrl defaults the port to 5432 and keeps query parameters out of the database', () => {
  expect(parsePgUrl('postgresql://u:p@db.internal/couli?sslmode=require')).toEqual({
    host: 'db.internal',
    port: 5432,
    user: 'u',
    password: 'p',
    database: 'couli',
  });
  expect(pgUrl('postgresql://u:p@db.internal/couli?sslmode=require', { user: 'v' })).toBe(
    'postgresql://v:p@db.internal/couli?sslmode=require',
  );
});

it('rejects URLs that are not PostgreSQL URLs', () => {
  expect(() => pgUrl('https://example.invalid/x', { user: 'a' })).toThrow(TypeError);
  expect(() => parsePgUrl('redis://127.0.0.1:6379')).toThrow(TypeError);
});

it('redactPgUrl hides the password only', () => {
  expect(redactPgUrl(BASE)).toBe('postgres://postgres:***@127.0.0.1:54329/postgres');
  expect(redactPgUrl('postgres://127.0.0.1/postgres')).toBe('postgres://127.0.0.1/postgres');
});

it('redactPgUrl also masks every password query parameter, in any case or encoding', () => {
  expect(redactPgUrl('postgres://couli_migrator@db/couli?password=ExampleOnly123')).toBe(
    'postgres://couli_migrator@db/couli?password=***',
  );
  const masked = redactPgUrl(
    'postgresql://u:pw1@db:5433/couli?sslmode=verify-ca&PASSWORD=pw2&sslrootcert=/etc/pki/ca.crt&Password=pw3&pass%77ord=pw4&password',
  );
  expect(masked).toBe(
    'postgresql://u:***@db:5433/couli?sslmode=verify-ca&PASSWORD=***&sslrootcert=/etc/pki/ca.crt&Password=***&pass%77ord=***&password=***',
  );
  for (const secret of ['pw1', 'pw2', 'pw3', 'pw4']) expect(masked).not.toContain(secret);
  expect(redactPgUrl('postgres://u@db/couli?sslmode=require&passwords=kept')).toBe(
    'postgres://u@db/couli?sslmode=require&passwords=kept',
  );
});

it('redactCredentials masks URL passwords and password parameters inside any text', () => {
  const text =
    '连接失败 postgres://a:pw1@h:5433/db?password=pw2&PassWord=pw3 与 redis://:pw4@10.0.0.1:6379 ' +
    "以及 host=db user=u password='pw 5' dbname=couli；password = pw6 sslmode=require";
  const masked = redactCredentials(text);
  for (const secret of ['pw1', 'pw2', 'pw3', 'pw4', 'pw 5', 'pw6']) {
    expect(masked).not.toContain(secret);
  }
  expect(masked).toContain('postgres://a:***@h:5433/db?password=***&PassWord=***');
  expect(masked).toContain('redis://:***@10.0.0.1:6379');
  expect(masked).toContain('sslmode=require');
  expect(redactCredentials('plain text, no secret')).toBe('plain text, no secret');
});

it('describeError prints the name, a short code and the masked message, never the input', () => {
  let invalid: unknown;
  try {
    new URL('postgres://u:SuperSecret1@h:5433x/db');
  } catch (error) {
    invalid = error;
  }
  const described = describeError(invalid);
  expect(described).toMatch(/^TypeError \[ERR_INVALID_URL\]: /);
  expect(described).not.toContain('SuperSecret1');
  expect(
    describeError(
      new Error('connect postgres://u:SuperSecret2@h/db?password=SuperSecret3', {
        cause: new Error('postgres://u:SuperSecret4@h/db'),
      }),
    ),
  ).toBe('Error: connect postgres://u:***@h/db?password=***');
  expect(
    describeError(new AggregateError([new Error('postgres://u:SuperSecret5@h/db')], 'x')),
  ).toBe('AggregateError: x');
  const odd = Object.assign(new Error('boom'), { code: 'postgres://u:SuperSecret6@h/db' });
  expect(describeError(odd)).toBe('Error: boom');
  expect(describeError('postgres://u:SuperSecret7@h/db')).toBe('非 Error 异常（string）');
});

it('redactPgUrl and redactCredentials also mask sslpassword, in any case, encoding or form', () => {
  const both = 'postgres://couli_migrator@db/couli?password=ExampleA1&sslpassword=ExampleB2';
  expect(redactPgUrl(both)).toBe('postgres://couli_migrator@db/couli?password=***&sslpassword=***');
  expect(redactCredentials(both)).toBe(
    'postgres://couli_migrator@db/couli?password=***&sslpassword=***',
  );
  const variants = redactPgUrl(
    'postgresql://u@db/couli?SSLPassword=ExampleC3&sslmode=verify-ca&ssl%70assword=ExampleD4&sslpassword=ExampleE5',
  );
  expect(variants).toBe(
    'postgresql://u@db/couli?SSLPassword=***&sslmode=verify-ca&ssl%70assword=***&sslpassword=***',
  );
  const keywords = redactCredentials(
    "host=db sslpassword=ExampleF6 sslkey=/k.pem SSLPASSWORD='Example G7' password=ExampleH8",
  );
  for (const secret of ['ExampleA1', 'ExampleB2', 'ExampleC3', 'ExampleD4', 'ExampleE5']) {
    expect(variants + redactCredentials(both)).not.toContain(secret);
  }
  for (const secret of ['ExampleF6', 'Example G7', 'ExampleH8']) {
    expect(keywords).not.toContain(secret);
  }
  expect(keywords).toContain('sslkey=/k.pem');
  expect(redactCredentials('sslpasswords=kept mysslpassword=kept')).toBe(
    'sslpasswords=kept mysslpassword=kept',
  );
});

it('redactCredentials masks a URL password with unencoded @ / ? # as a whole', () => {
  const cases = [
    ['postgres://u:Sec@ret16@h/db', 'Sec', 'ret16'],
    ['postgresql://u:S/ecret17@h/db', 'S/ecret17', 'ecret17'],
    ['postgres://u:Sec#ret22@h/db', 'Sec#ret22', 'ret22'],
    ['postgres://u:Sec?ret23@h/db', 'Sec?ret23', 'ret23'],
    ['postgres://u:A@b/c?d#e@h:5433/db?sslmode=require', 'A@b', 'c?d#e'],
  ] as const;
  for (const [url, ...parts] of cases) {
    const masked = redactCredentials(`连接失败 ${url} 已重试`);
    expect(masked).toMatch(/^连接失败 postgres(?:ql)?:\/\/u:\*\*\*@h/);
    expect(masked).toMatch(/ 已重试$/);
    for (const part of parts) expect(masked).not.toContain(part);
  }
  expect(redactPgUrl('postgres://u:Sec@ret16@h/db')).toBe('postgres://u:***@h/db');
  expect(redactCredentials('postgres://u@h/db and x@y')).toBe('postgres://u@h/db and x@y');
});

it('redactCredentials masks libpq values with backslash escapes as a whole', () => {
  const quoted = ['ExampleLeft', 'ExampleRight tail'].join("\\'");
  expect(redactCredentials(`host=db password='${quoted}' dbname=couli`)).toBe(
    'host=db password=*** dbname=couli',
  );
  // Unquoted: `\ ` is an escaped space, so the password is "ExampleOne ExampleTwo".
  const unquoted = 'host=db password=ExampleOne\\ ExampleTwo dbname=couli';
  const masked = redactCredentials(unquoted);
  expect(masked).toBe('host=db password=*** dbname=couli');
  for (const part of ['ExampleOne', 'ExampleTwo']) expect(masked).not.toContain(part);
  expect(redactCredentials('sslpassword=ExampleA\\ B\\\\ host=db')).toBe('sslpassword=*** host=db');
  // A trailing lone backslash or an unterminated quote masks to the end, never less.
  expect(redactCredentials('host=db password=ExampleEnd\\')).toBe('host=db password=***');
  expect(redactCredentials("host=db password='ExampleOpen\\' rest")).toBe('host=db password=***');
  // Values without backslashes behave as before.
  expect(redactCredentials('host=db password=ExamplePlain dbname=couli')).toBe(
    'host=db password=*** dbname=couli',
  );
});

it('redactCredentials ends an unquoted libpq value only at whitespace, a query value also at & #', () => {
  // libpq keyword/value: `;`, `&` and `#` belong to the value; the password is "Head Mid;Tail".
  const masked = redactCredentials('host=db password=Head\\ Mid;Tail dbname=couli');
  expect(masked).toBe('host=db password=*** dbname=couli');
  for (const part of ['Head', 'Mid', 'Tail', ';']) expect(masked).not.toContain(part);
  expect(redactCredentials('host=db password=ExampleA&B#C;D sslmode=require')).toBe(
    'host=db password=*** sslmode=require',
  );
  expect(redactCredentials('connect failed; password=ExampleSemi;colon')).toBe(
    'connect failed; password=***',
  );
  // URL query: `&` and `#` still separate parameters; `;` belongs to the value.
  expect(redactCredentials('postgres://u@h/db?password=ExampleQ;R&sslmode=require#frag')).toBe(
    'postgres://u@h/db?password=***&sslmode=require#frag',
  );
});

it('redactCredentials masks a secret up to the next certain parameter start, whatever is glued in', () => {
  const cases: [string, string][] = [
    // Review round 1: an escaped quote, then a second password assignment glued in.
    [
      String.raw`host=db password='ExampleHead\'&sslpassword='ExampleTail' dbname=couli`,
      'host=db password=*** dbname=couli',
    ],
    // Review round 2: an empty quoted string glued in front of the rest.
    [
      String.raw`host=db password='ExampleHead\'&sslpassword=''ExampleTail' dbname=couli`,
      'host=db password=*** dbname=couli',
    ],
    // A password that ends in `sslpassword=`: the `sslpassword` assignment is scanned from its own
    // value start too (its quote opens a value that never closes), so the rest is masked.
    ["password='ExampleHead&sslpassword=' host=db.invalid dbname=couli", 'password=***'],
    // Review round 3: a space and more secret text after the glued quote.
    [
      String.raw`host=db password='ExampleHead\'&sslpassword='ExampleTail ExampleSuffix' dbname=couli`,
      'host=db password=*** dbname=couli',
    ],
    // A keyword inside the opening quoted part does not end the value.
    ["password='ExampleA host=ExampleB' dbname=couli", 'password=*** dbname=couli'],
    [
      "host=db password='ExampleA&password=ExampleB c' dbname=couli",
      'host=db password=*** dbname=couli',
    ],
    // Chained glued assignments.
    [
      String.raw`password='ExampleOne\'&password='ExampleTwo\'&sslpassword='ExampleThree' port=5432`,
      'password=*** port=5432',
    ],
    // Text that is not a known parameter is masked with the secret.
    [
      'host=db password=ExampleSecret ExampleMore dbname=couli',
      'host=db password=*** dbname=couli',
    ],
    // libpq skips spaces after `=`: here the password is the text `host=db`.
    ['password= host=ExampleNotHost port=5432', 'password= *** port=5432'],
    // A quoted value in a URL query ends at `&` followed by a known parameter.
    [
      "postgres://u@h/db?password='ExampleQ&x'&sslmode=require",
      'postgres://u@h/db?password=***&sslmode=require',
    ],
  ];
  for (const [input, expected] of cases) {
    expect(redactCredentials(input)).toBe(expected);
  }
});

it('redactCredentials keeps masking when a closing quote is glued to another secret assignment', () => {
  const cases: [string, string][] = [
    // The quote right after `sslpassword=` closes the first value and opens the glued one.
    [
      String.raw`password='ExampleHead\'&sslpassword='ExampleTail host=ExampleSuffix' dbname=couli`,
      'password=*** dbname=couli',
    ],
    // An even backslash run closes the first value; the glued assignment opens a new one.
    [
      String.raw`password='ExampleHead\\'&SSLPassword = 'ExampleTail host=ExampleSuffix\' port=ExamplePort' dbname=couli`,
      'password=*** dbname=couli',
    ],
    // Only the same kind of quote closes a value.
    [
      `password="ExampleHead' host=ExampleInner"&sslpassword='ExampleTail" host=ExampleSuffix' dbname=couli`,
      'password=*** dbname=couli',
    ],
    // An empty quoted part glued to more text: the text is masked as a quoted part as well.
    ["password=''ExampleTail host=ExampleSuffix' dbname=couli", 'password=*** dbname=couli'],
    // A URL query: the glued assignment is masked in the same way.
    [
      String.raw`postgres://u@h/db?password='ExampleHead\'&oauth_client_secret='ExampleTail host=ExampleSuffix' dbname=couli`,
      'postgres://u@h/db?password=*** dbname=couli',
    ],
  ];
  for (const [input, expected] of cases) {
    expect(redactCredentials(input)).toBe(expected);
  }
});

it('redactCredentials and redactPgUrl mask the OAuth client secret and the SCRAM keys', () => {
  expect(
    redactCredentials(
      'host=db oauth_client_secret=ExampleO1 OAUTH_CLIENT_SECRET=ExampleO2 ' +
        "scram_client_key=ExampleS1== scram%5Fserver%5Fkey='ExampleS2' oauth_client_id=public dbname=couli",
    ),
  ).toBe(
    'host=db oauth_client_secret=*** OAUTH_CLIENT_SECRET=*** scram_client_key=*** ' +
      'scram%5Fserver%5Fkey=*** oauth_client_id=public dbname=couli',
  );
  expect(
    redactPgUrl(
      'postgres://u@db/couli?oauth_client_secret=ExampleO3&SCRAM_CLIENT_KEY=ExampleS3&oauth_scope=openid',
    ),
  ).toBe('postgres://u@db/couli?oauth_client_secret=***&SCRAM_CLIENT_KEY=***&oauth_scope=openid');
  expect(redactCredentials('oauth_client_secrets=kept myscram_client_key=kept')).toBe(
    'oauth_client_secrets=kept myscram_client_key=kept',
  );
});

it('redactCredentials ends a secret at the PostgreSQL 18 keywords and at any secret name', () => {
  for (const field of [
    'servicefile=/x/pg_service.conf',
    'oauth_issuer=https://issuer.invalid',
    'oauth_client_id=public',
    'oauth_scope=openid',
    'requiressl=1',
    'uselibpqcompat=1',
    'PASSWORD=ExampleNext',
  ]) {
    const masked = redactCredentials(`host=db password=ExampleSecret ${field} port=5432`);
    expect(masked).not.toContain('ExampleSecret');
    expect(masked).toContain('port=5432');
    if (!field.startsWith('PASSWORD')) expect(masked).toContain(field);
  }
  expect(redactCredentials('password=ExampleSecret PASSWORD=ExampleNext port=5432')).toBe(
    'password=*** PASSWORD=*** port=5432',
  );
  // Inside a quoted value a known name is not a boundary.
  expect(redactCredentials("password='ExampleSecret requiressl=1' host=db")).toBe(
    'password=*** host=db',
  );
});

it('redactCredentials keeps masking when whitespace and & separate a closing quote from a secret', () => {
  for (const separator of [' &', '& ', ' & ', '\t&& ', '&&', '&']) {
    for (const prefix of ['', 'host=db ', 'postgres://u@h/db?']) {
      const input =
        `${prefix}password='ExampleHead'${separator}` +
        "sslpassword='ExampleTail host=ExampleSuffix' dbname=couli";
      const masked = redactCredentials(input);
      for (const part of ['ExampleHead', 'ExampleTail', 'ExampleSuffix']) {
        expect(masked).not.toContain(part);
      }
      expect(masked).toMatch(/password=\*\*\* dbname=couli$/);
      expect(masked.startsWith(`${prefix}password=***`)).toBe(true);
    }
  }
  expect(
    redactCredentials(
      "password='ExampleHead' &sslpassword='ExampleTail host=ExampleSuffix' dbname=couli",
    ),
  ).toBe('password=*** dbname=couli');
  // A plain space before the next secret is an ordinary boundary.
  expect(
    redactCredentials(
      "password='ExampleHead' sslpassword='ExampleTail host=ExampleSuffix' dbname=couli",
    ),
  ).toBe('password=*** sslpassword=*** dbname=couli');
});

it('redactCredentials scans a secret assignment inside an already masked value from its own start', () => {
  // The unquoted first value ends before ` host=`; the `sslpassword` value inside it is quoted and
  // runs past that place, so the masked stretch runs to its closing quote.
  expect(
    redactCredentials("password=ExampleA&sslpassword='ExampleB host=ExampleC' dbname=couli"),
  ).toBe('password=*** dbname=couli');
  expect(
    redactCredentials('password=ExampleA &SSLPASSWORD = "ExampleB host=ExampleC" dbname=couli'),
  ).toBe('password=*** dbname=couli');
});

// Reference for the linear-time rewrite (B1-01zzd): a verbatim copy of `redactCredentials` and its
// helpers as they were before (main ffedd9b5), only `export` dropped. It is quadratic on
// adversarial input, so it is only run on short texts.
const referenceRedactCredentials = ((): ((text: string) => string) => {
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
  function redactCredentials(text: string): string {
    return maskPasswordParameters(text.replace(URL_CREDENTIALS, `$1:${MASK}@`));
  }

  return redactCredentials;
})();

// Pieces from which the differential texts are built: the characters every scanner state reacts
// to, and whole names, assignments and URL prefixes so that the rare branches are reached.
const PIECES = [
  ...'ap=\'"\\& \t?:/@%41x#_,',
  'password',
  'sslpassword',
  'host',
  'port',
  'PASSWORD',
  '%70assword',
  '%20',
  'postgres://',
  'x://',
  'u:p@',
  'password=',
  '?password=',
  '&password=',
  "password='",
  'password="',
  "&password='",
  ' host=',
  '&host=',
  'host=',
  '&sslpassword=',
  "' ",
  "'&",
  ' & ',
  '\\\\',
  "\\'",
  '?x=1&',
  'postgres://u:p@h/db?',
];

// Deterministic pseudo-random texts (mulberry32, fixed seeds): the same cases on every run.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIFFERENTIAL_RUNS = 30_000;

/** Texts from `generate` that the rewrite masks differently from the reference (none expected). */
function differencesFromReference(
  seed: number,
  generate: (random: () => number) => string,
): string[] {
  const random = mulberry32(seed);
  const differences: string[] = [];
  for (let run = 0; run < DIFFERENTIAL_RUNS; run++) {
    const text = generate(random);
    if (redactCredentials(text) !== referenceRedactCredentials(text)) {
      differences.push(JSON.stringify(text));
    }
  }
  return differences;
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

it(
  'redactCredentials gives exactly the reference output on short texts built from pieces',
  { timeout: 60_000 },
  () => {
    const differences = differencesFromReference(20261017, (random) => {
      let text = '';
      for (let count = Math.floor(random() * 25); count > 0; count--) text += pick(random, PIECES);
      return text;
    });
    expect(differences).toEqual([]);
  },
);

it(
  'redactCredentials gives exactly the reference output on short texts over a small alphabet',
  { timeout: 60_000 },
  () => {
    const alphabet = [...'ap=\'"\\& \t?:/@%41x#_P'];
    const differences = differencesFromReference(20261018, (random) => {
      let text = '';
      for (let count = Math.floor(random() * 49); count > 0; count--)
        text += pick(random, alphabet);
      return text;
    });
    expect(differences).toEqual([]);
  },
);

it(
  'redactCredentials gives exactly the reference output on short arbitrary texts',
  { timeout: 60_000 },
  () => {
    const differences = differencesFromReference(20261019, (random) => {
      let text = '';
      for (let count = Math.floor(random() * 33); count > 0; count--) {
        // Half the code units ASCII, the rest any UTF-16 code unit (lone surrogates included).
        const code = random() < 0.5 ? Math.floor(random() * 0x80) : Math.floor(random() * 0x10000);
        text += String.fromCharCode(code);
      }
      return text;
    });
    expect(differences).toEqual([]);
  },
);

it(
  'redactCredentials treats every UTF-16 code unit as the reference does (whitespace, names)',
  { timeout: 60_000 },
  () => {
    const differences: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const char = String.fromCharCode(code);
      for (const text of [
        `password=a${char}host=x`,
        `password='a'${char}&password=b c`,
        `x://u:p${char}@h`,
        `${char}x://u:p@h`,
      ]) {
        if (redactCredentials(text) !== referenceRedactCredentials(text)) {
          differences.push(JSON.stringify(text));
        }
      }
    }
    expect(differences).toEqual([]);
  },
);

it('redactCredentials keeps the reference output in the rarely reached scanner branches', () => {
  const cases: [string, string][] = [
    // The closing quote reopens a quoted part because the part before it ends in `password=`.
    ["password='a&password='b host=x'&host=1 z", 'password=***'],
    // A glued secret assignment after a closing quote, its value unquoted.
    ["&password='' &password=&host=", '&password=***&host='],
    // The user part of a URL is followed by `:`, but the `@` is in the next stretch.
    ['x://u:p x@h', 'x://u:p x@h'],
    // Two URLs in one stretch: the password runs to the last `@`.
    ['a://u:p@b://v:q@h c://w:r@h', 'a://u:***@h c://w:***@h'],
    // A scheme run starting with digits: the match starts at its first letter.
    ['9x://u:p@h', '9x://u:***@h'],
  ];
  for (const [input, expected] of cases) {
    expect(redactCredentials(input)).toBe(expected);
    expect(referenceRedactCredentials(input)).toBe(expected);
  }
});

// Adversarial inputs of 128–256 KB: each run must stay far below a second (a quadratic scan of
// this size takes minutes). The limit is loose on purpose; it only guards against a regression to
// superlinear time.
const LARGE = 131_072;
const repeatTo = (unit: string, length: number): string =>
  unit.repeat(Math.ceil(length / unit.length));

const LARGE_CASES: [string, string, (output: string) => boolean][] = [
  ['a long word', 'a'.repeat(2 * LARGE), (output) => output === 'a'.repeat(2 * LARGE)],
  ['a scheme and a long user part', `x://${'b'.repeat(LARGE)}`, (output) => output.endsWith('bbb')],
  ['many `x://u:p` without `@`', repeatTo('x://u:p', LARGE), (output) => output.endsWith(':p')],
  ['many `x://u:p` and one `@`', `${repeatTo('x://u:p', LARGE)}@h`, (o) => o === 'x://u:***@h'],
  ['long text glued to a quote', `password='x' ${'q'.repeat(LARGE)}'`, (o) => o === 'password=***'],
  ['repeated comma-glued values', repeatTo('password=a,', LARGE), (o) => o === 'password=***'],
  ['repeated open quotes', repeatTo("password='a ", LARGE), (o) => o === 'password=***'],
  ['repeated empty quotes', repeatTo("password=''", LARGE), (o) => o === 'password=***'],
  ['repeated query values', repeatTo('?password=a', LARGE), (o) => o === '?password=***'],
  ['repeated encoded names', repeatTo('%70assword=a,', LARGE), (o) => o === '%70assword=***'],
  ['repeated escaped quotes', repeatTo("password=\\'", LARGE), (o) => o === 'password=***'],
  ['escaped quotes in a value', `password='${repeatTo("\\'", LARGE)}`, (o) => o === 'password=***'],
  ['a quoted part of `a=`', `password='${repeatTo('a=', LARGE)}'x`, (o) => o === 'password=***'],
  ['whitespace after a value', `password=a${' '.repeat(LARGE)}b`, (o) => o === 'password=***'],
  [
    'whitespace after a value, then a keyword',
    `password=a${' '.repeat(LARGE)}host=h`,
    (o) => o === `password=***${' '.repeat(LARGE)}host=h`,
  ],
  ['whitespace after a quote', `password='a'${' '.repeat(LARGE)}x`, (o) => o === 'password=***'],
  ['`& ` after a quote', `password='a'${repeatTo('& ', LARGE)}x`, (o) => o === 'password=***'],
];

it(
  'redactCredentials and describeError stay linear on 128–256 KB adversarial inputs',
  { timeout: 120_000 },
  () => {
    const slow: string[] = [];
    for (const [name, input, check] of LARGE_CASES) {
      for (const [entry, run] of [
        ['redactCredentials', redactCredentials],
        ['describeError', (text: string): string => describeError(new Error(text)).slice(7)],
      ] as const) {
        const start = performance.now();
        const output = run(input);
        const elapsed = performance.now() - start;
        expect(check(output), `${entry}: ${name}`).toBe(true);
        if (elapsed >= 1000) slow.push(`${entry}: ${name} took ${Math.round(elapsed)} ms`);
      }
    }
    expect(slow).toEqual([]);
  },
);
