import type { Scheduler } from '../../../platform/index.ts';
import type { SentenceReviewPort } from '../../guard/index.ts';
import type { AgentRunTexts, InputCheckPort } from '../../orchestrator/index.ts';

export interface InputCheckDeps {
  readonly review: SentenceReviewPort;
  readonly scheduler: Scheduler;
  /** agent.safety.timeout_ms；未提供时使用 BR-AI-18 的默认 1000ms。 */
  readonly timeoutMs?: () => number;
  readonly texts: Pick<AgentRunTexts, 'text'>;
}

export interface InputKeywordLists {
  readonly advice: readonly string[];
  readonly prohibited: readonly string[];
}

/** YAML 保存正则源字符串，不保存 RegExp 对象；匹配用户原文中的参数与标识。 */
export interface PageGuideParamPatterns {
  readonly patterns: readonly string[];
}

/** B3-05b InputCheckPort；模型文本与占位表接 B3-05a redactForModel。 */
export function createInputCheck(deps: InputCheckDeps): InputCheckPort {
  void deps;
  throw new Error('NotImplemented: createInputCheck');
}

export function inputKeywordLists(): InputKeywordLists {
  throw new Error('NotImplemented: inputKeywordLists');
}

export function pageGuideParamPatterns(): PageGuideParamPatterns {
  throw new Error('NotImplemented: pageGuideParamPatterns');
}
