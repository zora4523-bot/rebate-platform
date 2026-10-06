import { expect, it } from 'vitest';
import { FAKE, expectOutcome, hit, manifestWith, run } from './fixtures.ts';

// 02 §12.6 误报过滤：false_positives 每条 {rule, file, reason}，只放行「同一检测规则、同一文件」的命中；
// 不支持通配，rule、file 都按全等比较（口径：只能加严）。

const FP = manifestWith({
  falsePositives: [
    'false_positives:',
    '  - rule: generic-high-entropy',
    '    file: assets/vendor/lib-test-data.js',
    '    reason: 第三方库自带的测试数据',
    '  - rule: generic-high-entropy',
    "    file: '**'",
    '    reason: 通配写法不得生效',
    '',
  ].join('\n'),
});

it('[02 §12.6 误报过滤#1] rule 与 file 都相同的命中放行，依据指向条目下标', () => {
  const report = run([hit({ file: 'assets/vendor/lib-test-data.js' })], { manifestYaml: FP });
  expect(report.errors).toEqual([]);
  expect(report.decisions[0]).toMatchObject({
    verdict: 'allow',
    reason: 'false_positive',
    basis: 'false_positives[0]',
  });
  expectOutcome(report, { exit_code: 0, allowed: 1, blocked: 0 });
});

it('[02 §12.6 误报过滤#2] 同一文件、不同检测规则的命中不放行', () => {
  const report = run([hit({ rule: 'cn-hex-secret', file: 'assets/vendor/lib-test-data.js' })], {
    manifestYaml: FP,
  });
  expect(report.decisions[0]).toMatchObject({ verdict: 'block', reason: 'unlisted' });
  expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 1 });
});

it('[02 §12.6 误报过滤#3] 文件名只按全等比较：同名在别的目录、加后缀、大小写不同都不放行', () => {
  for (const file of [
    'other/assets/vendor/lib-test-data.js',
    'assets/vendor/lib-test-data.js.map',
    'assets/vendor/Lib-Test-Data.js',
    './assets/vendor/lib-test-data.js',
  ]) {
    const report = run([hit({ file })], { manifestYaml: FP });
    expect(report.decisions[0], file).toMatchObject({ verdict: 'block', reason: 'unlisted' });
    expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 1 }, file);
  }
});

it("[02 §12.6 误报过滤#4] file 写成通配（'**'）不放行任何别的文件", () => {
  const report = run([hit({ file: 'assets/main.js', match: FAKE.hex40 })], { manifestYaml: FP });
  expect(report.decisions[0]).toMatchObject({ verdict: 'block', reason: 'unlisted' });
  expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 1 });
});

it('[02 §12.6 误报过滤#5] reason 为空或缺 rule/file 的条目使清单无效：退出码 2，全部命中阻断', () => {
  const bad = [
    "false_positives:\n  - rule: generic-high-entropy\n    file: assets/main.js\n    reason: ''\n",
    'false_positives:\n  - rule: generic-high-entropy\n    reason: 缺文件\n',
    'false_positives:\n  - file: assets/main.js\n    reason: 缺规则\n',
  ];
  for (const falsePositives of bad) {
    const report = run([hit({ file: 'assets/main.js' })], {
      manifestYaml: manifestWith({ falsePositives }),
    });
    expectOutcome(report, { exit_code: 2, allowed: 0, blocked: 1 }, falsePositives);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.decisions[0]).toMatchObject({ verdict: 'block', reason: 'manifest_invalid' });
  }
});
