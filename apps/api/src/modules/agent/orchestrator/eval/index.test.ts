import { expect, it, vi } from 'vitest';
import {
  buildModelRequest,
  quirksFor,
  toVendorRequest,
} from '../../model-gateway/openai-compat/index.ts';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunBody, UnnumberedCard } from '../../stream/run/index.ts';
import { createAgentRunBody, orchestratorLimitsDefaults } from '../core/factories.ts';
import type { OrchestratorTrace, ToolTraceFragment } from '../core/ports.ts';
import { createDegradedPath } from '../degraded/index.ts';
import { createEvalAgent, isRecordingMiss } from './index.ts';
import type { EvalBindings, EvalInput, EvalPorts, EvalTurnOutput } from './index.ts';

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

// ---------------------------------------------------------------------------------------------
// No-model degraded path through the real core: the keyword search's trace fragment reaches the
// turn's trace, and the release check of packages/evals verifies the degraded cards.

interface Count {
  checked: number;
  verified: number;
  mismatched: number;
  unverified: number;
}

// apps/api does not depend on evals (rootDir src): load its public entry by path at run time.
const EVALS_ENTRY = new URL('../../../../../../../packages/evals/src/index.ts', import.meta.url);
async function computeFacts(
  output: EvalTurnOutput,
): Promise<{ card_values: Count; attribution: Count }> {
  const evals = (await import(EVALS_ENTRY.href)) as {
    computeFacts: (c: unknown, outputs: unknown[]) => { card_values: Count; attribution: Count };
  };
  return evals.computeFacts(degradedCase, [output]);
}

const degradedCase = {
  id: 'synthetic-B3-05c-degraded',
  set: 'smoke',
  category: 'T2',
  split: 'holdout',
  group: 'synthetic-B3-05c',
  provenance: 'synthetic',
  subject: 'guest',
  switches: {},
  turns: [{ text: '合成保温杯', untrusted: true }],
  expect: { cards: ['product_list'], forbid: ['amount_in_text', 'url_in_text'] },
};

function runInput(): RunBodyInput {
  return {
    caller: {
      appId: 'synthetic-app',
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: null,
      phoneBound: false,
    },
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text: '合成保温杯',
    redactedText: '合成保温杯' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

function productList(): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    fallback_text: '合成商品列表',
    data: {
      result_set_id: 'synthetic-results',
      layout: 'list',
      items: [
        {
          product_key: 'tb:synthetic-0',
          item_ref: 'synthetic-ref',
          platform: 'taobao',
          shop_type: null,
          title: '合成商品0',
          image: 'https://example.invalid/synthetic.png',
          shop_name: '合成店铺',
          price_fen: 1000,
          coupon_fen: 0,
          final_price_fen: 1000,
          est_net_price_fen: null,
          rebate_min_fen: null,
          rebate_max_fen: null,
          rebate_basis: 'amount_unknown',
          benefit_tags: [],
          match_tag: 'matched',
          spec_text: null,
          is_presale: false,
          tlj: null,
          link_id: 'synthetic-link-0',
          cta: { text_key: 'product.buy' },
          quoted_at: '2026-10-15T08:00:00+08:00',
          stale: false,
          age_sec: 0,
          source: 'taobao_union',
          disclaimer_keys: ['price_basis.general'],
          ad_label: null,
          availability: 'ok',
        },
      ],
    },
  };
}

// The list is c1 and its only item c2 (firstCardNo 1); the search reports evidence for c2.
const searchTrace: ToolTraceFragment = {
  card_sources: [
    {
      card_id: 'c2',
      fields: {
        price_fen: 1000,
        coupon_fen: 0,
        final_price_fen: 1000,
        rebate_min_fen: null,
        rebate_max_fen: null,
      },
    },
  ],
  link_registrations: [{ link_id: 'synthetic-link-0', product_key: 'tb:synthetic-0', ok: true }],
};

