import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { describeError, redactCredentials, redactPgUrl } from '../../../packages/db/src/pg-url.ts';

// The markers cannot overlap safe fields. Only synthetic, nonempty ASCII secrets are generated.
const fragment = fc
  .string({ unit: fc.constantFrom(...'abcdef0123456789'), minLength: 1, maxLength: 24 })
  .map((value) => `SyntheticSecret_${value}_End`);
const secretName = fc.constantFrom('password', 'sslpassword', 'oauth_client_secret');
const chain = fc.record({
  first: secretName,
  next: secretName,
  quote: fc.constantFrom("'", '"'),
  slashes: fc.constantFrom(0, 1, 2, 3, 4, 5),
  spacing: fc.constantFrom('', ' ', '  '),
  fragments: fc.tuple(fragment, fragment, fragment, fragment),
});

it('[AC-B1-01zy#6] 任意多段粘连口令、引号及转义组合均不泄露片段且保留普通字段', () => {
  const stats = createPropStats('db:pg-url:quoted-secret-chains');
  const params = propParams();
  fc.assert(
    fc.property(fc.array(chain, { minLength: 1, maxLength: 4 }), (chains) => {
      const secrets: string[] = [];
      const assignments = chains.map(({ first, next, quote, slashes, spacing, fragments }) => {
        stats.hit(`${first}:${next}:${quote}:${slashes}`);
        secrets.push(...fragments);
        const [head, tail, suffix, escaped] = fragments;
        // Odd slash counts reproduce the escaped-quote leak; even counts close the first
        // value. Neither may expose the next assignment's host= or port= secret fragment.
        return (
          `${first}=${quote}${head}${'\\'.repeat(slashes)}${quote}&` +
          `${next}${spacing}=${spacing}${quote}${tail} host=${suffix}` +
          `\\${quote} port=${escaped}${quote} application_name=public-app`
        );
      });
      const body = assignments.join(' ');
      const inputs = [
        `${body} dbname=couli`,
        `host=db.invalid ${body} dbname=couli`,
        `postgres://u@h/db?${body} dbname=couli`,
      ];
      return inputs.every((input) =>
        [redactCredentials(input), describeError(new Error(input))].every(
          (output) =>
            secrets.every((secret) => !output.includes(secret)) &&
            output.includes('***') &&
            output.includes('application_name=public-app') &&
            output.includes('dbname=couli'),
        ),
      );
    }),
    params,
  );
  expect(stats.flush().discards).toBe(0);
}, 600_000);

it('[AC-B1-01zy#7] 两个 URL 入口均隐藏任意重复 OAuth 口令且保留非口令参数', () => {
  const stats = createPropStats('db:pg-url:oauth-query-secrets');
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          name: fc.constantFrom(
            'oauth_client_secret',
            'OAUTH_CLIENT_SECRET',
            'oauth%5Fclient%5Fsecret',
          ),
          secret: fragment,
        }),
        { minLength: 1, maxLength: 8 },
      ),
      (pairs) => {
        for (const { name } of pairs) stats.hit(name);
        const query = pairs.map(({ name, secret }) => `${name}=${secret}`).join('&');
        const input =
          `postgres://u@db.invalid/couli?${query}` +
          '&oauth_client_id=public-client&sslmode=require';
        return [redactCredentials(input), redactPgUrl(input)].every(
          (output) =>
            pairs.every(({ secret }) => !output.includes(secret)) &&
            output.includes('***') &&
            output.includes('postgres://u@db.invalid/couli?') &&
            output.includes('oauth_client_id=public-client') &&
            output.includes('sslmode=require'),
        );
      },
    ),
    propParams(),
  );
  expect(stats.flush().discards).toBe(0);
}, 600_000);
