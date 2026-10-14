import { expect, it } from 'vitest';
import { describeError, redactCredentials, redactPgUrl } from '../../../packages/db/src/pg-url.ts';

// Synthetic values only; boolean assertions avoid echoing a leaked value in assertion diffs.
function check(output: string, secrets: readonly string[], safe: readonly string[]): void {
  for (const secret of secrets) {
    expect(output.includes(secret), 'no password fragment may survive').toBe(false);
  }
  expect(output.includes('***'), 'use the existing redaction marker').toBe(true);
  for (const field of safe) {
    expect(output.includes(field), 'ordinary fields must remain readable').toBe(true);
  }
}

it.each([
  ['standalone', '', []],
  ['URL', 'postgres://u@h/db?', ['postgres://u@h/db?']],
  ['keyword/value', 'host=x ', ['host=x']],
] as const)('[AC-B1-01zy#1] %s：粘连口令中的 host= 后缀全部打码', (_form, prefix, safe) => {
  const input = prefix + String.raw`password='Head\'&sslpassword='Tail host=SecretSuffix'`;
  for (const output of [redactCredentials(input), describeError(new Error(input))]) {
    check(output, ['Head', 'Tail', 'SecretSuffix'], safe);
  }
});

it('[AC-B1-01zy#2] 重入引号值时识别引号种类、转义及重复口令键，保留最终普通字段', () => {
  for (const quote of ["'", '"']) {
    for (const slashCount of [0, 1, 2, 3, 4, 5]) {
      for (const name of ['password', 'SSLPassword', 'oauth_client_secret']) {
        const value =
          `password=${quote}Head${'\\'.repeat(slashCount)}${quote}&${name} = ${quote}` +
          `Tail host=SecretSuffix${'\\'}${quote} port=SecretPort${quote}`;
        for (const prefix of ['', 'postgres://u@h/db?', 'host=x ']) {
          const input = `${prefix}${value} dbname=couli sslmode=require`;
          check(
            redactCredentials(input),
            ['Head', 'Tail', 'SecretSuffix', 'SecretPort'],
            ['dbname=couli', 'sslmode=require'],
          );
        }
      }
    }
  }
});

it('[AC-B1-01zy#3] oauth_client_secret 在 keyword/value 与错误描述中完整打码', () => {
  const cases = [
    ['oauth_client_secret=TopSecret host=x', ['TopSecret']],
    [
      String.raw`oauth_client_secret='SecretHead\' host=SecretTail' host=x`,
      ['SecretHead', 'SecretTail'],
    ],
    ['OAUTH_CLIENT_SECRET=TopSecret host=x', ['TopSecret']],
    ['oauth%5Fclient%5Fsecret=TopSecret host=x', ['TopSecret']],
  ] as const;
  for (const [input, secrets] of cases) {
    check(redactCredentials(input), secrets, ['host=x']);
    check(describeError(new Error(input)), secrets, ['host=x']);
  }
  // Unquoted query values still end at whitespace; ordinary log context is not a secret.
  check(
    redactCredentials('postgres://u@h/db?oauth_client_secret=TopSecret public-context'),
    ['TopSecret'],
    ['public-context'],
  );
});

it.each([
  { entry: 'redactCredentials', redact: redactCredentials },
  { entry: 'redactPgUrl', redact: redactPgUrl },
])(
  '[AC-B1-01zy#4] $entry：URL 中重复、大小写及编码的 OAuth 口令打码，普通字段不受影响',
  ({ redact }) => {
    check(
      redact('postgres://u@h/db?oauth_client_secret=TopSecret&sslmode=require'),
      ['TopSecret'],
      ['postgres://u@h/db?', 'sslmode=require'],
    );
    check(
      redact(
        'postgres://u:UserSecret@h/db?oauth_client_secret=FirstSecret' +
          '&OAUTH_CLIENT_SECRET=SecondSecret&oauth%5Fclient%5Fsecret=ThirdSecret' +
          '&oauth_client_id=public-client&oauth_client_secrets=public-plural' +
          '&myoauth_client_secret=public-prefix&sslmode=require',
      ),
      ['UserSecret', 'FirstSecret', 'SecondSecret', 'ThirdSecret'],
      [
        'oauth_client_id=public-client',
        'oauth_client_secrets=public-plural',
        'myoauth_client_secret=public-prefix',
        'sslmode=require',
      ],
    );
  },
);

it.each([
  ['servicefile', '/public/pg_service.conf'],
  ['oauth_issuer', 'https://issuer.invalid'],
  ['oauth_client_id', 'public-client'],
  ['oauth_scope', 'openid'],
  ['requiressl', '1'],
  ['uselibpqcompat', '1'],
])('[AC-B1-01zy#5] 新增已知参数 %s 是口令结束边界，字段仍可读', (name, value) => {
  const field = `${name}=${value}`;
  for (const secret of ['BoundarySecret', "'BoundarySecret'", '"BoundarySecret"']) {
    check(
      redactCredentials(`host=x password=${secret} ${field} port=5432`),
      ['BoundarySecret'],
      ['host=x', field, 'port=5432'],
    );
  }
  check(
    redactCredentials(`postgres://u@h/db?password='BoundarySecret'&${field}&sslmode=require`),
    ['BoundarySecret'],
    [field, 'sslmode=require'],
  );
  // A known name is a boundary only outside a quoted secret value.
  check(
    redactCredentials(`password='BoundarySecret ${field}' host=x`),
    ['BoundarySecret', value],
    ['host=x'],
  );
});
