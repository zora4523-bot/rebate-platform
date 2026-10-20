import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { DEFAULTS, KEY } from './oracle.ts';

it('[AC-F1-02zx#6] 0001 种子在第六批后追加数字 30 且重跑不覆盖，同组旧值不变', () => {
  const source = readFileSync(
    new URL('../../../../db/seeds/0001_config-defaults.sql', import.meta.url),
    'utf8',
  );
  // Ignore comments: a commented-out row or ON CONFLICT is not an executable seed.
  const sql = source.replace(/--[^\n]*/gu, '').replace(/\/\*[\s\S]*?\*\//gu, '');
  const rows = [
    ...sql.matchAll(
      /\(\s*'couli'\s*,\s*'([^']+)'\s*,\s*'((?:[^']|'')*)'\s*::\s*jsonb\s*,\s*'seed'\s*\)/giu,
    ),
  ].map((match) => ({
    key: match[1]!,
    value: JSON.parse(match[2]!.replaceAll("''", "'")) as unknown,
  }));
  expect(rows.filter((row) => row.key === KEY)).toStrictEqual([{ key: KEY, value: 30 }]);
  expect(rows.filter((row) => row.key.startsWith('growth.invite_reward.'))).toStrictEqual(DEFAULTS);
  const statement = sql.split(';').filter((part) => part.includes(`'${KEY}'`));
  expect(statement).toHaveLength(1);
  expect(statement[0]).toMatch(
    /INSERT\s+INTO\s+app\.config_items\s*\(\s*app_id\s*,\s*key\s*,\s*value\s*,\s*updated_by\s*\)\s+VALUES/iu,
  );
  expect(statement[0]).toMatch(/ON\s+CONFLICT\s*\(\s*app_id\s*,\s*key\s*\)\s+DO\s+NOTHING\s*$/iu);
  const spec = configItemSpecOf(KEY);
  expect(spec).not.toBeNull();
  expect(configValueFits(spec!, rows.find((row) => row.key === KEY)?.value)).toBe(true);
});
