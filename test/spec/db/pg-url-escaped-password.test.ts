import { expect, it } from 'vitest';
import { describeError, redactCredentials } from '../../../packages/db/src/pg-url.ts';

// Synthetic placeholders only. Assert booleans so a failing redaction never prints the
// input, output, or a leaked password suffix in Vitest's assertion diff.
function assertMasked(input: string, expected: string): void {
  expect(
    redactCredentials(input) === expected,
    'mask the entire value and retain safe fields',
  ).toBe(true);
}

it('[AC-B1-01zj#4] libpq 单引号值中的转义引号与空格后缀全部打码', () => {
  const parts = ['placeholder_head', 'placeholder_middle', 'placeholder_tail'];
  const value = parts.join("\\'") + ' placeholder_space';
  const input = `host=db.invalid user=demo password='${value}' dbname=couli sslmode=require`;
  const masked = redactCredentials(input);
  for (const fragment of [...parts, 'placeholder_space']) {
    expect(masked.includes(fragment), 'no password fragment may survive').toBe(false);
  }
  expect(
    masked === 'host=db.invalid user=demo password=*** dbname=couli sslmode=require',
    'keep every nonsecret field',
  ).toBe(true);
});

it('[AC-B1-01zj#5] 转义反斜杠按奇偶确定引号边界且普通值行为不变', () => {
  // Odd counts escape the quote; even counts end the value. Include trailing slashes,
  // so simply treating every quote preceded by a slash as escaped cannot pass.
  for (const count of [1, 3, 5]) {
    const value = 'placeholder_head' + '\\'.repeat(count) + "'placeholder_tail space";
    assertMasked(`password='${value}' host=db.invalid`, 'password=*** host=db.invalid');
  }
  for (const count of [2, 4]) {
    const value = 'placeholder_end' + '\\'.repeat(count);
    assertMasked(`password='${value}' host=db.invalid`, 'password=*** host=db.invalid');
  }
  for (const value of ['placeholder_plain', "'placeholder with space'", "''"]) {
    assertMasked(
      `host=db.invalid password=${value} dbname=couli`,
      'host=db.invalid password=*** dbname=couli',
    );
  }
  assertMasked('host=db.invalid user=demo dbname=couli', 'host=db.invalid user=demo dbname=couli');
});

it('[AC-B1-01zj#6] 重复及大小写口令参数各自完整打码而不吞掉后续字段', () => {
  const value = ['placeholder_left', 'placeholder_right space'].join("\\'");
  const names = ['password', 'PASSWORD', 'sslpassword', 'SSLPassword'];
  for (const name of names) {
    assertMasked(
      `host=db.invalid ${name}='${value}' application_name=demo ${name}='${value}' dbname=couli`,
      `host=db.invalid ${name}=*** application_name=demo ${name}=*** dbname=couli`,
    );
  }
});

it('[AC-B1-01zj#7] 错误描述入口也不泄露转义单引号后的口令片段', () => {
  const value = ['placeholder_start', 'placeholder_finish space'].join("\\'");
  const error = Object.assign(
    new Error(`connect host=db.invalid password='${value}' dbname=couli`),
    {
      code: 'ECONNREFUSED',
    },
  );
  expect(
    describeError(error) ===
      'Error [ECONNREFUSED]: connect host=db.invalid password=*** dbname=couli',
    'error descriptions must preserve safe context without any password suffix',
  ).toBe(true);
});
