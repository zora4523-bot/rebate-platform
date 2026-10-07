import type { VendorId, VendorRequest } from '../vendors/index.ts';
import { isRecord, malformed, ModelProtocolError } from './errors.ts';
import type { ChatInput, ModelRequestShape, VendorQuirks } from './types.ts';

function assertVendor(vendor: string): asserts vendor is VendorId {
  if (vendor !== 'qwen' && vendor !== 'glm') {
    throw new ModelProtocolError('bad_request', 'Unknown model vendor');
  }
}

export function quirksFor(
  vendor: VendorId,
  overrides: Partial<Omit<VendorQuirks, 'pinnedModel'>> = {},
): VendorQuirks {
  assertVendor(vendor);
  return Object.freeze({
    thinking: overrides.thinking ?? (vendor === 'qwen' ? 'disable' : 'omit'),
    explicitCache: overrides.explicitCache ?? false,
    includeUsage: overrides.includeUsage ?? true,
    // TODO(规划/11 §6): GLM 日期快照命名 — blocked on CAP-X-19 实测与型号选定
    pinnedModel: vendor === 'qwen' ? /^qwen[\w.-]*-\d{4}-\d{2}-\d{2}$/ : /(?!)/,
    contentRefusalCodes: Object.freeze([...(overrides.contentRefusalCodes ?? [])]),
  });
}

export function assertPinnedModel(model: string, quirks: VendorQuirks): void {
  // 用副本避免带 g/y 的配置正则在重复调用时改变结论。
  const pattern = new RegExp(quirks.pinnedModel.source, quirks.pinnedModel.flags);
  const match = typeof model === 'string' ? pattern.exec(model) : null;
  if (!model || match?.[0] !== model || /latest/i.test(model)) {
    throw new ModelProtocolError('model_not_pinned', 'A pinned model snapshot is required');
  }
}

export function buildModelRequest(input: ChatInput, quirks: VendorQuirks): ModelRequestShape {
  assertVendor(input.vendor);
  assertPinnedModel(input.model, quirks);
  if (input.messages.some((message) => message.role === 'system')) {
    throw new ModelProtocolError('bad_request', 'System content must use the fixed prefix');
  }
  const names = new Set(input.tools.map((tool) => tool.name));
  if (names.size !== input.tools.length) {
    throw new ModelProtocolError('bad_request', 'Duplicate tool definition');
  }
  const params: Record<string, unknown> = { stream: true, tool_choice: 'auto' };
  if (quirks.includeUsage) params.stream_options = { include_usage: true };
  if (quirks.thinking === 'disable') params.enable_thinking = false;
  for (const key of ['temperature', 'top_p', 'seed', 'max_tokens'] as const) {
    const value = input.sampling?.[key];
    if (value === undefined) continue;
    if (
      !Number.isFinite(value) ||
      (key === 'temperature' && (value < 0 || value > 2)) ||
      (key === 'top_p' && (value <= 0 || value > 1)) ||
      (key === 'seed' && !Number.isSafeInteger(value)) ||
      (key === 'max_tokens' && (!Number.isSafeInteger(value) || value <= 0))
    ) {
      throw new ModelProtocolError('bad_request', 'Invalid sampling parameter');
    }
    params[key] = value;
  }
  const system = {
    role: 'system',
    content: quirks.explicitCache
      ? [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }]
      : input.system,
  };
  return structuredClone({
    vendor: input.vendor,
    model: input.model,
    messages: [system, ...input.messages],
    tools: [...input.tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    params,
  });
}

export function toVendorRequest(req: ModelRequestShape): VendorRequest {
  assertVendor(req.vendor);
  if (['model', 'messages', 'tools'].some((key) => Object.hasOwn(req.params, key))) {
    throw malformed();
  }
  return structuredClone({
    vendor: req.vendor,
    model: req.model,
    body: { ...req.params, model: req.model, messages: req.messages, tools: req.tools },
  });
}

export function fromVendorRequest(req: VendorRequest): ModelRequestShape {
  assertVendor(req.vendor);
  if (!isRecord(req.body)) throw malformed();
  const { model, messages, tools, ...params } = req.body;
  if (
    model !== req.model ||
    typeof model !== 'string' ||
    !Array.isArray(messages) ||
    !Array.isArray(tools)
  ) {
    throw malformed();
  }
  return structuredClone({ vendor: req.vendor, model, messages, tools, params });
}
