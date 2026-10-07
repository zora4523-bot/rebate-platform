// 评测对齐（05 B3-02「录制响应回放」；BR-AI-21 回放冒烟）：buildModelRequest 的产物与 packages/evals 的
// ModelRequest 同形，录制键 = evals modelKey；evals 格式的录制经 createPortTransport 取回为 VendorResponse。
// 期望的录制键在测试外独立算出后写死（kit.ts RECORDING_DIGEST），不由被测代码产生。
import { expect, it } from 'vitest';
import {
  buildModelRequest,
  createPortTransport,
  quirksFor,
  toVendorRequest,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { loadRecordings, modelKey } from '../../../../packages/evals/src/index.ts';
import {
  RECORDING_DIGEST,
  chatInput,
  expectedModelRequest,
  recordedResponse,
  recordingLine,
} from './kit.ts';

function quirks() {
  return quirksFor('qwen', { explicitCache: false, includeUsage: true });
}

it('[05 B3-02 录制回放#1] 固定合成输入的 evals modelKey 等于夹具录制的 key', () => {
  expect(modelKey(expectedModelRequest())).toBe(RECORDING_DIGEST);
  const req = buildModelRequest(chatInput(), quirks());
  expect(req).toEqual(expectedModelRequest());
  expect(modelKey(req)).toBe(RECORDING_DIGEST);
});

it('[05 B3-02 录制回放#2] evals RecordingStore 经 createPortTransport 取回的 VendorResponse 与录制逐字段相等', async () => {
  const { store, problems } = loadRecordings(recordingLine(), 'synthetic.jsonl');
  expect(problems).toEqual([]);
  const transport = createPortTransport((req) => Promise.resolve(store.model(req)));
  const res = await transport.send(toVendorRequest(buildModelRequest(chatInput(), quirks())));
  expect(res).toEqual(recordedResponse());
  expect(store.unused()).toEqual([]);
});
