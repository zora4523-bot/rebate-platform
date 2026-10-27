// B2-11d (编排裁定 D10-392): the four precheck keys are configuration items the owner fills when
// enabling (规划/08 BR-WDR-30 细则「开启前置检查」: ② ⑤ ⑧「已在 规划/09 判为支持」, 「天数由负责人
// 在开启时定」), so the console must accept them: registered, editable, config.business like the
// other withdraw / payout money keys, not switches. The three support flags are booleans seeded
// false; recon_required_days is an integer ≥ 1 with no seed row (unset = not passed). The days the
// reconciliation has run through are not a key at all.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { switchSpecOf } from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import { ENABLE_KEYS, RECON_REQUIRED_DAYS, RETIRED_PASSED_DAYS, SUPPORT_KEYS } from './kit.ts';

function registered(key: string) {
  const spec = configItemSpecOf(key);
  expect(spec, `${key} 必须登记为配置项`).not.toBeNull();
  return spec!;
}

it.each(ENABLE_KEYS)(
  '[AC-B2-11d#33] %s 登记为可改的 config.business 配置项（恰好一次、不是开关）；recon_passed_days 不登记',
  (key) => {
    const spec = registered(key);
    expect({
      key: spec.key,
      valueType: spec.valueType,
      options: spec.options,
      permission: spec.permission,
      adminEditable: spec.adminEditable,
    }).toStrictEqual({
      key,
      valueType: key === RECON_REQUIRED_DAYS ? 'number' : 'boolean',
      options: null,
      permission: 'config.business',
      adminEditable: true,
    });
    expect(configRegistry().filter((entry) => entry.key === key)).toHaveLength(1);
    expect(switchSpecOf(key)).toBeNull();
    expect(configItemSpecOf(RETIRED_PASSED_DAYS)).toBeNull();
    expect(configRegistry().some((entry) => entry.key === RETIRED_PASSED_DAYS)).toBe(false);
  },
);

it.each(SUPPORT_KEYS)('[AC-B2-11d#34] %s 只收 JSON 布尔', (key) => {
  const spec = registered(key);
  for (const value of [true, false]) {
    expect(configValueFits(spec, value), String(value)).toBe(true);
  }
  for (const value of ['true', 'on', 1, 0, null, [], {}]) {
    expect(configValueFits(spec, value), JSON.stringify(value)).toBe(false);
  }
});

it('[AC-B2-11d#35] recon_required_days 设了须为 ≥ 1 的整数', () => {
  const spec = registered(RECON_REQUIRED_DAYS);
  for (const value of [1, 2, 7, 30, 365]) {
    expect(configValueFits(spec, value), String(value)).toBe(true);
  }
  const refused = [0, -1, 1.5, 7.5, Number.NaN, Number.POSITIVE_INFINITY, '7', true, null, []];
  for (const value of refused) expect(configValueFits(spec, value), String(value)).toBe(false);
});

/** Every ('couli', key, value) row of db/seeds/0001_config-defaults.sql, in file order. */
function seedRows() {
  const sql = readFileSync(
    new URL('../../../../db/seeds/0001_config-defaults.sql', import.meta.url),
    'utf8',
  );
  const rows = [...sql.matchAll(/\('couli',\s*'([^']+)',\s*'([^']*)'::jsonb/g)].map((match) => ({
    key: match[1]!,
    value: JSON.parse(match[2]!) as unknown,
  }));
  return { sql, rows };
}

it('[AC-B2-11d#36] 种子：三项支持状态缺省 false（重跑不覆盖）；recon_required_days 与 recon_passed_days 没有种子行（缺省不设）', () => {
  const { sql, rows } = seedRows();
  for (const key of SUPPORT_KEYS) {
    expect(
      rows.filter((row) => row.key === key),
      key,
    ).toStrictEqual([{ key, value: false }]);
    const statement = sql.split(';').find((part) => part.includes(`'${key}'`));
    expect(statement, key).toMatch(
      /ON\s+CONFLICT\s*(?:\(\s*app_id\s*,\s*key\s*\))?\s+DO\s+NOTHING/iu,
    );
  }
  expect(rows.some((row) => row.key === RECON_REQUIRED_DAYS)).toBe(false);
  expect(rows.some((row) => row.key === RETIRED_PASSED_DAYS)).toBe(false);
  expect(sql).not.toContain(RETIRED_PASSED_DAYS);
});
