import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { normalize_phone } from '../../../../apps/api/src/modules/identity/domain/normalize-phone.ts';

const vectors = JSON.parse(
  readFileSync(new URL('../../../../specs/phone-normalize.vectors.json', import.meta.url), 'utf8'),
) as {
  cases: {
    input: string;
    note: string;
    expected?: string;
    error?: { code: number; fields: string[]; reason: string };
  }[];
};
it.each(vectors.cases)('[AC-S1-78 ③][BR-ID-05] 共享规范化向量：$note', (vector) => {
  const result = normalize_phone(vector.input);
  if (vector.expected !== undefined) {
    expect(result).toEqual({ code: 0, phone: vector.expected });
    expect(normalize_phone(vector.expected)).toEqual(result);
  } else {
    expect(vector.error).toBeDefined();
    expect(result).toEqual({
      code: 20001,
      data: { fields: vector.error!.fields, reason: vector.error!.reason },
    });
  }
});
