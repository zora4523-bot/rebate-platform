// B3-02g 规则测试共用夹具。BR-AI-14 细则「多厂商接入」：改写样本只按精确接入路径与用途登记的许可外发，
// 离线用途其余只处理合成数据、公开商品数据与提示词；来源只取可信题目（EvalCase.provenance）。
// 全部是合成数据：题目正文、请求、许可、响应都是手写字面量；来源标签 rewritten 只用来走许可分支，
// 不读真实改写样本、不调真实厂商。链路是黑盒：runEval → createEvalModelPort → createVendorGateway
// → 进程内脚本化假传输（transport.calls 即「真正发出去的请求」）。
import { expect } from 'vitest';
import { computeManifest, loadRecordings, runEval } from '../../../packages/evals/src/index.ts';
import type {
  AgentUnderTest,
  EvalCase,
  ModelRequest,
  RunMeta,
} from '../../../packages/evals/src/index.ts';
import {
  VendorError,
  createEvalModelPort,
} from '../../../apps/api/src/modules/agent/model-gateway/index.ts';
import { createVendorGateway } from '../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import type {
  RewrittenSampleGrant,
  VendorId,
} from '../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import {
  FLASH,
  ManualScheduler,
  MemorySink,
  ScriptedTransport,
  fixedClock,
  ok,
  spyGateway,
} from '../agent/model-routing/kit.ts';
import type { InvokeRecord } from '../agent/model-routing/kit.ts';
import { meta, sample } from '../evals-replay/fixtures.ts';

export { FLASH, PLUS } from '../agent/model-routing/kit.ts';

export const WORKSPACE = 'ws-synthetic-eval';
/** GLM 合成型号名（离线；不经快照锁定校验）。 */
export const GLM_MODEL = 'glm-synthetic-m1';

/** 与端口精确匹配的改写样本许可（千问 / 百炼 / 本业务空间 / FLASH / eval_compare，已书面确认不训练）。 */
export function exactGrant(patch: Partial<RewrittenSampleGrant> = {}): RewrittenSampleGrant {
  return {
    vendor: 'qwen',
    accessPath: 'bailian',
    workspace: WORKSPACE,
    model: FLASH,
    use: 'eval_compare',
    noTrainingConfirmed: true,
    legalApproved: false,
    ...patch,
  };
}

export interface Rig {
  readonly transport: ScriptedTransport;
  readonly invokes: InvokeRecord[];
  readonly port: ReturnType<typeof createEvalModelPort>;
}

/** 一套评测模型端口：真实网关 + 脚本化假传输（预排 4 次成功响应）。 */
export function rig(o: { vendor?: VendorId; grants?: readonly RewrittenSampleGrant[] } = {}): Rig {
  const vendor = o.vendor ?? 'qwen';
  const model = vendor === 'qwen' ? FLASH : GLM_MODEL;
  const transport = new ScriptedTransport(new ManualScheduler(), {
    [model]: [ok(5, 1), ok(5, 1), ok(5, 1), ok(5, 1)],
  });
  const spy = spyGateway(
    createVendorGateway({
      transport,
      clock: fixedClock,
      onlineMeter: new MemorySink(),
      offlineMeter: new MemorySink(),
      offlineBudgetApproved: vendor === 'glm' ? ['glm'] : [],
      rewrittenSampleGrants: o.grants ?? [],
      ownerAggregateApprovals: [],
    }),
  );
  const port = createEvalModelPort({
    gateway: spy.gateway,
    vendor,
    model,
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: WORKSPACE,
  });
  return { transport, invokes: spy.invokes, port };
}

/** 评测题：只换 id、来源标签与轮数，正文是合成文本。 */
export function evalCase(id: string, provenance: EvalCase['provenance'], turns = 1): EvalCase {
  return sample({
    id,
    provenance,
    turns: Array.from({ length: turns }, (_, i) => ({ text: `合成题文本-${id}-${i + 1}` })),
  });
}

/** 网关看到的一次离线调用（spyGateway 记录，去掉报文体）；端口固定 bailian / WORKSPACE / eval_compare。 */
export function offlineInvoke(
  dataClass: string,
  vendor: VendorId = 'qwen',
  model = FLASH,
): Record<string, unknown> {
  return {
    purpose: 'offline',
    vendor,
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: WORKSPACE,
    model,
    dataClass,
  };
}

/** 断言端口调用以 VendorError(code) 失败。 */
export function rejectedWith(outcome: Outcome | undefined, code: string): void {
  const error = outcome !== undefined && !outcome.ok ? outcome.error : undefined;
  expect(error).toBeInstanceOf(VendorError);
  expect(error).toMatchObject({ code });
}

/** Agent 发给模型端口的请求（每次新建字面量）。 */
export function evalRequest(
  content = '合成评测题：找保温杯',
  vendor: VendorId = 'qwen',
): ModelRequest {
  return {
    vendor,
    model: vendor === 'qwen' ? FLASH : GLM_MODEL,
    messages: [{ role: 'user', content }],
    tools: [],
    params: { stream: true },
  };
}

/** 传输实际收到的报文体（toVendorRequest 的约定：params 展开 + model + messages + tools）。 */
export function sentBody(content = '合成评测题：找保温杯', model = FLASH): unknown {
  return { stream: true, model, messages: [{ role: 'user', content }], tools: [] };
}

/** 发出去的请求里用户消息正文，按发送顺序。 */
export function sentContents(transport: ScriptedTransport): unknown[] {
  return transport.calls.map((call) => {
    const body = call.body as { messages?: { content?: unknown }[] };
    return body.messages?.[0]?.content;
  });
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/** 端口调用的结局；失败不外抛，避免未处理的拒绝。 */
export async function attempt(start: () => Promise<unknown>): Promise<Outcome> {
  try {
    await start();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 手动开闸：让「晚到」调用在测试指定的时刻才发生，不用真实计时器。 */
export function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** 按模式跑一次 runEval：B 用 live.model + 空工具录制；integration 用 live.model + 空工具端口。 */
export function runWith(
  mode: Exclude<RunMeta['mode'], 'A'>,
  cases: EvalCase[],
  agent: AgentUnderTest,
  port: Rig['port'],
): ReturnType<typeof runEval> {
  const base = {
    cases,
    agent,
    meta: { ...meta(computeManifest('smoke', 'synthetic-v1', cases)), mode },
  };
  return mode === 'B'
    ? runEval({
        ...base,
        store: loadRecordings('', 'synthetic-empty.jsonl').store,
        live: { model: port },
      })
    : runEval({ ...base, live: { model: port, tool: async () => null } });
}
