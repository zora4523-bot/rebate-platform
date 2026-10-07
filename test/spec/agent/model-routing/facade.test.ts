// 线上调用形状与门面：BR-AI-14（用户输入只发给同意清单里的线上厂商；Flash 主快照关闭思考；GLM 只作离线用途）；
// BR-AI-14 多厂商接入（离线用途只处理合成数据，千问以外厂商付费离线调用须负责人先定额度，06 Q-C31）；
// 05 B3-02 评测 B 模式的在线模型端口。门面 model-gateway/index.ts 再导出各段公开名。
import { expect, it } from 'vitest';
import * as facade from '../../../../apps/api/src/modules/agent/model-gateway/index.ts';
import {
  createEvalModelPort,
  VendorError,
} from '../../../../apps/api/src/modules/agent/model-gateway/index.ts';
import * as vendors from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import * as compat from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import * as degraded from '../../../../apps/api/src/modules/agent/model-gateway/degraded/index.ts';
import * as routing from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import type { ModelRequestShape } from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { chatInput, ctx, entry, fail, FLASH, ok, setup } from './kit.ts';

it('[BR-AI-14 线上调用] 经 gateway.invoke 发出 purpose=online、vendor=qwen、dataClass=user_input；报文带锁定快照并关闭思考', async () => {
  const rig = setup({ steps: { [FLASH]: [ok(10, 2)] } });
  await rig.router().complete(chatInput(), ctx());
  expect(rig.invokes).toEqual([
    { purpose: 'online', vendor: 'qwen', model: FLASH, dataClass: 'user_input' },
  ]);
  expect(rig.transport.calls).toHaveLength(1);
  expect(rig.transport.calls[0]).toMatchObject({
    vendor: 'qwen',
    model: FLASH,
    body: {
      model: FLASH,
      stream: true,
      enable_thinking: false,
      messages: [
        { role: 'system', content: '合成系统前缀' },
        { role: 'user', content: '合成：找保温杯' },
      ],
    },
  });
});

it('[BR-AI-14 多厂商接入] GLM 到不了线上调用：resolveRoute 剔除 GLM 备用，主模型失败后不以 glm 调用网关', async () => {
  const table: routing.RouteTable = {
    entries: [
      entry('flash'),
      entry('glm-b', { vendor: 'glm', tier: 'plus', model: 'glm-synthetic-2026-09-01' }),
    ],
    crossVendor: [],
  };
  const route = routing.resolveRoute(
    table,
    { mode: 'models', primary: 'flash', backup: 'glm-b' },
    { consentVendors: ['qwen', 'glm'] },
  );
  expect(route.attempts.map((a) => a.vendor)).toEqual(['qwen']);
  const rig = setup({ route: () => route, steps: { [FLASH]: [fail('server')] } });
  const outcome = await rig.router().complete(chatInput(), ctx());
  expect(outcome.kind === 'degraded' && outcome.reason).toBe('models_failed');
  expect(rig.invokes.some((c) => c.vendor === 'glm')).toBe(false);
  expect(rig.transport.calls.map((c) => c.vendor)).toEqual(['qwen']);
});

function evalRequest(vendor: string, model: string): ModelRequestShape {
  return {
    vendor,
    model,
    messages: [{ role: 'user', content: '合成评测题' }],
    tools: [],
    params: { stream: true },
  };
}

it('[05 B3-02 评测端口] createEvalModelPort：以离线用途 eval_compare、数据类别 synthetic 调网关，结果原样返回，只记离线计量；门面再导出各段公开名', async () => {
  const rig = setup({ steps: { [FLASH]: [ok(40, 6)] } });
  const port = createEvalModelPort({
    gateway: rig.gateway,
    vendor: 'qwen',
    model: FLASH,
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-eval',
  });
  const res = await port(evalRequest('qwen', FLASH));
  expect(rig.invokes).toEqual([
    {
      purpose: 'offline',
      vendor: 'qwen',
      use: 'eval_compare',
      accessPath: 'bailian',
      workspace: 'ws-synthetic-eval',
      model: FLASH,
      dataClass: 'synthetic',
    },
  ]);
  expect(rig.transport.calls[0]).toEqual({
    vendor: 'qwen',
    model: FLASH,
    body: {
      stream: true,
      model: FLASH,
      messages: [{ role: 'user', content: '合成评测题' }],
      tools: [],
    },
  });
  expect(res.usage).toEqual({ input_tokens: 40, output_tokens: 6 });
  expect(rig.onlineMeter.entries).toEqual([]);
  expect(rig.offlineMeter.entries).toHaveLength(1);
  expect(rig.offlineMeter.entries[0]).toMatchObject({
    vendor: 'qwen',
    purpose: 'offline',
    use: 'eval_compare',
  });
  // 门面同时再导出 vendors、openai-compat、degraded、routing 的公开名。
  expect(facade.createVendorGateway).toBe(vendors.createVendorGateway);
  expect(facade.VendorError).toBe(vendors.VendorError);
  expect(facade.ModelProtocolError).toBe(compat.ModelProtocolError);
  expect(facade.buildModelRequest).toBe(compat.buildModelRequest);
  expect(facade.planKeywordSearch).toBe(degraded.planKeywordSearch);
  expect(facade.degradeFinishReason).toBe(degraded.degradeFinishReason);
  expect(facade.createModelRouter).toBe(routing.createModelRouter);
  expect(facade.resolveRoute).toBe(routing.resolveRoute);
  expect(facade.createRunModelClock).toBe(routing.createRunModelClock);
});

it('[06 Q-C31 离线额度] GLM 没有离线额度：评测端口得到 VendorError(offline_budget_unset)，传输不被调用', async () => {
  const model = 'glm-synthetic-m1';
  const rig = setup({ steps: { [model]: [ok(1, 1)] } });
  const port = createEvalModelPort({
    gateway: rig.gateway,
    vendor: 'glm',
    model,
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-eval',
  });
  let caught: unknown = 'no_error';
  try {
    await port(evalRequest('glm', model));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(VendorError);
  expect((caught as { code?: unknown }).code).toBe('offline_budget_unset');
  expect(rig.transport.calls).toEqual([]);
});
