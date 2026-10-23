import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, vi } from 'vitest';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { ToolOutcome } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import type {
  RuleChunkRow,
  RulesDeps,
} from '../../../../apps/api/src/modules/agent/tools/rules/index.ts';

export function context(patch: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
    phoneBound: true,
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {},
    ...patch,
  };
}

export function subject(ctx: ToolCallContext): AgentCaller {
  return {
    appId: ctx.appId,
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    phoneBound: ctx.phoneBound,
    deviceHash: 'synthetic-device-hash',
    ipKey: 'synthetic-ip',
    traceId: 'synthetic-trace',
  };
}

export function chunk(id: number, title: string, text: string): RuleChunkRow {
  return {
    chunk_id: `019a0000-0000-7000-8000-${String(id).padStart(12, '0')}`,
    article_id: `019b0000-0000-7000-8000-${String(id).padStart(12, '0')}`,
    published_version: 12,
    title,
    text,
  };
}

export function fixture(rows: readonly RuleChunkRow[] = [], minScore: unknown = 0.2) {
  const activeChunks = vi.fn<RulesDeps['activeChunks']>(async () => rows);
  const config = vi.fn<RulesDeps['config']>(async () => minScore);
  const texts = vi.fn<NonNullable<RulesDeps['texts']>>(async (_app, key) => `合成字典：${key}`);
  const deps: RulesDeps = { activeChunks, config, texts };
  return { activeChunks, config, texts, deps };
}

export function ok(result: ToolOutcome) {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error('Expected ok after assertion');
  return result;
}

export function chunkIds(result: ToolOutcome) {
  return ok(result).cards.map((card) => card.data['chunk_id']);
}

export function validator(schema: unknown) {
  // 使用 API 已安装的 Ajv2020，测试包不另装依赖。
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
    Ajv2020: new (options: { strict: true }) => {
      compile(schema: unknown): (value: unknown) => boolean;
    };
  };
  return new Ajv2020({ strict: true }).compile(schema);
}

export function ruleCardValidator() {
  const schema = JSON.parse(
    readFileSync(
      new URL('../../../../contracts/agent-stream.schema.json', import.meta.url),
      'utf8',
    ),
  ) as { $defs: Record<string, unknown> };
  return validator({ $defs: schema.$defs, $ref: '#/$defs/card_rule_ref' });
}
