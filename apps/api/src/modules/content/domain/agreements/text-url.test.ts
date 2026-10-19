import { expect, it } from 'vitest';
import { agreementTextUrl } from './text-url.ts';

it('[AC-F1-02n#u1] 去掉一个尾斜杠后拼固定顺序的 type、version', () => {
  expect(agreementTextUrl('https://h5.example.test/', 'labor_agreement', 3)).toBe(
    'https://h5.example.test/agreement?type=labor_agreement&version=3',
  );
  expect(agreementTextUrl('https://h5.example.test/m', 'privacy', 1)).toBe(
    'https://h5.example.test/m/agreement?type=privacy&version=1',
  );
});

it('[AC-F1-02n#u2] 非 https、相对地址、带 query 或 fragment、版本非正整数时为 null', () => {
  for (const base of [
    '',
    'HTTP://h5.example.test',
    'ftp://x',
    'https://',
    'https://a/?',
    'https://a/#x',
  ]) {
    expect(agreementTextUrl(base, 'privacy', 1)).toBeNull();
  }
  expect(agreementTextUrl('https://h5.example.test', 'privacy', 0)).toBeNull();
  expect(agreementTextUrl('https://h5.example.test', 'privacy', 1.5)).toBeNull();
});
