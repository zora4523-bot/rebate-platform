import { expect, it } from 'vitest';
import type { ApprovalRecord } from '../../../../infra/release-scan/compare/index.ts';
import { expectOutcome, hit, manifestWith, run } from './fixtures.ts';

// 02 §12.6 安全豁免：exceptions 只收负责人批准的 SDK 随包配置，每条 {sdk, item, scope_if_leaked,
// server_side_limit, approval}；「负责人已同意」只认 ops/approvals.yaml（AGENTS.md 开头）。
// 口径：approval 写 ops/approvals.yaml 的 id（整数），该 id 存在且 granted 为 true 才生效；
// 条目另须写 rule、file 指明放行哪条命中（同误报过滤，全等比较）。

const FILE = 'res/raw/sdk-config.json';
const RULE = 'sdk-embedded-key';

function exception(approval: string, extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    sdk: '示例推送 SDK',
    item: '随包配置里的客户端密钥',
    rule: RULE,
    file: FILE,
    scope_if_leaked: '只能注册设备，不能下发推送',
    server_side_limit: '服务端按设备限流，可在控制台随时更换',
    ...extra,
  };
  const lines = Object.entries(fields).map(([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${v}`);
  if (approval !== '') lines.push(`    approval: ${approval}`);
  return `exceptions:\n${lines.join('\n')}\n`;
}

function decideWith(exceptions: string, approvals?: readonly ApprovalRecord[]) {
  return run([hit({ rule: RULE, file: FILE })], {
    manifestYaml: manifestWith({ exceptions }),
    ...(approvals === undefined ? {} : { approvals }),
  });
}

it('[02 §12.6 安全豁免#1] approval 指向 granted=true 的批准记录时放行，依据指向条目下标', () => {
  const report = decideWith(exception('30'));
  expect(report.errors).toEqual([]);
  expect(report.decisions[0]).toMatchObject({
    verdict: 'allow',
    reason: 'exception',
    basis: 'exceptions[0]',
  });
  expectOutcome(report, { exit_code: 0, allowed: 1, blocked: 0 });
});

it('[02 §12.6 安全豁免#2] approval 指向 granted=false 的记录、或批准清单里没有的 id，不放行', () => {
  for (const approval of ['31', '99']) {
    const report = decideWith(exception(approval));
    expect(report.decisions[0], approval).toMatchObject({
      verdict: 'block',
      reason: 'exception_unapproved',
      basis: null,
    });
    expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 1 }, approval);
  }
});

it('[02 §12.6 安全豁免#3] 没写 approval、或 approval 不是批准记录 id（文字说明）时不放行', () => {
  for (const approval of ['', '负责人已同意', "'30'"]) {
    const report = decideWith(exception(approval));
    expect(report.decisions[0], approval).toMatchObject({ verdict: 'block' });
    expect(report.decisions[0]?.reason).not.toBe('exception');
    expect([1, 2], approval).toContain(report.exit_code);
    expect(report.passed, approval).toBe(false);
    expect(report.summary, approval).toEqual({ total: 1, allowed: 0, blocked: 1 });
  }
});

it('[02 §12.6 安全豁免#4] 批准清单为空时，任何例外条目都不生效', () => {
  const report = decideWith(exception('30'), []);
  expect(report.decisions[0]).toMatchObject({ verdict: 'block', reason: 'exception_unapproved' });
  expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 1 });
});

it('[02 §12.6 安全豁免#5] 例外只放行写明的 rule 与 file：别的文件或别的规则照旧阻断', () => {
  const manifestYaml = manifestWith({ exceptions: exception('30') });
  const report = run(
    [
      hit({ rule: RULE, file: 'res/raw/other.json' }),
      hit({ rule: 'generic-high-entropy', file: FILE }),
    ],
    { manifestYaml },
  );
  expect(report.decisions.map((d) => [d.verdict, d.reason])).toEqual([
    ['block', 'unlisted'],
    ['block', 'unlisted'],
  ]);
  expectOutcome(report, { exit_code: 1, allowed: 0, blocked: 2 });
});

it('[02 §12.6 安全豁免#6] 缺 scope_if_leaked / server_side_limit（泄露后果与服务端限制）的条目使清单无效，退出码 2', () => {
  for (const extra of [{ scope_if_leaked: "''" }, { server_side_limit: "''" }]) {
    const report = decideWith(exception('30', extra));
    expectOutcome(report, { exit_code: 2, allowed: 0, blocked: 1 });
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.decisions[0]).toMatchObject({ verdict: 'block', reason: 'manifest_invalid' });
  }
});
