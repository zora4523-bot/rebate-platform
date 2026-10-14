import { expect, it } from 'vitest';
import { describeError, redactCredentials } from '../../../packages/db/src/pg-url.ts';

// All values are synthetic. Boolean assertions avoid echoing leaked values in red-test diffs.
function check(input: string, secrets: string[], safe: string[]): void {
  const error = Object.assign(new Error(input), { code: 'ECONNREFUSED' });
  for (const output of [redactCredentials(input), describeError(error)]) {
    for (const secret of secrets) {
      expect(output.includes(secret), 'no fragment of any password may survive').toBe(false);
    }
    for (const field of safe) {
      expect(output.includes(field), 'ordinary connection fields must remain readable').toBe(true);
    }
  }
}

it('[AC-B1-01zr#5] 转义单引号后紧接另一个口令参数时两个值都不泄露', () => {
  const safe = ['host=db.invalid', 'application_name=demo', 'dbname=couli'];
  // The first unescaped quote closes the outer value; the malformed adjacent Tail still
  // belongs to a password-looking assignment and must not reach logs or error descriptions.
  check(
    String.raw`host=db.invalid password='Head\'&sslpassword='Tail' application_name=demo dbname=couli`,
    ['Head', 'Tail'],
    safe,
  );
});

it('[AC-B1-01zr#6] 引号内奇数反斜杠与多个重复大小写口令参数均完整打码', () => {
  for (const count of [1, 3, 5]) {
    for (const name of ['password', 'PASSWORD', 'sslpassword', 'SSLPassword']) {
      const value = `QuotedHead${'\\'.repeat(count)}'&${name}='QuotedTail'`;
      check(
        `host=db.invalid ${name}='${value} sslpassword='LastSecret' port=5432 dbname=couli`,
        ['QuotedHead', 'QuotedTail', 'LastSecret'],
        ['host=db.invalid', 'port=5432', 'dbname=couli'],
      );
    }
  }
});

it('[AC-B1-01zr#7] 偶数反斜杠结束值后继续识别口令且不吞掉正常参数', () => {
  for (const count of [2, 4]) {
    // A normal, even-backslash quoted value precedes the adversarial adjacent assignment.
    const ending = `SlashSecret${'\\'.repeat(count)}`;
    check(
      `password='${ending}' host=db.invalid ` +
        String.raw`sslpassword='NextHead\'&password='NextTail' port=5432 application_name=demo`,
      ['SlashSecret', 'NextHead', 'NextTail'],
      ['host=db.invalid', 'port=5432', 'application_name=demo'],
    );
  }
});
