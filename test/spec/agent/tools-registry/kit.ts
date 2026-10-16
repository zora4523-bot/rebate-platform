import { vi } from 'vitest';
import type {
  ToolDefinition,
  ToolHandler,
  ToolRegistryDeps,
} from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { createToolRegistry } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import type {
  OrchestratorToolCall,
  ToolContext,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';

// Synthetic schemas test registry mechanics, not B3-04b/c business schemas.
export function definition(name = 'search_products'): ToolDefinition {
  return {
    name,
    description: '合成工具定义',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['q'],
      properties: {
        q: { type: 'string', minLength: 1 },
        platform: { type: 'string', enum: ['taobao', 'jd', 'pdd'] },
        filters: {
          type: 'object',
          additionalProperties: false,
          properties: { label: { type: 'string' } },
        },
        choices: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { label: { type: 'string' } },
          },
        },
      },
    },
  };
}

export function handler(name = 'search_products', audience: ToolHandler['audience'] = 'all') {
  return {
    name,
    audience,
    definition: definition(name),
    run: vi.fn<ToolHandler['run']>(async () => ({
      kind: 'ok',
      modelView: { card_id: 'synthetic-card' },
      cards: [],
    })),
  };
}

export function subject(userId: string | null = 'synthetic-user', phoneBound = true) {
  return {
    appId: 'synthetic-app',
    userId,
    phoneBound,
    deviceId: 'synthetic-device',
    deviceHash: 'synthetic-device-hash',
    ipKey: 'synthetic-ip-key',
    traceId: 'synthetic-trace',
  };
}

export function toolContext(patch: Partial<ToolContext> = {}): ToolContext {
  return {
    subject: subject(),
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {},
    ...patch,
  };
}

export function call(
  args: unknown = { q: '合成牛奶' },
  name = 'search_products',
): OrchestratorToolCall {
  return { id: 'synthetic-call', name, args };
}

export function setup(handlers: readonly ToolHandler[] = [handler()]) {
  const get = vi.fn<ToolRegistryDeps['switches']['get']>(async () => true);
  const warn = vi.fn();
  const deps: ToolRegistryDeps = { handlers, switches: { get }, logger: { warn } };
  // Every test reaches this stub before catching expected failures: NotImplemented stays red.
  const registry = createToolRegistry(deps);
  return { registry, deps, get, warn };
}

export const rejected: ToolOutcome = { kind: 'rejected', modelView: { error: 'invalid_args' } };
