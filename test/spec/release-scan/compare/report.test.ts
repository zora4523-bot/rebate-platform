import { expect, it } from 'vitest';
import { FAKE, expectOutcome, hit, realManifest, run } from './fixtures.ts';

// 05 QA-09 / 02 §12.6：清单内的放行，其余一律阻断发布；报告逐条给出判定与依据，退出码供流水线阻断。
// 口径：0 = 全部放行；1 = 有阻断；2 = 清单无效（读不懂的清单不能放行任何东西，fail-closed）。

it('[05 QA-09 报告#1] 仓库真实清单可读；没有命中时退出码 0、报告通过且无错误', () => {
  const report = run([], { platform: 'android' });
  expect(report).toEqual({
    platform: 'android',
    exit_code: 0,
    passed: true,
    decisions: [],
    errors: [],
    summary: { total: 0, allowed: 0, blocked: 0 },
  });
});

it('[05 QA-09 报告#2] 清单外的命中阻断：原因 unlisted，退出码 1，判定与输入命中同序且原样带回命中', () => {
  const hits = [
    hit({ rule: 'r-a', file: 'a.js', line: 3, match: FAKE.hex32 }),
    hit({ rule: 'r-b', file: 'b.js', line: 9, match: FAKE.apiUrl }),
    hit({ rule: 'r-c', file: 'c.js', line: 1, match: FAKE.hex40 }),
  ];
  const report = run(hits, { platform: 'h5' });
  expect(report.decisions.map((d) => d.hit)).toEqual(hits);
  expect(report.decisions.map((d) => [d.verdict, d.reason])).toEqual([
    ['block', 'unlisted'],
    ['allow', 'public_id'],
    ['block', 'unlisted'],
  ]);
  expect(report.summary).toEqual({ total: 3, allowed: 1, blocked: 2 });
  expect(report.exit_code).toBe(1);
  expect(report.passed).toBe(false);
  expect(report.errors).toEqual([]);
});

it('[05 QA-09 报告#3] 全部命中都在清单内时退出码 0', () => {
  const report = run([hit({ match: FAKE.apiUrl }), hit({ match: FAKE.wxAppId })], {
    platform: 'harmony',
  });
  expect(report.decisions.every((d) => d.verdict === 'allow')).toBe(true);
  expectOutcome(report, { exit_code: 0, allowed: 2, blocked: 0 });
});

const INVALID: Record<string, (text: string) => string> = {
  'YAML 语法错误': (t) => `${t}\n  : : bad\n\t- x`,
  空文件: () => '',
  缺_items: (t) => t.replace(/^items:\n/m, 'items_removed:\n'),
  未知类别: (t) => t.replace('category: wechat', 'category: server_secret'),
  未知端: (t) => t.replace('platforms: [android, harmony]', 'platforms: [android, windows]'),
  false_positives_不是列表: (t) => t.replace('false_positives: []', 'false_positives: x'),
  exceptions_不是列表: (t) => t.replace('exceptions: []', 'exceptions: x'),
};

it('[05 QA-09 报告#4] 清单无效时退出码 2、errors 非空，连公开标识也不放行', () => {
  const base = realManifest();
  for (const [name, mutate] of Object.entries(INVALID)) {
    const manifestYaml = mutate(base);
    expect(manifestYaml, name).not.toBe(base);
    const report = run([hit({ match: FAKE.apiUrl }), hit({ match: FAKE.hex32 })], {
      manifestYaml,
      platform: 'ios',
    });
    expect(report.exit_code, name).toBe(2);
    expect(report.passed, name).toBe(false);
    expect(report.errors.length, name).toBeGreaterThan(0);
    expect(
      report.decisions.map((d) => [d.verdict, d.reason, d.basis]),
      name,
    ).toEqual([
      ['block', 'manifest_invalid', null],
      ['block', 'manifest_invalid', null],
    ]);
    expect(report.summary, name).toEqual({ total: 2, allowed: 0, blocked: 2 });
  }
});

it('[05 QA-09 报告#5] 清单无效时即使没有命中也退出码 2（坏清单不能让发布通过）', () => {
  const report = run([], { manifestYaml: '', platform: 'admin' });
  expect(report.exit_code).toBe(2);
  expect(report.passed).toBe(false);
  expect(report.errors.length).toBeGreaterThan(0);
});
