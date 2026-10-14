// B3-03d 第 9 节 5：SSE 细节——响应头 Content-Type: text/event-stream、Cache-Control: no-cache；每个事件
// `event:` / `id:` / `data:` 三行，id 从 1 连续；每帧过 contracts/agent-stream.schema.json（stream-run
// kit 用 Ajv 2020 读契约文件）；客户端断开后本层不再写、不抛未捕获异常。
import { expect, it } from 'vitest';

import type { AdmissionResult } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { RunBody } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  FakeReply,
  expectStream,
  framesOf,
  guest,
  message,
  newId,
  parseSse,
  rig,
  send,
  streamProblems,
  type HttpRig,
} from './kit.ts';

function duplicateFinal(r: HttpRig): void {
  r.admission.answer = () =>
    ({
      kind: 'duplicate',
      original: {
        runId: newId(),
        userMessageId: newId(),
        assistantMessageId: newId(),
        promptVersion: 'agent-prompt@earlier-1',
        modelSnapshot: null,
      },
      reply: {
        kind: 'final',
        frame: { event: 'done', data: { finish_reason: 'stop', quota_left: 2 } },
      },
    }) as AdmissionResult;
}

/** The raw SSE text of every event: three lines, ids 1..n, nothing between events but pings. */
function expectLayout(chunks: readonly string[]): void {
  const text = chunks.join('');
  expect(text.endsWith('\n\n'), 'the stream ends with a blank line').toBe(true);
  expect(text).not.toMatch(/\r/);
  const blocks = text
    .slice(0, -2)
    .split('\n\n')
    .filter((b) => b !== ': ping');
  blocks.forEach((block, i) => {
    const lines = block.split('\n');
    expect(lines, block).toHaveLength(3);
    expect(lines[0]).toMatch(/^event: [a-z.]+$/);
    expect(lines[1]).toBe(`id: ${String(i + 1)}`);
    expect(lines[2]).toMatch(/^data: \{.*\}$/);
  });
  expect(parseSse(chunks), 'parses as 04 §8.1 SSE').toBeDefined();
}

it('[AC-B3-03d#17] 受理与重复两种流：响应头 text/event-stream + no-cache；每个事件三行、id 从 1 连续；每帧过 agent-stream.schema.json', async () => {
  for (const kind of ['accepted', 'duplicate'] as const) {
    const r = rig();
    const caller = guest();
    const sessionId = r.sessions.add(caller);
    if (kind === 'duplicate') duplicateFinal(r);
    const reply = await send(r, caller, sessionId, message());
    expectStream(reply);
    expectLayout(reply.chunks);
    const frames = framesOf(reply.chunks);
    expect(frames.length, kind).toBeGreaterThanOrEqual(2);
    expect(frames.map((f) => f.id)).toEqual(frames.map((_, i) => i + 1));
    expect(streamProblems(frames), kind).toEqual([]);
  }
});

it('[AC-B3-03d#18] 重复消息的流里客户端已断开（打开即断、写第一帧后断）：之后不再写出，至多一次失败的写入即停，sendMessage 正常结束不抛错', async () => {
  for (const mode of ['open', 'afterFirst'] as const) {
    const r = rig();
    const caller = guest();
    const sessionId = r.sessions.add(caller);
    duplicateFinal(r);
    const reply = new FakeReply();
    if (mode === 'open') reply.closeOnOpen = true;
    else reply.closeAfterWrites = 1;
    await expect(send(r, caller, sessionId, message(), reply)).resolves.toBe(reply);
    expect(reply.chunks.length, mode).toBe(mode === 'open' ? 0 : 1);
    // At most the one write that finds the client gone (it throws, nothing is delivered); the
    // layer stops there instead of trying the next frame.
    expect(
      reply.writesAfterClose,
      `${mode}: stops writing once the client left`,
    ).toBeLessThanOrEqual(1);
    expect(reply.jsons).toEqual([]);
  }
});

it('[AC-B3-03d#19] 受理后的流里客户端断开：断开后不再写出任何帧，sendMessage 在 run 结束后正常结束、不抛错', async () => {
  const r = rig();
  const caller = guest();
  const sessionId = r.sessions.add(caller);
  let leave: () => void = () => undefined;
  // The body writes once, the client leaves, the body keeps running until its signal aborts.
  const body: RunBody = async (ctx) => {
    ctx.text('第一段');
    leave();
    await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
    ctx.text('断开后的内容');
    return { kind: 'done', finishReason: 'stop' };
  };
  r.body = body;
  const reply = new FakeReply();
  leave = () => reply.close();
  await expect(send(r, caller, sessionId, message(), reply)).resolves.toBe(reply);
  const frames = framesOf(reply.chunks);
  expect(frames.map((f) => f.event)).toEqual(['meta', 'text.delta']);
  expect(reply.chunks.join('')).not.toContain('断开后的内容');
  expect(reply.jsons, 'no JSON after the stream was opened').toEqual([]);
});
