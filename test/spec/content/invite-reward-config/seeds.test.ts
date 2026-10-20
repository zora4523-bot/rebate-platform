import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { CONFIGS, ENABLED, PAUSED, PREFIX } from './oracle.ts';

it('[AC-F1-02zn#6] BR-INV-24 种子为 1000/0/0/0/24，开关缺行默认 off；重跑不覆盖', () => {
  const sql = readFileSync(
    new URL('../../../../db/seeds/0001_config-defaults.sql', import.meta.url),
    'utf8',
  );
  const rows = [...sql.matchAll(/\('couli',\s*'([^']+)',\s*'([^']*)'::jsonb/g)].map((match) => ({
    key: match[1]!,
    value: JSON.parse(match[2]!) as unknown,
  }));
  expect(rows.filter((row) => row.key.startsWith(PREFIX))).toStrictEqual(
    CONFIGS.map((row) => ({ key: row.key, value: row.seed })),
  );
  expect(rows.slice(-6).map((row) => row.key)).toStrictEqual([
    'settle.statement.grace_days',
    ...CONFIGS.map((row) => row.key),
  ]);
  for (const row of CONFIGS) {
    const spec = configItemSpecOf(row.key);
    expect(spec, row.key).not.toBeNull();
    expect(configValueFits(spec!, rows.find((entry) => entry.key === row.key)?.value)).toBe(true);
  }
  expect(rows.some((row) => row.key === ENABLED || row.key === PAUSED)).toBe(false);
  // Check the INSERT containing each new row, not an unrelated batch's ON CONFLICT.
  for (const row of CONFIGS) {
    const statement = sql.split(';').find((part) => part.includes(`'${row.key}'`));
    expect(statement).toMatch(/ON\s+CONFLICT\s*(?:\(\s*app_id\s*,\s*key\s*\))?\s+DO\s+NOTHING/iu);
  }
});
