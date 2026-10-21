import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { CONFIGS, ENABLED, PAUSED, PREFIX } from './oracle.ts';

// F1-02zw: F1-02zx appends the BR-INV-24 细则 eligibility period seed right after the five rows as
// the last row; its value is 30 days (08 l.560), written here independently of the registry and
// the seed file. F1-02zt：过渡已收紧, the sixth row must be present.
const ELIGIBILITY = { key: `${PREFIX}eligibility_days`, value: 30 };

it('[AC-F1-02zn#6] BR-INV-24 种子为 1000/0/0/0/24，开关缺行默认 off；重跑不覆盖', () => {
  const sql = readFileSync(
    new URL('../../../../db/seeds/0001_config-defaults.sql', import.meta.url),
    'utf8',
  );
  const rows = [...sql.matchAll(/\('couli',\s*'([^']+)',\s*'([^']*)'::jsonb/g)].map((match) => ({
    key: match[1]!,
    value: JSON.parse(match[2]!) as unknown,
  }));
  const five = CONFIGS.map((row) => ({ key: row.key, value: row.seed }));
  expect(rows.filter((row) => row.key.startsWith(PREFIX))).toStrictEqual([...five, ELIGIBILITY]);
  const i = rows.findIndex((row) => row.key === 'settle.statement.grace_days');
  expect(i).toBeGreaterThanOrEqual(0);
  expect(rows.slice(i, i + 6).map((row) => row.key)).toStrictEqual([
    'settle.statement.grace_days',
    ...CONFIGS.map((row) => row.key),
  ]);
  const extra = rows.slice(i + 6);
  expect(extra).toStrictEqual([ELIGIBILITY]);
  for (const row of CONFIGS) {
    const spec = configItemSpecOf(row.key);
    expect(spec, row.key).not.toBeNull();
    expect(configValueFits(spec!, rows.find((entry) => entry.key === row.key)?.value)).toBe(true);
  }
  for (const row of extra) {
    const spec = configItemSpecOf(row.key);
    expect(spec, row.key).not.toBeNull();
    expect(configValueFits(spec!, row.value), row.key).toBe(true);
  }
  expect(rows.some((row) => row.key === ENABLED || row.key === PAUSED)).toBe(false);
  // Check the INSERT containing each new row, not an unrelated batch's ON CONFLICT.
  for (const row of [...CONFIGS, ...extra]) {
    const statement = sql.split(';').find((part) => part.includes(`'${row.key}'`));
    expect(statement).toMatch(/ON\s+CONFLICT\s*(?:\(\s*app_id\s*,\s*key\s*\))?\s+DO\s+NOTHING/iu);
  }
});
