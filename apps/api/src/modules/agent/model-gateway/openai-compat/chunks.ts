import type { VendorUsage } from '../vendors/index.ts';
import { isRecord, malformed, tokenCount } from './errors.ts';
import type { AssembledToolCall, ModelEvent } from './types.ts';

type FinishReason = Extract<ModelEvent, { t: 'done' }>['reason'];
interface PendingTool {
  id: string;
  name: string;
  args: string;
}

function finishReason(value: unknown): FinishReason {
  if (
    value === 'stop' ||
    value === 'tool_calls' ||
    value === 'length' ||
    value === 'content_filter'
  ) {
    return value;
  }
  throw malformed();
}

function addTool(value: unknown, tools: Map<number, PendingTool>): void {
  if (!isRecord(value) || !tokenCount(value.index) || !isRecord(value.function)) throw malformed();
  if (value.type !== undefined && value.type !== 'function') throw malformed();
  const fn = value.function;
  const pending = tools.get(value.index) ?? { id: '', name: '', args: '' };
  if (value.id !== undefined && value.id !== null) {
    if (typeof value.id !== 'string' || (pending.id !== '' && pending.id !== value.id))
      throw malformed();
    pending.id = value.id;
  }
  if (fn.name !== undefined && fn.name !== null) {
    if (typeof fn.name !== 'string') throw malformed();
    pending.name += fn.name;
  }
  if (fn.arguments !== undefined && fn.arguments !== null) {
    if (typeof fn.arguments !== 'string') throw malformed();
    pending.args += fn.arguments;
  }
  tools.set(value.index, pending);
}

function completedTools(tools: Map<number, PendingTool>): ModelEvent[] {
  const ids = new Set<string>();
  return [...tools.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, tool]) => {
      if (tool.id === '' || tool.name === '' || ids.has(tool.id)) throw malformed();
      ids.add(tool.id);
      let args: unknown;
      try {
        args = JSON.parse(tool.args) as unknown;
      } catch {
        throw malformed();
      }
      if (!isRecord(args)) throw malformed();
      const call: AssembledToolCall = {
        id: tool.id,
        type: 'function',
        function: { name: tool.name, arguments: tool.args },
      };
      return { t: 'tool_call', index, call };
    });
}

/** 只接受单个 completion；不把不同 choice 的工具片段混合。 */
export function assembleChunks(chunks: readonly unknown[]): ModelEvent[] {
  const events: ModelEvent[] = [];
  const tools = new Map<number, PendingTool>();
  let done = false;
  for (const chunk of chunks) {
    if (!isRecord(chunk) || !Array.isArray(chunk.choices) || chunk.error !== undefined)
      throw malformed();
    if (chunk.choices.length > 1) throw malformed();
    for (const choice of chunk.choices as unknown[]) {
      if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.delta) || done)
        throw malformed();
      const delta = choice.delta;
      if (delta.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== 'string') throw malformed();
        if (delta.content !== '') events.push({ t: 'text_delta', text: delta.content });
      }
      // reasoning_content 等内部思考字段不进入面向调用方的事件。
      if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
        if (!Array.isArray(delta.tool_calls)) throw malformed();
        for (const tool of delta.tool_calls as unknown[]) addTool(tool, tools);
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        const reason = finishReason(choice.finish_reason);
        if (reason === 'tool_calls') {
          if (tools.size === 0) throw malformed();
          for (const event of completedTools(tools)) events.push(event);
        } else if (reason === 'stop' && tools.size > 0) {
          throw malformed();
        }
        // length/content_filter 的未完成工具调用绝不发布为可执行事件。
        events.push({ t: 'done', reason });
        done = true;
      }
    }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      const usage = chunk.usage;
      if (
        !isRecord(usage) ||
        !tokenCount(usage.prompt_tokens) ||
        !tokenCount(usage.completion_tokens)
      ) {
        throw malformed();
      }
      let cached: number | null = null;
      if (usage.prompt_tokens_details !== undefined && usage.prompt_tokens_details !== null) {
        if (!isRecord(usage.prompt_tokens_details)) throw malformed();
        const value = usage.prompt_tokens_details.cached_tokens;
        if (value !== undefined && value !== null) {
          if (!tokenCount(value) || value > usage.prompt_tokens) throw malformed();
          cached = value;
        }
      }
      events.push({
        t: 'usage',
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        cached,
      });
    }
  }
  if (!done) throw malformed();
  return events;
}

/** usage 为累计值，取最后一片，不能把重复上报的计数相加。 */
export function usageOf(events: readonly ModelEvent[]): VendorUsage {
  let usage = { input_tokens: 0, output_tokens: 0 };
  for (const event of events) {
    if (event.t !== 'usage') continue;
    if (!tokenCount(event.input) || !tokenCount(event.output)) throw malformed();
    usage = { input_tokens: event.input, output_tokens: event.output };
  }
  return usage;
}
