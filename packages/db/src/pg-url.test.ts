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

it('redactCredentials keeps masking a secret assignment glued inside an escaped-quote value', () => {
  // `\'` does not end the quoted value; the quote after `sslpassword=` does, and the text after it
  // is the inner assignment's value, so it is masked too.
  const input = String.raw`host=db password='ExampleHead\'&sslpassword='ExampleTail' dbname=couli`;
  expect(redactCredentials(input)).toBe('host=db password=*** dbname=couli');
  // An inner assignment whose value ends inside the outer value changes nothing.
  expect(redactCredentials("host=db password='ExampleA&password=ExampleB c' dbname=couli")).toBe(
    'host=db password=*** dbname=couli',
  );
  // Chained: every inner value is covered, ordinary parameters after it stay readable.
  const chained = String.raw`password='ExampleOne\'&password='ExampleTwo\'&sslpassword='ExampleThree' port=5432`;
  expect(redactCredentials(chained)).toBe('password=*** port=5432');
});
