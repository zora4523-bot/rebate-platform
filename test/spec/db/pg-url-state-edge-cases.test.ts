import { expect, it } from 'vitest';
import { describeError, redactCredentials, redactPgUrl } from '../../../packages/db/src/pg-url.ts';

// Synthetic values only. Compare fragments rather than unspecified output formatting.
function check(output: string, secrets: readonly string[], safe: readonly string[]): void {
  for (const secret of secrets) {
    expect(output.includes(secret), 'no password fragment may survive').toBe(false);
  }
  expect(output.includes('***'), 'use the existing redaction marker').toBe(true);
  for (const field of safe) {
    expect(output.includes(field), 'ordinary fields must remain readable').toBe(true);
  }
}

it('[AC-B1-01zy#8] 混用单双引号时只有同种引号闭合，粘连的第二段也完整打码', () => {
  for (const [firstQuote, nextQuote] of [
    ['"', "'"],
    ["'", '"'],
  ] as const) {
    for (const separator of [' ', '&']) {
      const body =
        `password=${firstQuote}MixedHead${nextQuote} host=MixedInner${firstQuote}` +
        `${separator}sslpassword=${nextQuote}MixedTail${firstQuote}` +
        ` host=MixedSuffix${nextQuote} dbname=couli sslmode=require`;
      for (const prefix of ['', 'host=x ', 'postgres://u@h/db?']) {
        const input = prefix + body;
        for (const output of [redactCredentials(input), describeError(new Error(input))]) {
          check(
            output,
            ['MixedHead', 'MixedInner', 'MixedTail', 'MixedSuffix'],
            ['dbname=couli', 'sslmode=require'],
          );
        }
      }
    }
  }
});

it('[AC-B1-01zy#9] 三类未加引号口令均跳过转义空格，host= 伪边界后的片段不泄露', () => {
  for (const name of ['password', 'sslpassword', 'oauth_client_secret']) {
    for (const slashCount of [1, 3, 5]) {
      const body =
        `${name}=EscapedHead${'\\'.repeat(slashCount)} host=EscapedSuffix` +
        ' dbname=couli sslmode=require';
      for (const prefix of ['', 'host=x ', 'postgres://u@h/db?']) {
        const input = prefix + body;
        for (const output of [redactCredentials(input), describeError(new Error(input))]) {
          check(output, ['EscapedHead', 'EscapedSuffix'], ['dbname=couli', 'sslmode=require']);
        }
      }
    }
  }
});

// PostgreSQL 18 documents these as base64-encoded keys for pass-through SCRAM authentication:
// https://www.postgresql.org/docs/18/libpq-connect.html#LIBPQ-CONNECT-SCRAM-CLIENT-KEY
// https://www.postgresql.org/docs/18/libpq-connect.html#LIBPQ-CONNECT-SCRAM-SERVER-KEY
it.each(['scram_client_key', 'scram_server_key'])(
  '[AC-B1-01zy#10] %s 是认证密钥，文本、错误与 URL 入口都打码且保留普通字段',
  (name) => {
    const first = Buffer.from('synthetic-scram-key-first-00000000').toString('base64');
    const second = Buffer.from('synthetic-scram-key-second-0000000').toString('base64');
    for (const spelling of [name, name.toUpperCase(), name.replaceAll('_', '%5F')]) {
      const input = `host=x ${spelling}=${first} ${spelling}='${second}' dbname=couli`;
      for (const output of [redactCredentials(input), describeError(new Error(input))]) {
        check(output, [first, second], ['host=x', 'dbname=couli']);
      }
      const url =
        `postgres://u@h/db?${spelling}=${first}&${spelling}=${second}` +
        '&oauth_client_id=public-client&sslmode=require';
      for (const output of [redactCredentials(url), redactPgUrl(url)]) {
        check(
          output,
          [first, second],
          ['postgres://u@h/db?', 'oauth_client_id=public-client', 'sslmode=require'],
        );
      }
    }
  },
);
