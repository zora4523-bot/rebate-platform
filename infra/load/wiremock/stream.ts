import { object } from './recordings.ts';

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export function validateToolCall(value: unknown): ToolCall {
  if (value === undefined) {
    return {
      name: 'search_products',
      arguments: { q: '合成保温杯', platforms: ['taobao', 'jd', 'pdd'], sort: 'relevance' },
    };
  }
  const tool = object(value);
  const name = tool['name'];
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error('Invalid tool name');
  }
  const args = object(tool['arguments']);
  // Refuse values that JSON serialization would silently drop or coerce.
  const serialized = JSON.stringify(args, (_key, item: unknown) => {
    if (
      item === undefined ||
      typeof item === 'function' ||
      typeof item === 'symbol' ||
      (typeof item === 'number' && !Number.isFinite(item))
    ) {
      throw new Error('Tool arguments must be JSON values');
    }
    return item;
  });
  return { name, arguments: object(JSON.parse(serialized) as unknown) };
}

/** Synthetic OpenAI-compatible SSE frames; fixed metadata is fixture data, not wall time. */
export function streamBody(turn: 'tool' | 'text', tool: ToolCall): string {
  const chunks: unknown[] = [];
  const metadata = {
    id: 'load-synthetic',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'couli-synthetic',
  };
  const delta = (value: unknown, finish: string | null = null) => {
    chunks.push({ ...metadata, choices: [{ index: 0, delta: value, finish_reason: finish }] });
  };
  delta({ role: 'assistant' });
  if (turn === 'tool') {
    const args = JSON.stringify(tool.arguments);
    const boundary = Math.max(1, Math.floor(args.length / 2));
    delta({
      tool_calls: [
        {
          index: 0,
          id: 'call_load',
          type: 'function',
          function: { name: tool.name, arguments: args.slice(0, boundary) },
        },
      ],
    });
    delta({ tool_calls: [{ index: 0, function: { arguments: args.slice(boundary) } }] });
    delta({}, 'tool_calls');
  } else {
    delta({ content: '合成应答：已完成查询。' });
    delta({ content: '请查看工具返回的商品信息。' });
    delta({}, 'stop');
  }
  chunks.push({
    ...metadata,
    choices: [],
    usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 },
  });
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}