/** Real core with no prompt release (route_no_model) and the real degraded path. */
function degradedAgent(wireTrace: boolean) {
  return createEvalAgent({
    createRun: (_input, bindings) => {
      const tools = {
        definitions: async () => [],
        execute: async () => ({ kind: 'failed' as const, modelView: {} }),
        enabledSearchPlatforms: async () => ['taobao'],
        searchKeyword: async () => ({
          results: [{ platform: 'taobao', ok: true, items: [{ product_key: 'tb:synthetic-0' }] }],
          cards: [productList()],
          trace: structuredClone(searchTrace),
        }),
      };
      const texts = {
        text: async (_app: string, key: string) =>
          key === 'agent.degraded' ? '请查看搜索结果。' : '暂未找到相关商品。',
        toolDisplay: async () => '合成',
      };
      const degraded = createDegradedPath({
        tools,
        texts,
        errorMsg: async () => '合成搜索暂不可用',
        ...(wireTrace && bindings.toolTrace !== undefined ? { onTrace: bindings.toolTrace } : {}),
      });
      const body = createAgentRunBody({
        model: { complete: vi.fn() },
        modelClock: () => ({ remainingMs: () => 1000, charge: () => undefined }),
        tools,
        inputCheck: {
          check: async () => ({
            kind: 'proceed',
            modelText: '合成保温杯',
            placeholders: {},
            links: [],
            notices: [],
            untrustedInput: true,
            paramsRequested: false,
          }),
        },
        degraded,
        review: { review: async () => 'pass' },
        texts,
        prompt: { current: async () => null },
        limits: orchestratorLimitsDefaults(),
        traceMask: (args) => args,
        trace: bindings.trace,
      })(runInput());
      return {
        body,
        firstCardNo: 1,
        quotaLeft: 4,
        meta: {
          session_id: 'synthetic-session',
          run_id: 'synthetic-run',
          message_id: 'synthetic-assistant-message',
          prompt_version: 'none',
          model_label: '合成模型',
          ai_label: '合成内容标识',
        },
      };
    },
  });
}

it('[B3-05c r2 S1] 无模型降级：搜索的 card_sources / link_registrations 进入该题 trace，编号与下发卡片一致', async () => {
  const output = await degradedAgent(true)(
    evalInput,
    ports(async () => ok),
  );
  expect(output.frames.map((frame) => frame.event)).toEqual(['meta', 'card', 'text.delta', 'done']);
  const card = output.frames[1]!.data as {
    card_id: string;
    data: { items: { card_id: string }[] };
  };
  expect(card.card_id).toBe('c1');
  const itemId = card.data.items[0]!.card_id;
  expect(itemId).toBe('c2');
  expect(output.frames.at(-1)!.data).toEqual({ finish_reason: 'fallback', quota_left: 4 });
  expect(output.trace).toEqual({
    intent: null,
    tool_calls: [],
    card_sources: searchTrace.card_sources,
    link_registrations: searchTrace.link_registrations,
  });
  expect(output.trace.card_sources!.map((source) => source.card_id)).toEqual([itemId]);

  const facts = await computeFacts(output);
  expect(facts.card_values).toEqual({ checked: 1, verified: 1, mismatched: 0, unverified: 0 });
  expect(facts.attribution).toEqual({ checked: 1, verified: 1, mismatched: 0, unverified: 0 });
});

it('[B3-05c r2 S1] 降级路径未接 trace 回调时，同一样例的卡片与归因判为 unverified', async () => {
  const output = await degradedAgent(false)(
    evalInput,
    ports(async () => ok),
  );
  expect(output.trace).toEqual({ intent: null, tool_calls: [] });
  const facts = await computeFacts(output);
  expect(facts.card_values.unverified).toBe(1);
  expect(facts.attribution.unverified).toBe(1);
});

it('[B3-05c r2 S1] 适配器每题新建片段收集：连续两题不累积', async () => {
  const agent = degradedAgent(true);
  const first = await agent(
    evalInput,
    ports(async () => ok),
  );
  const second = await agent(
    evalInput,
    ports(async () => ok),
  );
  expect(second.trace).toEqual(first.trace);
  expect(second.trace.card_sources).toHaveLength(1);
});
