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
    "以及 host=db user=u password='pw 5' dbname=couli；password = pw6;sslmode=require";
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
