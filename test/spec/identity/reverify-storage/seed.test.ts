// B1-02zo 编排 §9.2 #2 (BR-WDR-01 细则): withdraw.dormant_reverify_days is seeded as 0, i.e. old-number
// reverify stays off until all three clients ship the reverify page. Exactly one seed row, and its
// INSERT never overwrites an operator's later value. Test databases do not load seeds, so the seed
// file is read directly (same parsing as the content seed tests). The row itself is registered and
// seeded by B1-02zs (编排 §10 #2); this test only requires that it is there with value 0.
import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

const KEY = 'withdraw.dormant_reverify_days';

it('[AC-B1-02zo#10] 种子 withdraw.dormant_reverify_days 恰有一行、值为 0（关闭），由 seed 写入，重跑不覆盖', () => {
  const text = readFileSync(
    new URL('../../../../db/seeds/0001_config-defaults.sql', import.meta.url),
    'utf8',
  );
  const rows = [
    ...text.matchAll(/\('([^']+)',\s*'([^']+)',\s*'([^']*)'::jsonb,\s*'([^']*)'\)/g),
  ].map((match) => ({
    app_id: match[1]!,
    key: match[2]!,
    value: JSON.parse(match[3]!) as unknown,
    updated_by: match[4]!,
  }));
  expect(rows.filter((row) => row.key === KEY)).toStrictEqual([
    { app_id: 'couli', key: KEY, value: 0, updated_by: 'seed' },
  ]);
  // The key appears nowhere else in the file (no second statement, no UPDATE).
  expect(text.split(`'${KEY}'`)).toHaveLength(2);
  const statement = text.split(';').find((part) => part.includes(`'${KEY}'`));
  expect(statement).toMatch(/INSERT\s+INTO\s+app\.config_items\b/iu);
  expect(statement).toMatch(/ON\s+CONFLICT\s*(?:\(\s*app_id\s*,\s*key\s*\))?\s+DO\s+NOTHING/iu);
});
