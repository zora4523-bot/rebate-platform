// 发布制品扫描第一段：把检测命中项与 specs/client-public-ids.yaml 比对，出报告与退出码
// （规划/02 §12.6「安装包里只放公开标识」与放行两类、不可豁免；05 QA-09；BR-ID-09 请求签名材料与共享盐不得内置）。
// 检测规则、制品解包与命令行入口在 QA-09b（infra/release-scan/detect/**、cli.ts）。
// 清单文件不写取值：「类别 → 格式」对照表写在本段实现里（plan.md Q8）；YAML 只用 tools/lib/yaml-lite.ts 解析。
// 判定顺序：never_accepted → 公开标识（类别格式 + 所在端）→ false_positives（rule + file 全等）→
// exceptions（rule + file 全等，且 approval 指向 ops/approvals.yaml 里 granted 为 true 的批准）→ 其余阻断。

import { readManifest } from './manifest.ts';
import { isPublicId, containsPrivateKey } from './public-ids.ts';

import type { CompareInput, CompareReport, DecisionReason, HitDecision } from './types.ts';

export type {
  ApprovalRecord,
  ClientPlatform,
  CompareInput,
  CompareReport,
  DecisionReason,
  HitDecision,
  PublicIdCategory,
  ScanHit,
} from './types.ts';

export function compareHits(input: CompareInput): CompareReport {
  const { manifest, errors } = readManifest(input.manifestYaml);
  const decisions = input.hits.map((hit): HitDecision => {
    const block = (reason: DecisionReason): HitDecision => ({
      hit,
      verdict: 'block',
      reason,
      basis: null,
    });
    const allow = (reason: DecisionReason, basis: string): HitDecision => ({
      hit,
      verdict: 'allow',
      reason,
      basis,
    });
    if (!manifest) return block('manifest_invalid');
    if (hit.never_accepted || containsPrivateKey(hit.match)) return block('never_accepted');

    const item = manifest.items.find(
      (entry) => entry.platforms.includes(input.platform) && isPublicId(entry, hit),
    );
    if (item) return allow('public_id', item.id);

    const matches = (entry: { rule: string; file: string }): boolean =>
      entry.rule === hit.rule && entry.file === hit.file;
    const fp = manifest.false_positives.findIndex(matches);
    if (fp !== -1) return allow('false_positive', `false_positives[${fp}]`);

    const approved = manifest.exceptions.findIndex((entry) => {
      if (!matches(entry)) return false;
      // 重复 id 不是明确的批准记录，不能取其中一条 true 就放行。
      const records = input.approvals.filter((record) => record.id === entry.approval);
      return records.length === 1 && records[0]?.granted === true;
    });
    if (approved !== -1) return allow('exception', `exceptions[${approved}]`);
    return block(manifest.exceptions.some(matches) ? 'exception_unapproved' : 'unlisted');
  });
  const allowed = decisions.filter((decision) => decision.verdict === 'allow').length;
  const blocked = decisions.length - allowed;
  const exit_code = !manifest ? 2 : blocked > 0 ? 1 : 0;
  return {
    platform: input.platform,
    exit_code,
    passed: exit_code === 0,
    decisions,
    errors,
    summary: { total: decisions.length, allowed, blocked },
  };
}
