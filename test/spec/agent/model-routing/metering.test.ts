// 失败尝试的用量计量：BR-AI-16（单次调用成本按 input / output token 计，在调用完成时计入；摘录口径见 tests-claude.md）
// 与 B3-02b 约定：ModelProtocolError.usage 为已收到的有效累计用量，null 表示未知、不能按零计费。
// 本段把带用量的协议错误（含已出部分输出后失败）交给线上计量；成功调用由 VendorGateway 计量，不重复记。
// usage 原样透出给调用方（成本记账属 B3-09，本段不算钱）。
import { expect, it } from 'vitest';
import { chatInput, ctx, fail, FLASH, ok, onlineUsage, PLUS, setup } from './kit.ts';

it('[BR-AI-16 计量] 主模型成功：线上计量恰好一条（网关已记，路由器不重复记），outcome.usage 原样透出', async () => {
  const rig = setup({ steps: { [FLASH]: [ok(321, 54)] } });
  const outcome = await rig.router().complete(chatInput(), ctx());
  expect(outcome.kind === 'model' && outcome.usage).toEqual({
    input_tokens: 321,
    output_tokens: 54,
  });
  expect(rig.onlineMeter.entries).toEqual([onlineUsage(FLASH, 321, 54)]);
  expect(rig.offlineMeter.entries).toEqual([]);
});

it.each(['network', 'server'] as const)(
  '[BR-AI-16 计量] 主模型已出部分输出后 %s 失败（错误带 usage）：该用量记入线上计量，备用成功的用量另记一条',
  async (kind) => {
    const rig = setup({
      steps: {
        [FLASH]: [fail(kind, { input_tokens: 200, output_tokens: 15 })],
        [PLUS]: [ok(120, 30)],
      },
    });
    const outcome = await rig.router().complete(chatInput(), ctx());
    expect(outcome.kind === 'model' && outcome.entryId).toBe('plus');
    expect(rig.onlineMeter.entries).toHaveLength(2);
    expect(rig.onlineMeter.entries).toEqual(
      expect.arrayContaining([onlineUsage(FLASH, 200, 15), onlineUsage(PLUS, 120, 30)]),
    );
  },
);

it('[BR-AI-16 计量] 主、备都返回协议错误（malformed）但带 usage：两条用量都记入，outcome 为 models_failed', async () => {
  const rig = setup({
    steps: {
      [FLASH]: [fail('malformed', { input_tokens: 64, output_tokens: 9 })],
      [PLUS]: [fail('malformed', { input_tokens: 70, output_tokens: 0 })],
    },
  });
  const outcome = await rig.router().complete(chatInput(), ctx());
  expect(outcome.kind === 'degraded' && outcome.reason).toBe('models_failed');
  expect(rig.onlineMeter.entries).toHaveLength(2);
  expect(rig.onlineMeter.entries).toEqual(
    expect.arrayContaining([onlineUsage(FLASH, 64, 9), onlineUsage(PLUS, 70, 0)]),
  );
});

it('[BR-AI-16 计量] 错误的 usage 为 null：不记任何计量条目（不按零用量记）', async () => {
  const rig = setup({ steps: { [FLASH]: [fail('server')], [PLUS]: [fail('malformed')] } });
  const outcome = await rig.router().complete(chatInput(), ctx());
  expect(outcome.kind === 'degraded' && outcome.reason).toBe('models_failed');
  expect(rig.onlineMeter.entries).toEqual([]);
});

it('[BR-AI-16 计量] 内容拒绝时错误带 usage：该用量同样记入线上计量，且不调备用', async () => {
  const rig = setup({
    steps: {
      [FLASH]: [fail('content_refused', { input_tokens: 80, output_tokens: 5 })],
      [PLUS]: [ok(1, 1)],
    },
  });
  const outcome = await rig.router().complete(chatInput(), ctx());
  expect(outcome.kind).toBe('refused');
  expect(rig.onlineMeter.entries).toEqual([onlineUsage(FLASH, 80, 5)]);
  expect(rig.transport.callsFor(PLUS)).toBe(0);
});
