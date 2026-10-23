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
// B2-06bz (D10-244 ②、D10-296): the eight payout.* seed rows follow eligibility_days, in
// registration order, and nothing else (values are not this test's concern; each must fit its spec,
// checked below with the other extra rows).
const PAYOUT_KEYS = [
  'payout.single_cap_fen',
  'payout.daily_cap_fen',
  'payout.watermark_usable_bp',
  'payout.biz_scene',
  'payout.query_schedule',
  'payout.definite_fail_codes',
  'payout.payer_side_codes',
  'payout.query_status_map',
];

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
  expect(extra[0]).toStrictEqual(ELIGIBILITY);
  expect(extra.map((row) => row.key)).toStrictEqual([ELIGIBILITY.key, ...PAYOUT_KEYS]);
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
