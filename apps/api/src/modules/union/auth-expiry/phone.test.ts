// B1-22b: the alert phone normaliser follows the shared BR-ID-05 vectors exactly.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { normalizeAlertPhone } from './phone.ts';

interface Vector {
  readonly input: string;
  readonly note: string;
  readonly expected?: string;
}

const url = new URL('../../../../../../specs/phone-normalize.vectors.json', import.meta.url);
const cases = (JSON.parse(readFileSync(url, 'utf8')) as { cases: Vector[] }).cases;

it('[BR-ID-05] 告警手机号规范化与共享向量一致（有效得 11 位号，无效得 null）', () => {
  expect(cases.length).toBeGreaterThan(0);
  for (const vector of cases) {
    expect([vector.note, normalizeAlertPhone(vector.input)]).toEqual([
      vector.note,
      vector.expected ?? null,
    ]);
  }
});
