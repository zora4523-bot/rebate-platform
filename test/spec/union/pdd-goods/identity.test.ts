import { expect, it } from 'vitest';
import { ctx, envelope, identity, invoke, row, setup, shortParse, sources } from './kit.ts';

const ports = [...sources, 'link'] as const;

it.each(ports)(
  '[AC-B1-04u-IDENTITY#1] %s 未注入查询身份时 upstream_rejected，禁止发请求',
  async (port) => {
    const { adapter, transport, credentials } = setup(() => ({}), null);
    await expect(invoke(adapter, port)).rejects.toMatchObject({
      code: 'upstream_rejected',
      platform: 'pdd',
    });
    expect(transport).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  },
);

it.each(ports)(
  '[AC-B1-04u-IDENTITY#2] %s 每次读查询身份，按原字节带 pid 与 custom_parameters',
  async (port) => {
    const second = { pid: 'synthetic-next-pid', customParameters: '{ "uid" : "next-query" }' };
    let active = identity;
    const { adapter, queryIdentity, requests } = setup(
      (body) =>
        body.type === shortParse
          ? { url: { url: 'https://mobile.yangkeduo.com/goods.html?goods_id=7345678901234' } }
          : envelope(body.type, [row()]),
      async () => active,
    );
    await invoke(adapter, port);
    expect(queryIdentity).toHaveBeenCalled();
    const before = requests.length;
    expect(before).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request).toMatchObject({
        pid: identity.pid,
        custom_parameters: identity.customParameters,
      });
    }
    const reads = queryIdentity.mock.calls.length;
    active = second;
    await invoke(adapter, port);
    expect(queryIdentity.mock.calls.length).toBeGreaterThan(reads);
    expect(requests.length).toBeGreaterThan(before);
    for (const request of requests.slice(before)) {
      expect(request).toMatchObject({
        pid: second.pid,
        custom_parameters: second.customParameters,
      });
    }
  },
);

const invalid: readonly [string, { pid: string; customParameters: string }][] = [
  ['空 pid', { ...identity, pid: '' }],
  ['空白 pid', { ...identity, pid: '  ' }],
  ['非 JSON', { ...identity, customParameters: 'synthetic-invalid-json' }],
  [
    'ASCII 超过 64 字节',
    { ...identity, customParameters: JSON.stringify({ uid: 'a'.repeat(55) }) },
  ],
  [
    '中文按 UTF-8 字节计算',
    { ...identity, customParameters: JSON.stringify({ uid: '中'.repeat(19) }) },
  ],
];

for (const port of ports) {
  it.each(invalid)(
    `[AC-B1-04u-IDENTITY#3] ${port}：%s 不能携带非法查询身份出站`,
    async (_label, value) => {
      const { adapter, transport } = setup(
        () => ({}),
        async () => value,
      );
      // 无效配置的具体错误码没有裁定；要求明确 UnionError 且不请求。
      await expect(invoke(adapter, port)).rejects.toMatchObject({
        platform: 'pdd',
        code: expect.stringMatching(/^(invalid_identity|invalid_dto|upstream_rejected)$/),
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );
}

it('[AC-B1-04u-IDENTITY#4] custom_parameters 恰好 64 个 UTF-8 字节可以使用，保留 JSON 文本', async () => {
  const customParameters = JSON.stringify({ uid: 'a'.repeat(54) });
  expect(Buffer.byteLength(customParameters, 'utf8')).toBe(64);
  const { adapter, requests } = setup(
    (body) => envelope(body.type, [row()]),
    async () => ({ ...identity, customParameters }),
  );
  await adapter.searchItems({ keyword: '合成关键词' }, ctx);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ custom_parameters: customParameters });
});

it('[AC-B1-04u-IDENTITY#5] 请求上下文的 app_id 不冒充备案 uid，身份只取服务端提供者', async () => {
  const { adapter, requests } = setup((body) => envelope(body.type, [row()]));
  await adapter.searchItems(
    { keyword: '合成关键词' },
    {
      ...ctx,
      appId: 'other-context-app',
      headers: { pid: 'forged-pid', uid: 'forged-user' },
    },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    pid: identity.pid,
    custom_parameters: identity.customParameters,
  });
  expect(JSON.stringify(requests)).not.toContain('forged-user');
});
