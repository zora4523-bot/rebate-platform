import type { RedactedText as AdmissionRedactedText } from '../../stream/admission/index.ts';
import type { RedactedText as DegradedRedactedText } from '../../model-gateway/degraded/index.ts';

/** BR-AI-14 / BR-AI-19：同时兼容存储接纳与无模型降级的脱敏文本。 */
export type AgentRedactedText = AdmissionRedactedText & DegradedRedactedText;

/** 仅存活于服务端本 run；键是完整的 <num_k>，值是原始长数字字符串。 */
export type PlaceholderTable = Readonly<Record<string, string>>;

export interface AgentRedactor {
  redact(appId: string, text: string): Promise<AgentRedactedText>;
}

/** 存储形态：自由文本长数字只保留后四位，不生成占位表。 */
export function createAgentRedactor(): AgentRedactor {
  throw new Error('NotImplemented: createAgentRedactor');
}

/** 先移出全部链接与口令，再对剩余自由文本应用 BR-AI-14 脱敏表。 */
export function redactForModel(text: string): {
  text: AgentRedactedText;
  placeholders: PlaceholderTable;
} {
  void text;
  throw new Error('NotImplemented: redactForModel');
}

/** 递归复制工具参数，仅还原与表键完全一致的字符串值。 */
export function restorePlaceholders(value: unknown, table: PlaceholderTable): unknown {
  void value;
  void table;
  throw new Error('NotImplemented: restorePlaceholders');
}

/** BR-AI-19：工具参数落库前递归转换为存储形态，不修改输入。 */
export function maskForTrace(value: unknown): unknown {
  void value;
  throw new Error('NotImplemented: maskForTrace');
}
