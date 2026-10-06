import { expect, it } from 'vitest';
import { ALL_PLATFORMS, FAKE, expectOutcome, hit, manifestWith, run } from './fixtures.ts';

// 02 §12.6「不可豁免」：服务端密钥、私钥、BR-ID-09 禁止内置的请求签名材料与共享盐进入制品，
// 任何情况下都不放行——公开标识格式、false_positives、带批准的 exceptions 都盖不过。

const FILE = 'assets/sdk-config.json';
const RULE = 'server-secret-hex';

it('[02 §12.6 不可豁免#1] never_accepted 命中在每个端都阻断，原因 never_accepted、无依据', () => {
  for (const platform of ALL_PLATFORMS) {
    const report = run([hit({ rule: RULE, file: FILE, never_accepted: true })], { platform });
    expect(report.decisions).toHaveLength(1);
    expect(report.decisions[0]).toMatchObject({
      verdict: 'block',
      reason: 'never_accepted',
      basis: null,
    });
    expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 1 }, platform);
  }
});

it('[02 §12.6 不可豁免#2] 命中内容符合公开标识格式也不放行（微信 AppID 形状被标为 never_accepted）', () => {
  const report = run([hit({ match: FAKE.wxAppId, never_accepted: true })], { platform: 'android' });
  expect(report.decisions[0]).toMatchObject({ verdict: 'block', reason: 'never_accepted' });
  expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 1 });
});

it('[02 §12.6 不可豁免#3] 同 rule、同 file 的 false_positives 条目不能放行 never_accepted 命中', () => {
  const manifestYaml = manifestWith({
    falsePositives: `false_positives:\n  - rule: ${RULE}\n    file: ${FILE}\n    reason: 第三方库自带的测试数据\n`,
  });
  const report = run([hit({ rule: RULE, file: FILE, never_accepted: true })], { manifestYaml });
  expect(report.errors).toEqual([]);
  expect(report.decisions[0]).toMatchObject({ verdict: 'block', reason: 'never_accepted' });
  expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 1 });
});

it('[02 §12.6 不可豁免#4][BR-ID-09] 带有效负责人批准的 exceptions 条目也不能放行 never_accepted 命中', () => {
  const manifestYaml = manifestWith({
    exceptions: [
      'exceptions:',
      '  - sdk: 示例 SDK',
      '    item: 随包配置',
      `    rule: ${RULE}`,
      `    file: ${FILE}`,
      '    scope_if_leaked: 只能注册设备',
      '    server_side_limit: 服务端按设备限流并可随时更换',
      '    approval: 30',
      '',
    ].join('\n'),
  });
  const report = run([hit({ rule: RULE, file: FILE, never_accepted: true })], { manifestYaml });
  expect(report.errors).toEqual([]);
  expect(report.decisions[0]).toMatchObject({ verdict: 'block', reason: 'never_accepted' });
  // 汇总也不得因同 rule、同 file 的有效例外而放行。
  expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 1 });
});

it('[02 §12.6 不可豁免#5] 命中原文含私钥头时，即使检测段漏标 never_accepted 也按不可豁免阻断', () => {
  const manifestYaml = manifestWith({
    falsePositives: `false_positives:\n  - rule: private-key\n    file: ${FILE}\n    reason: 示例值\n`,
  });
  for (const match of [FAKE.privateKeyHeader, `x${FAKE.rsaPrivateKeyHeader}\nMIIE`]) {
    const report = run([hit({ rule: 'private-key', file: FILE, match, never_accepted: false })], {
      manifestYaml,
    });
    expect(report.decisions[0]).toMatchObject({ verdict: 'block', reason: 'never_accepted' });
    expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 1 }, match);
  }
});

it('[02 §12.6 不可豁免#6] 一个 never_accepted 命中让整份报告不通过，其余可放行命中照常放行', () => {
  const report = run(
    [
      hit({ rule: 'url', match: FAKE.apiUrl }),
      hit({ rule: RULE, file: FILE, never_accepted: true }),
    ],
    { platform: 'h5' },
  );
  expect(report.decisions.map((d) => d.verdict)).toEqual(['allow', 'block']);
  expectOutcome(report, { exit_code: 1, allowed: 1, blocked: 1 });
});

it('[02 §12.6 不可豁免#7] 阻断项在前、公开标识在后：整体仍阻断，逐项判定与汇总都对（最终结果不只取最后一项）', () => {
  const report = run(
    [
      hit({ rule: RULE, file: FILE, never_accepted: true }),
      hit({ rule: 'url', match: FAKE.apiUrl }),
    ],
    { platform: 'h5' },
  );
  expect(report.decisions.map((d) => [d.verdict, d.reason])).toEqual([
    ['block', 'never_accepted'],
    ['allow', 'public_id'],
  ]);
  expect(report.summary).toEqual({ total: 2, allowed: 1, blocked: 1 });
  expect(report.exit_code).toBe(1);
  expect(report.passed).toBe(false);
});

it('[02 §12.6 不可豁免#8][BR-ID-09] 同 rule、同 file、不同 line/match 的两条命中逐条独立判定（不按 rule+file 缓存放行）', () => {
  for (const order of [0, 1]) {
    const pub = hit({ rule: RULE, file: FILE, line: 3, match: FAKE.wxAppId });
    const secret = hit({
      rule: RULE,
      file: FILE,
      line: 7,
      match: FAKE.hex32,
      never_accepted: true,
    });
    const hits = order === 0 ? [pub, secret] : [secret, pub];
    const report = run(hits, { platform: 'ios' });
    const byLine = new Map(report.decisions.map((d) => [d.hit.line, [d.verdict, d.reason]]));
    expect(byLine.get(3), `order ${order}`).toEqual(['allow', 'public_id']);
    expect(byLine.get(7), `order ${order}`).toEqual(['block', 'never_accepted']);
    expect(report.decisions.map((d) => d.hit)).toEqual(hits);
    expect(report.summary).toEqual({ total: 2, allowed: 1, blocked: 1 });
    expect(report.exit_code).toBe(1);
    expect(report.passed).toBe(false);
  }
});
