// B3-05m: public synthetic fixtures only; never a real prompt, provider recording or account.
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import type {
  EvalInput,
  EvalPorts,
  EvalTurnOutput,
  LocalEvalAgentDeps,
  EvalToolCatalog,
} from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import type {
  ToolContext,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import type { ToolDefinition } from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { fixedClock, sequentialIds } from '../../../../packages/evals/src/record.ts';
import { textChunk, toolChunk, finishChunk, usageChunk } from '../model-openai-compat/kit.ts';

export const AT = '2026-10-22T03:04:05.000Z';
export const MODEL_TEXT = '合成评测回答。';
export const TOOL_ARGS = { q: '合成杯<num_1>', platform: 'taobao' };
export const DEFINITION: ToolDefinition = {
  name: 'search_products',
  description: '合成工具说明',
  parameters: {
    type: 'object',
    properties: { q: { type: 'string' }, platform: { type: 'string' } },
  },
};
export const GOOD: ToolOutcome = {
  kind: 'ok',
  modelView: { synthetic: '合成工具响应' },
  cards: [],
};
export function input(patch: Partial<EvalInput> = {}): EvalInput {
  return {
    case_id: 'synthetic-local-case',
    turn: 1,
    text: '合成保温杯',
    untrusted: false,
    subject: 'guest',
    switches: {},
    ...patch,
  };
}
export function catalog(definitions: readonly ToolDefinition[] = [DEFINITION]): EvalToolCatalog {
  return { definitions: async () => definitions, enabledSearchPlatforms: async () => [] };
}
export function dependencies(patch: Partial<LocalEvalAgentDeps> = {}): LocalEvalAgentDeps {
  return { clock: fixedClock(AT), ids: sequentialIds('synthetic-local'), ...patch };
}
export function modelOptions(): Omit<LocalEvalAgentDeps, 'clock' | 'ids'> {
  return {
    prompt: { current: async () => ({ version: 'synthetic@1', system: '合成评测提示词。' }) },
    route: async () => ({
      mode: 'models',
      dropped: [],
      attempts: [
        {
          id: 'synthetic-flash',
          vendor: 'qwen',
          tier: 'flash',
          model: 'qwen-flash-2026-10-01',
          evaluation: { report: 'synthetic-only', signed: true },
        },
      ],
    }),
    catalog: catalog(),
  };
}
export function ports(response: unknown = GOOD) {
  const model = vi.fn<EvalPorts['model']>(async (request) => {
    const hasTool = request.messages.some((m) => (m as { role?: string }).role === 'tool');
    return {
      chunks: hasTool
        ? [textChunk(MODEL_TEXT), finishChunk('stop'), usageChunk(10, 2)]
        : [
            toolChunk(0, {
              id: 'synthetic-call',
              name: 'search_products',
              args: JSON.stringify(TOOL_ARGS),
            }),
            finishChunk('tool_calls'),
            usageChunk(10, 2),
          ],
      usage: { input_tokens: 10, output_tokens: 2 },
    };
  });
  const tool = vi.fn<EvalPorts['tool']>(async () => response);
  return { model, tool };
}
export function context(): ToolContext {
  return {
    subject: {
      appId: 'couli',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip',
      userId: null,
      phoneBound: false,
      traceId: 'synthetic-trace',
    },
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: { '<num_1>': '123456' },
  };
}
export function textOf(output: EvalTurnOutput): string {
  return output.frames
    .filter((f) => f.event === 'text.delta')
    .map((f) => String(f.data['delta']))
    .join('');
}
export function fileText(key: string): string {
  const doc = JSON.parse(
    readFileSync(new URL('../../../../contracts/texts.default.json', import.meta.url), 'utf8'),
  ) as { texts: Record<string, string> };
  return doc.texts[key]!;
}
