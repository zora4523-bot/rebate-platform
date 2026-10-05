import { createHash } from 'node:crypto';
import { computeManifest } from '../../../packages/evals/src/index.ts';
import type {
  CaseResult, Category, EvalCase, Manifest, ModelRequest, Recording, Report, RunMeta,
  StreamFrame, ToolCall, TurnOutput,
} from '../../../packages/evals/src/index.ts';

// BR-AI-03 细则初始清单；不读取实现阶段才创建的 specs 文件。
export const identityFields = [
  'user_id', 'uid', 'app_id', 'device_id', 'scene', 'pid', 'p_id', 'adzone_id',
  'site_id', 'position_id', 'relation_id', 'special_id', 'sub_union_id',
  'custom_parameters', 'union_id',
] as const;

// 所有素材均为公开仓内手写合成数据，无私有录制、真实用户或供应商响应。
export function sample(patch: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'synthetic-private-id-001', set: 'smoke', category: 'T1', split: 'tune',
    group: 'synthetic-group', provenance: 'synthetic', subject: 'guest',
    turns: [{ text: '独特合成题文本-SENSITIVE-SYNTHETIC-001' }],
    expect: { intent: 'search' }, ...patch,
  };
}

export function request(patch: Partial<ModelRequest> = {}): ModelRequest {
  return {
    vendor: 'synthetic-vendor', model: 'synthetic-snapshot',
    messages: [{ role: 'user', content: '合成消息' }], tools: [], params: { temperature: 0 },
    ...patch,
  };
}

export function call(patch: Partial<ToolCall> = {}): ToolCall {
  return {
    name: 'search_products', args: { q: '合成文具' },
    state: { turn: 1, result_set_ids: ['rs-B', 'rs-a'], tool_set: ['search_products', 'parse_input'] },
    config_fingerprint: 'synthetic-config-v1', ...patch,
  };
}

export function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function recording(patch: Partial<Recording> = {}): Recording {
  return {
    kind: 'model', key: 'a'.repeat(64), response: { synthetic: true },
    recorded_at: '2026-10-06T09:00:00+08:00', ...patch,
  };
}

export function jsonl(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n');
}

// 04 §8.1–8.3：只用本段判分读取的字段；卡片 payload 为合成的收益/提示卡。
export function frame(event: string, data: Record<string, unknown> = {}, id = 1): StreamFrame {
  return { event, id, data };
}

export function done(): StreamFrame {
  return frame('done', { finish_reason: 'stop', quota_left: 1 });
}

export function card(type = 'earnings_summary'): StreamFrame {
  const data = type === 'earnings_summary' ? {
    as_of: '2026-10-06T09:00:00+08:00', withdrawable_fen: 2990, estimated_total_fen: 4990,
    next_credit_period: '2026-11', credit_overdue: false, latest_withdrawal: null,
    actions: [
      { route: 'Wallet', text_key: 'agent.earnings.open_wallet' },
      { route: 'WithdrawRecords', text_key: 'agent.earnings.open_records' },
    ],
  } : { level: 'info', text_key: 'synthetic.notice', actions: [] };
  return frame('card', {
    seq: 1, card_id: 'c1', type, schema_version: 1, data, fallback_text: '合成展示文案',
  });
}

export function output(deltas: string[] = [], patch: Partial<TurnOutput> = {}): TurnOutput {
  const frames = [
    ...deltas.map((delta) => frame('text.delta', { delta })), done(),
  ];
  return {
    trace: { intent: 'search', tool_calls: [] }, ...patch,
    frames: (patch.frames ?? frames).map((f, i) => ({
      ...f, id: i + 1,
      data: ['text.delta', 'tool.status', 'card'].includes(f.event)
        ? { ...f.data, seq: i + 1, ...(f.event === 'card' ? { card_id: `c${i + 1}` } : {}) }
        : f.data,
    })),
  };
}

export function passed(c: EvalCase): CaseResult {
  return {
    id: c.id, category: c.category, split: c.split,
    result: 'pass', first_failed_layer: null, problems: [],
  };
}

export function meta(manifest: Manifest): RunMeta {
  return {
    mode: 'A', vendor: 'synthetic-vendor', model_snapshot: 'synthetic-snapshot',
    prompt_sha256: 'b'.repeat(64), sampling: { temperature: 0 },
    eval_set: {
      set: manifest.set, version: manifest.version, content_sha256: manifest.content_sha256,
      split_sha256: manifest.split_sha256,
    },
    tool_schema_version: 'synthetic-tools@1', code_commit: 'c'.repeat(40), grader_version: '1',
    recordings_sha256: 'd'.repeat(64), unused_recordings: 0,
    started_at: '2026-10-06T09:00:00+08:00', finished_at: '2026-10-06T09:01:00+08:00',
  };
}

export function smokeCases(): EvalCase[] {
  const categories: Category[] = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'injection', 'unauthorized'];
  return Array.from({ length: 30 }, (_, i) => sample({
    id: `synthetic-private-id-${String(i).padStart(3, '0')}`,
    category: categories[i % categories.length] ?? 'T1', group: `synthetic-group-${i}`,
    turns: [{ text: `独特合成题文本-SENSITIVE-SYNTHETIC-${i}` }],
  }));
}

// 仅组装全过的基线报告；不调用本轮 summarize/checkReport，避免互证。
export function reportFixture(cases: EvalCase[] = smokeCases()): {
  cases: EvalCase[]; manifest: Manifest; report: Report;
} {
  const manifest = computeManifest('smoke', 'synthetic-v1', cases);
  const active = cases.filter((c) => !c.retired).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const by_category: Report['summary']['by_category'] = {};
  for (const c of active) {
    const counts = by_category[c.category] ?? { total: 0, pass: 0, fail: 0, coverage_gap: 0, error: 0 };
    counts.total += 1;
    counts.pass += 1;
    by_category[c.category] = counts;
  }
  return {
    cases, manifest, report: {
      schema_version: 1, meta: meta(manifest), cases: active.map(passed),
      summary: {
        total: active.length, pass: active.length, fail: 0, coverage_gap: 0, error: 0,
        by_category, counters: { amount_in_text: 0, url_in_text: 0, identity_arg: 0 },
      },
    },
  };
}
