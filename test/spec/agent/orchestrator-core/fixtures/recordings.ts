// Synthetic OpenAI-compatible recordings only. No real provider payloads or private prompts.
import type {
  AssembledToolCall,
  ChatMessage,
} from '../../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import type { VendorResponse } from '../../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';

export interface ReplayTurn {
  readonly parts?: readonly string[];
  readonly calls?: readonly AssembledToolCall[];
  /** Expected tool messages, independently supplied by each test. */
  readonly views?: readonly unknown[];
  readonly finish?: 'stop' | 'tool_calls' | 'content_filter' | 'length';
}

export function toolCall(
  id: string,
  args: unknown = { q: '合成保温杯' },
  name = 'search_products',
): AssembledToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

export function response(turn: ReplayTurn): VendorResponse {
  return {
    chunks: [
      ...(turn.parts ?? []).map((content) => ({ choices: [{ index: 0, delta: { content } }] })),
      ...(turn.calls ?? []).map((call, index) => ({
        choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] } }],
      })),
      {
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: turn.finish ?? (turn.calls?.length ? 'tool_calls' : 'stop'),
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      },
    ],
    usage: { input_tokens: 20, output_tokens: 10 },
  };
}

export function appendExpected(messages: ChatMessage[], turn: ReplayTurn): void {
  if (!turn.calls?.length) return;
  messages.push({
    role: 'assistant',
    content: turn.parts?.join('') || null,
    tool_calls: turn.calls,
  });
  turn.calls.forEach((call, i) => {
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(turn.views?.[i] ?? {}),
    });
  });
}

export const filteredText: ReplayTurn = {
  parts: ['只要29.', '9元，点 https://example.invalid/item 。', '可看卡片。', '不应显示第三句。'],
};

export const referenceView = {
  cards: [
    {
      ref: 'synthetic-card-a',
      title: '<untrusted>合成保温杯</untrusted>',
      platform: 'taobao',
      benefit_tags: [],
    },
  ],
};
