import { expect, it } from 'vitest';

import { parsePgUrl, pgUrl, redactPgUrl } from './pg-url.ts';

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
