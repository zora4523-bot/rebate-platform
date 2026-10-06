// 录制回放传输（05 B3-02、02 §9.3 回放模式、§12.7）：公开仓库只用合成录制，不调用真实接口、不带密钥。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createReplayTransport,
  loadVendorRecordings,
  parseVendorRecording,
  vendorFixturesDir,
  vendorRegistry,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import { recording, rejectionCode, syncCode, syntheticBody, without } from './kit.ts';

it('[BR-AI-14 多厂商接入·录制回放#1；02 §9.3] 回放传输不计费；按 vendor + model + body 命中对应那条录制，body 键序不影响命中', async () => {
  // 两条录制的响应手写成不同的字面量：选错录制（如一律返回第一条）会让断言失败。
  const transport = createReplayTransport([
    recording('qwen', {
      response: {
        chunks: [{ synthetic: true, delta: '合成回放:qwen' }],
        usage: { input_tokens: 101, output_tokens: 11 },
      },
    }),
    recording('glm', {
      response: {
        chunks: [
          { synthetic: true, delta: '合成回放:glm' },
          { synthetic: true, delta: '第二片' },
        ],
        usage: { input_tokens: 202, output_tokens: 22 },
      },
    }),
  ]);
  expect(transport.billable).toBe(false);
  const reordered = {
    stream: true,
    tools: syntheticBody().tools,
    messages: syntheticBody().messages,
  };
  await expect(
    transport.send({ vendor: 'glm', model: 'glm-synthetic-snapshot', body: reordered }),
  ).resolves.toEqual({
    chunks: [
      { synthetic: true, delta: '合成回放:glm' },
      { synthetic: true, delta: '第二片' },
    ],
    usage: { input_tokens: 202, output_tokens: 22 },
  });
  await expect(
    transport.send({ vendor: 'qwen', model: 'qwen-synthetic-snapshot', body: syntheticBody() }),
  ).resolves.toEqual({
    chunks: [{ synthetic: true, delta: '合成回放:qwen' }],
    usage: { input_tokens: 101, output_tokens: 11 },
  });
});

it.each([
  ['vendor', { vendor: 'glm' as const, model: 'qwen-synthetic-snapshot', body: syntheticBody() }],
  ['model', { vendor: 'qwen' as const, model: 'qwen-other', body: syntheticBody() }],
  [
    'body',
    {
      vendor: 'qwen' as const,
      model: 'qwen-synthetic-snapshot',
      body: { ...syntheticBody(), stream: false },
    },
  ],
])(
  '[BR-AI-14 多厂商接入·录制回放#2；02 §9.3] %s 不同即未命中：报 recording_miss，不回落到真实调用',
  async (_field, request) => {
    const transport = createReplayTransport([recording('qwen')]);
    expect(await rejectionCode(() => transport.send(request))).toBe('recording_miss');
  },
);

it('[BR-AI-14 多厂商接入·录制回放#3；02 §12.7] 合成且厂商已登记的录制通过校验并原样返回', () => {
  const value = recording('glm');
  expect(parseVendorRecording(structuredClone(value))).toEqual(value);
});

it.each([
  ['未标合成', { ...recording('qwen'), synthetic: false }],
  ['缺合成标记', without(recording('qwen'), 'synthetic')],
  ['未登记厂商', { ...recording('qwen'), vendor: 'deepseek' }],
  ['缺 response', without(recording('qwen'), 'response')],
])(
  '[BR-AI-14 多厂商接入·录制回放#4；02 §12.7] %s 的录制被拒（recording_invalid）',
  (_name, value) => {
    expect(syncCode(() => parseVendorRecording(value))).toBe('recording_invalid');
  },
);

it.each([
  ['请求头 Authorization', { headers: { Authorization: 'placeholder' } }],
  ['请求头 小写 authorization', { headers: { authorization: 'placeholder' } }],
  ['api_key 字段', { api_key: 'placeholder' }],
  ['嵌套的 apiKey', { options: [{ apiKey: 'placeholder' }] }],
])(
  '[BR-AI-14 多厂商接入·离线密钥由人持有、不进仓库#5；02 §12.6、§12.7] 录制里出现%s即拒绝（recording_has_secret）',
  (_name, extra) => {
    const value = { ...recording('qwen'), request: { ...syntheticBody(), ...extra } };
    expect(syncCode(() => parseVendorRecording(value))).toBe('recording_has_secret');
  },
);

it('[BR-AI-14 多厂商接入·录制回放#6；02 §9.3] 按文件名顺序读取目录下的 *.json 录制，忽略其他文件；任一录制不合规则整体失败', async () => {
  const scratch = fileURLToPath(new URL('../../../../.tmp/model-vendors/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'recordings-'));
  try {
    await writeFile(join(dir, 'b-glm.json'), JSON.stringify(recording('glm')));
    await writeFile(join(dir, 'a-qwen.json'), JSON.stringify(recording('qwen')));
    await writeFile(join(dir, 'notes.txt'), 'not a recording');
    const loaded = await loadVendorRecordings(dir);
    expect(loaded.map((r) => r.vendor)).toEqual(['qwen', 'glm']);
    await writeFile(
      join(dir, 'c-bad.json'),
      JSON.stringify({ ...recording('qwen'), synthetic: false }),
    );
    expect(await rejectionCode(() => loadVendorRecordings(dir))).toBe('recording_invalid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('[BR-AI-14 多厂商接入·录制回放#7；05 B3-02] 本目录 __fixtures__ 的合成录制全部合规，且每个登记厂商至少一条', async () => {
  const dir = vendorFixturesDir();
  expect(dir.replaceAll('\\', '/')).toMatch(/\/model-gateway\/vendors\/__fixtures__\/?$/);
  const loaded = await loadVendorRecordings(dir);
  for (const r of loaded) expect(r.synthetic).toBe(true);
  const covered = new Set(loaded.map((r) => r.vendor));
  for (const reg of vendorRegistry()) expect(covered.has(reg.vendor)).toBe(true);
});

it('[BR-AI-14 多厂商接入·录制回放#8；02 §9.3 结果确定] 回放每次返回完整分片：调用方改动上一次结果不影响下一次回放', async () => {
  const transport = createReplayTransport([recording('qwen')]);
  const request = {
    vendor: 'qwen' as const,
    model: 'qwen-synthetic-snapshot',
    body: syntheticBody(),
  };
  const first = await transport.send(request);
  (first.chunks as unknown[]).length = 0;
  first.usage.input_tokens = 0;
  const second = await transport.send(request);
  expect(second).toEqual({
    chunks: [{ synthetic: true, delta: '合成分片' }],
    usage: { input_tokens: 120, output_tokens: 30 },
  });
});

it('[编排决定 G1#3] 回放传输收到已取消的信号即拒绝（aborted），不返回录制', async () => {
  const transport = createReplayTransport([recording('qwen')]);
  const controller = new AbortController();
  controller.abort();
  const request = {
    vendor: 'qwen' as const,
    model: 'qwen-synthetic-snapshot',
    body: syntheticBody(),
  };
  expect(await rejectionCode(() => transport.send(request, controller.signal))).toBe('aborted');
});
