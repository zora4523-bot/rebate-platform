import { expect, it, vi } from 'vitest';
import {
  buildModelRequest,
  quirksFor,
  toVendorRequest,
} from '../../model-gateway/openai-compat/index.ts';
import type { RunBody } from '../../stream/run/index.ts';
import type { OrchestratorTrace } from '../core/ports.ts';
import { createEvalAgent, isRecordingMiss } from './index.ts';
import type { EvalBindings, EvalInput, EvalPorts } from './index.ts';

// Synthetic only. The body stands in for router + RunBody: primary, then backup, then the
// no-model degrade, each model call going through the adapter's port transport.
const PRIMARY = 'qwen-primary-2026-09-01';
const BACKUP = 'qwen-backup-2026-09-01';

const evalInput: EvalInput = {
  case_id: 'synthetic-eval-unit',
  turn: 1,
  text: '合成保温杯',
  untrusted: true,
  subject: 'guest',
  switches: {},
};

class SyntheticRecordingMiss extends Error {
  readonly kind = 'model';
  readonly key = 'synthetic-key';
  constructor() {
    super('no model recording for key synthetic-key');
    this.name = 'RecordingMiss';
  }
}

function rateLimited(): Error {
  return Object.assign(new Error('429 Too Many Requests'), { status: 429 });
}

function trace(model: string | null, intent: string | null): OrchestratorTrace {
  return {
    intent,
    model,
    attempts: [],
    prompt_version: 'synthetic-v1',
    tool_calls: [],
    output_filtered: false,
    filter_hits: [],
    output_truncated: false,
    model_format_invalid: false,
  };
}

function routedBody(bindings: EvalBindings): RunBody {
  return async (ctx) => {
    for (const model of [PRIMARY, BACKUP]) {
      const request = buildModelRequest(
        { vendor: 'qwen', model, system: '合成系统前缀', tools: [], messages: [] },
        quirksFor('qwen'),
      );
      try {
        await bindings.transport.send(toVendorRequest(request));
      } catch {
        continue;
      }
      ctx.text(`来自${model}`);
      bindings.trace.record(ctx.runId, trace(model, 'search'));
      return { kind: 'done', finishReason: 'stop' };
    }
    ctx.text('合成降级回答');
    bindings.trace.record(ctx.runId, trace(null, null));
    return { kind: 'done', finishReason: 'fallback' };
  };
}

function agent() {
  return createEvalAgent({
    createRun: (_input, bindings) => ({
      body: routedBody(bindings),
      firstCardNo: 1,
      quotaLeft: 4,
      meta: {
        session_id: 'synthetic-session',
        run_id: 'synthetic-run',
        message_id: 'synthetic-message',
        prompt_version: 'synthetic-v1',
        model_label: '合成模型',
        ai_label: '合成内容标识',
      },
    }),
  });
}

function ports(model: EvalPorts['model']): EvalPorts {
  return { model: vi.fn(model), tool: vi.fn(async () => ({})) };
}

const ok = { chunks: [], usage: { input_tokens: 1, output_tokens: 1 } };

it('主模型 429、备用模型成功：返回备用模型的正常帧与 trace，不记为错误', async () => {
  const p = ports(async (request) => {
    if (request.model === PRIMARY) throw rateLimited();
    return ok;
  });
  const output = await agent()(evalInput, p);
  expect(p.model).toHaveBeenCalledTimes(2);
  expect(output.frames.map((frame) => frame.event)).toEqual(['meta', 'text.delta', 'done']);
  expect(output.frames[1]!.data).toMatchObject({ delta: `来自${BACKUP}` });
  expect(output.frames.at(-1)!.data).toEqual({ finish_reason: 'stop', quota_left: 4 });
  expect(output.trace).toEqual({ intent: 'search', tool_calls: [] });
});

it('主备都网络失败：无模型降级的帧照常返回', async () => {
  const p = ports(async () => {
    throw new TypeError('fetch failed');
  });
  const output = await agent()(evalInput, p);
  expect(p.model).toHaveBeenCalledTimes(2);
  expect(output.frames.map((frame) => frame.event)).toEqual(['meta', 'text.delta', 'done']);
  expect(output.frames.at(-1)!.data).toEqual({ finish_reason: 'fallback', quota_left: 4 });
  expect(output.trace).toEqual({ intent: null, tool_calls: [] });
});

it('录制缺失即使被路由吞掉、降级完成，也原样冒泡为该题错误', async () => {
  const miss = new SyntheticRecordingMiss();
  const p = ports(async (request) => {
    if (request.model === PRIMARY) throw miss;
    return ok;
  });
  await expect(agent()(evalInput, p)).rejects.toBe(miss);
});

it('录制缺失按结构识别：名称加字符串 kind/key', () => {
  expect(isRecordingMiss(new SyntheticRecordingMiss())).toBe(true);
  expect(isRecordingMiss(rateLimited())).toBe(false);
  expect(isRecordingMiss(Object.assign(new Error('x'), { name: 'RecordingMiss' }))).toBe(false);
  expect(isRecordingMiss({ name: 'RecordingMiss', kind: 'model', key: 'k' })).toBe(false);
});
