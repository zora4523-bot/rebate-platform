// B3-03f 第 9 节 1、2：createAgentStreamRuntime 装出的真端口与真 HTTP 处理器，真 PG。
// 1 生产默认装配（failClosedInputCheck）：消息按「审核不可用」拒绝——meta → agent.refuse.safety_unavailable 文字 →
//   done(safety)；run 行有 final_event、会话锁已释放、按 input_review_timeout 退还；不发任何模型传输请求。
// 2 降级（测试缝换一个放行的输入检查）：路由固定 no_model → B3-05c 降级口；emptyOrchestratorTools 下出
//   agent.degraded.empty 的 notice、done(fallback)，不出卡、不调模型；同一 client_msg_id 重放得两帧（duplicate）。
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';

import {
  APP,
  PassInputCheck,
  consent,
  fileText,
  framesOf,
  message,
  newMember,
  openAgent,
  openSession,
  rig,
  runRow,
  runsOf,
  send,
  sessionRow,
  usePgEach,
  usedOf,
  type Frame,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);

afterEach(() => {
  vi.restoreAllMocks();
});

function textOf(frames: readonly Frame[]): string {
  return frames
    .filter((f) => f.event === 'text.delta')
    .map((f) => String(f.data['delta']))
    .join('');
}

it('[AC-B3-03f#1][BR-AI-23][BR-AI-13] 生产默认装配：消息被拒为「审核不可用」——meta → safety_unavailable 文字 → done(safety)；run 有 final_event、锁已释放、按 input_review_timeout 退还；零次模型传输', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const caller = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, caller);
  const r = await rig(pg.db);
  const sessionId = await openSession(r, caller);

  const reply = await send(r, caller, sessionId, message('帮我找个保温杯'));
  expect(reply.jsons, 'accepted: answered with a stream').toEqual([]);
  expect(reply.streams).toHaveLength(1);
  expect(reply.streams[0]!['content-type']).toBe('text/event-stream');
  const frames = framesOf(reply.chunks);
  expect(frames[0]!.event).toBe('meta');
  const last = frames[frames.length - 1]!;
  expect(last.event).toBe('done');
  expect(last.data['finish_reason']).toBe('safety');
  expect(
    frames.slice(1, -1).every((f) => f.event === 'text.delta'),
    JSON.stringify(frames),
  ).toBe(true);
  expect(textOf(frames)).toBe(fileText('agent.refuse.safety_unavailable'));
  expect(frames.some((f) => f.event === 'card')).toBe(false);

  const runId = frames[0]!.data['run_id'] as string;
  const row = await runRow(pg.db, runId);
  expect(row['final_event']).not.toBeNull();
  expect(row).toMatchObject({
    app_id: APP,
    end_reason: 'input_review_timeout',
    settle_result: 'refunded',
  });
  expect((await sessionRow(pg.db, sessionId))['run_lock_run_id']).toBeNull();
  expect(await usedOf(pg.db, caller.userId!)).toBe(0);
  expect(fetchSpy, 'no model transport call').not.toHaveBeenCalled();
}, 60_000);

it('[AC-B3-03f#2][BR-AI-14][BR-AI-23] 降级（测试缝放行输入检查）：no_model 路由进 B3-05c 降级口，emptyOrchestratorTools 下出 agent.degraded.empty notice、done(fallback)，不出卡、不调模型；同一 client_msg_id 重放得两帧 duplicate', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const caller = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, caller);
  const input = new PassInputCheck();
  const r = await rig(pg.db, { inputCheck: input });
  const sessionId = await openSession(r, caller);

  const body = message('帮我找个保温杯');
  const reply = await send(r, caller, sessionId, body);
  expect(reply.jsons).toEqual([]);
  expect(input.texts, 'the seam input check was used').toEqual(['帮我找个保温杯']);
  const frames = framesOf(reply.chunks);
  expect(frames.map((f) => f.event)).toEqual(['meta', 'card', 'done']);
  expect(frames[1]!.data).toMatchObject({
    type: 'notice',
    data: { text_key: 'agent.degraded.empty' },
    fallback_text: fileText('agent.degraded.empty'),
  });
  expect(frames[2]!.data['finish_reason']).toBe('fallback');
  expect(fetchSpy, 'no model transport call').not.toHaveBeenCalled();

  const runId = frames[0]!.data['run_id'] as string;
  const row = await runRow(pg.db, runId);
  expect(row['final_event']).not.toBeNull();
  expect(row['card_delivered']).toBe(false);
  expect((await sessionRow(pg.db, sessionId))['run_lock_run_id']).toBeNull();

  // The same client_msg_id again: no new run, two frames (meta duplicate + the stored terminal).
  const replay = await send(r, caller, sessionId, body);
  expect(replay.jsons).toEqual([]);
  const again = framesOf(replay.chunks);
  expect(again.map((f) => [f.event, f.id])).toEqual([
    ['meta', 1],
    ['done', 2],
  ]);
  expect(again[0]!.data).toMatchObject({ session_id: sessionId, run_id: runId, duplicate: true });
  expect(again[1]!.data).toEqual((row['final_event'] as Row)['data']);
  expect(await runsOf(pg.db, sessionId)).toHaveLength(1);
  expect(input.texts).toHaveLength(1);
}, 60_000);
