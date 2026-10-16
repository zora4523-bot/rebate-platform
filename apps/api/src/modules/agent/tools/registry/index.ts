// B3-04a · BR-AI-02 / BR-AI-03 / BR-AI-11: ToolRegistry, the OrchestratorTools behind the run body.
// Registration fails loudly on unsafe schemas; execution rejects (never repairs) bad arguments and
// injects identity only from the authenticated caller.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { RootLogger } from '../../../platform/index.ts';
import { IDENTITY_FIELDS, decideToolCall, normalizeIdentityKey } from '../../guard/index.ts';
import type { AgentCaller } from '../../http/index.ts';
import type { OrchestratorTools, ToolContext, ToolOutcome } from '../../orchestrator/index.ts';

export type ToolDefinition = Awaited<ReturnType<OrchestratorTools['definitions']>>[number];

/** Authenticated subject only; never merge model arguments into this context. */
export interface ToolCallContext extends Pick<
  ToolContext['subject'],
  'appId' | 'userId' | 'deviceId' | 'phoneBound'
> {
  readonly runId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly context?: ToolContext['context'];
  readonly placeholders: Readonly<Record<string, string>>;
}

export interface ToolHandler {
  readonly name: string;
  readonly definition: ToolDefinition;
  readonly audience: 'all' | 'phone_bound';
  run(args: Readonly<Record<string, unknown>>, toolCtx: ToolCallContext): Promise<ToolOutcome>;
}

export interface ToolSwitches {
  /** Only an explicit true enables the tool; unavailable settings fail closed. */
  get(appId: string, key: `agent.tools.${string}.enabled`): Promise<boolean | undefined>;
}

export interface ToolRegistryDeps {
  readonly handlers: readonly ToolHandler[];
  readonly switches: ToolSwitches;
  readonly logger?: Pick<RootLogger, 'warn'>;
}

interface Entry {
  readonly handler: ToolHandler;
  readonly definition: ToolDefinition;
  readonly validate: ValidateFunction;
}

function rejected(): ToolOutcome {
  return { kind: 'rejected', modelView: { error: 'invalid_args' } };
}

/** Generic failure view: the handler's message and stack never reach the model. */
function failed(): ToolOutcome {
  return { kind: 'failed', modelView: { error: 'tool_failed' } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** BR-AI-03: every object schema is closed and no property, at any depth, is an identity key. */
function assertSafeSchema(tool: string, parameters: unknown): void {
  const forbidden = new Set(IDENTITY_FIELDS.map(normalizeIdentityKey));
  if (!isRecord(parameters) || parameters['type'] !== 'object') {
    throw new Error(`Tool ${tool}: parameters must be an object schema`);
  }
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, `${path}/${index}`);
      });
      return;
    }
    if (!isRecord(node)) return;
    if (
      (node['type'] === 'object' || node['properties'] !== undefined) &&
      node['additionalProperties'] !== false
    ) {
      throw new Error(`Tool ${tool}: ${path || '/'} must set additionalProperties=false`);
    }
    const properties = node['properties'];
    if (isRecord(properties)) {
      for (const key of Object.keys(properties)) {
        if (forbidden.has(normalizeIdentityKey(key))) {
          throw new Error(`Tool ${tool}: ${path}/properties declares identity field ${key}`);
        }
      }
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${path}/${key}`);
  };
  visit(parameters, '');
}

function compileEntries(handlers: readonly ToolHandler[]): ReadonlyMap<string, Entry> {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  const entries = new Map<string, Entry>();
  for (const handler of handlers) {
    const name = handler.name;
    if (handler.definition.name !== name) {
      throw new Error(`Tool ${name}: definition name ${handler.definition.name} does not match`);
    }
    if (entries.has(name)) throw new Error(`Tool ${name}: registered twice`);
    // Own copy: later edits to the handler object cannot change what was checked and compiled.
    const definition = structuredClone(handler.definition);
    assertSafeSchema(name, definition.parameters);
    const validate = ajv.compile(definition.parameters);
    entries.set(name, { handler, definition, validate });
  }
  return entries;
}

function audienceAllows(handler: ToolHandler, subject: AgentCaller): boolean {
  // BR-AI-11 via BR-AI-01: order and earnings tools only for a phone-bound user.
  return handler.audience === 'all' || (subject.userId !== null && subject.phoneBound);
}

async function switchEnabled(switches: ToolSwitches, appId: string, tool: string) {
  try {
    return (await switches.get(appId, `agent.tools.${tool}.enabled`)) === true;
  } catch {
    // Unreadable setting: the tool is off for this call, the model sees no error.
    return false;
  }
}

/** Built from the server-side caller and run metadata only; model arguments never flow in. */
function callContext(ctx: ToolContext): ToolCallContext {
  const { appId, userId, deviceId, phoneBound } = ctx.subject;
  return Object.freeze({
    appId,
    userId,
    deviceId,
    phoneBound,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    ...(ctx.context === undefined ? {} : { context: ctx.context }),
    placeholders: ctx.placeholders,
  });
}

/** B3-04a: schema validation, decideToolCall, subject filtering and server context injection.
 * JSON parsing and tool_calls trace assembly belong to the existing orchestrator.
 * AgentCaller currently has no scene or promotion fields: do not infer them from args/context.
 * The two keyword fallback methods of OrchestratorTools have no reader in this task.
 */
export function createToolRegistry(deps: ToolRegistryDeps): OrchestratorTools {
  const entries = compileEntries(deps.handlers);
  const { switches, logger } = deps;

  return {
    async definitions(appId, subject) {
      const candidates = [...entries.values()].filter((entry) =>
        audienceAllows(entry.handler, subject),
      );
      const enabled = await Promise.all(
        candidates.map((entry) => switchEnabled(switches, appId, entry.handler.name)),
      );
      return candidates.filter((_, index) => enabled[index]).map((entry) => entry.definition);
    },

    async execute(call, ctx) {
      const entry = entries.get(call.name);
      const schemaValid = entry !== undefined && entry.validate(call.args) === true;
      const decision = decideToolCall({ schemaValid, args: call.args });
      if (decision.kind === 'reject') {
        // One alert per call, however many identity keys were sent; other failures stay silent.
        if (decision.alert) {
          logger?.warn(
            {
              event: 'agent.identity_arg',
              tool: call.name,
              fields: decision.identityFields,
              appId: ctx.subject.appId,
              runId: ctx.runId,
            },
            'agent.identity_arg',
          );
        }
        return rejected();
      }
      // schemaValid implies a registered entry and a plain-object argument.
      if (entry === undefined || !isRecord(call.args)) return rejected();
      const { handler } = entry;
      if (!audienceAllows(handler, ctx.subject)) return rejected();
      if (!(await switchEnabled(switches, ctx.subject.appId, handler.name))) return rejected();
      if (ctx.signal.aborted) return failed();
      try {
        return await handler.run(call.args, callContext(ctx));
      } catch {
        // Includes aborts through ctx.signal (the caller owns the timeout).
        return failed();
      }
    },

    // Keyword fallback (degraded path) is wired by the search tool task; nothing is enabled here.
    async enabledSearchPlatforms() {
      return [];
    },

    async searchKeyword() {
      return { results: [], cards: [] };
    },
  };
}

export function registeredToolNames(handlers: readonly ToolHandler[]): readonly string[] {
  return handlers.map((handler) => handler.name);
}
