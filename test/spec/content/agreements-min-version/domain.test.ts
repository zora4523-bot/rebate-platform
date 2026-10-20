// F1-02zr §9.2: legal.agreement.min_version is optional int32 >= 1.
// Regression controls share a test with a new-behavior assertion so every case is initially red.
import { expect, it, vi } from 'vitest';
import { legalKeysOf } from '../../../../apps/api/src/modules/content/application/agreement-admin.ts';
import { configItemSpecOf } from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  buildClientConfig,
  type ClientConfigInput,
} from '../../../../apps/api/src/modules/content/domain/client-config.ts';

const KEY = 'legal.agreement.min_version';

it('[AC-F1-02zr#10] 最低版本只经协议发布写入，不登记配置中心；隐私与劳务映射不变', () => {
  expect(configItemSpecOf(KEY)).toBeNull();
  expect(legalKeysOf('privacy')).toEqual([
    { key: 'legal.privacy.version', field: 'version' },
    { key: 'legal.privacy.min_version', field: 'min_version' },
  ]);
  expect(legalKeysOf('labor_agreement')).toEqual([]);
  expect(legalKeysOf('agreement')).toEqual([
    { key: 'legal.agreement.version', field: 'version' },
    { key: KEY, field: 'min_version' },
  ]);
});

function assemble(extra: Record<string, unknown> = {}) {
  const report = { invalid: vi.fn(), missing: vi.fn() };
  const input: ClientConfigInput = {
    values: new Map(
      Object.entries({
        h5_base_url: 'https://h5.example.test/',
        'h5_release.stable': 'stable',
        kf: { url: 'https://kf.example.test/' },
        'legal.privacy.version': 7,
        'legal.privacy.min_version': 3,
        'legal.agreement.version': 1,
        ...extra,
      }),
    ),
    viewer: { appId: 'f102zr_domain', userId: null },
    deviceId: null,
    linkPatterns: { version: 'fixture', rules: [] },
    rankPlatforms: [],
    report,
  };
  return { data: buildClientConfig(input), report, input };
}

it.each([1, 2, 2147483647])(
  '[AC-F1-02zr#1] 合法最低版本 %s 确定性下发，允许大于 version；缺行无字段、无报告',
  (value) => {
    const absent = assemble();
    expect(absent.data?.legal.agreement).toEqual({ version: 1 });
    expect(absent.report.invalid).not.toHaveBeenCalled();
    expect(absent.report.missing).not.toHaveBeenCalled();
    const present = assemble({ [KEY]: value });
    expect(present.data?.legal.agreement).toEqual({ version: 1, min_version: value });
    expect(present.data?.legal.privacy).toEqual({ version: 7, min_version: 3 });
    expect(buildClientConfig(present.input)).toEqual(present.data);
    expect(present.report.invalid).not.toHaveBeenCalled();
    expect(present.report.missing).not.toHaveBeenCalled();
  },
);

it.each([
  ['零', 0],
  ['负数', -1],
  ['小数', 1.5],
  ['字符串', '2'],
  ['null', null],
  ['true', true],
  ['false', false],
  ['超出 int32', 2147483648],
  ['对象', { marker: 'fixture' }],
  ['数组', [2]],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
] satisfies [string, unknown][])(
  '[AC-F1-02zr#2] 最低版本为%s按缺行处理，每次仅报告该键且结果确定',
  (_label, value) => {
    const invalid = assemble({ [KEY]: value });
    const absent = assemble();
    expect(invalid.data).toBeDefined();
    expect(invalid.data).toEqual(absent.data);
    expect(invalid.data?.legal.agreement).toEqual({ version: 1 });
    expect(invalid.report.invalid.mock.calls).toEqual([[KEY]]);
    expect(invalid.report.missing).not.toHaveBeenCalled();
    expect(buildClientConfig(invalid.input)).toEqual(invalid.data);
    expect(invalid.report.invalid.mock.calls).toEqual([[KEY], [KEY]]);
  },
);
