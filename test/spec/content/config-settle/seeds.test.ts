import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { seedRows } from '../config-items/kit.ts';
import { DEFAULTS } from './oracle.ts';

it.each(DEFAULTS)(
  '[AC-F1-02zj#7] BR-FUND-04：0001 种子 %s = %j（JSON 类型准确并满足注册范围）',
  (key, value) => {
    // The existing seed entry point must contain these rows; another seed file is insufficient.
    const rows = seedRows();
    expect(rows.has(key), key).toBe(true);
    expect(rows.get(key), key).toStrictEqual(value);
    const spec = configItemSpecOf(key);
    expect(spec, key).not.toBeNull();
    expect(configValueFits(spec!, rows.get(key)), key).toBe(true);
  },
);
