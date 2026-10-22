import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalEvalAgent } from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import { emptyOrchestratorTools } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createInputCheck } from '../../../../apps/api/src/modules/agent/preprocess/input/index.ts';
import * as assembly from '../../../../apps/api/src/modules/agent/stream/mount/body.ts';
import {
  APP,
  ManualTime,
  consent,
  fileText,
  framesOf,
  message,
  newGuest,
  openAgent,
  openSession,
  rig,
  send,
  setConfig,
  usePgEach,
} from '../stream-mount/kit.ts';
import { dependencies, input, ports } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => {
  vi.restoreAllMocks();
});

// Compare every data field. Only opaque IDs and card numbering may differ; quota, labels,
// text, finish reason and ordering are deliberately retained.
function normalized(frames: { event: string; data: Record<string, unknown> }[]) {
  return frames.map(({ event, data }) => {
    const copy = structuredClone(data);
    for (const field of ['session_id', 'run_id', 'message_id', 'card_id']) {
      if (field in copy) copy[field] = `<${field}>`;
    }
    return { event, data: copy };
  });
}

it('[AC-B3-05m#1][BR-AI-21] 本机与 stream 共用生产装配，默认 no_model/null prompt 的完整帧序列一致', async () => {
  const shared = vi.spyOn(assembly, 'createAgentBodyAssembly');
  const review = { review: async () => 'pass' as const };
  const time = new ManualTime();
  const tools = emptyOrchestratorTools();
  const inputCheck = createInputCheck({
    review,
    scheduler: time.scheduler,
    texts: { text: async (_appId, key) => fileText(key) },
  });
  const agent = createLocalEvalAgent(dependencies({ review, clock: time.clock, catalog: tools }));
  const live = ports();
  const local = await agent(input(), live);
  expect(shared.mock.calls.length).toBeGreaterThan(0);
  const localAssemblyCount = shared.mock.calls.length;
  const caller = await newGuest(pg.db);
  await openAgent(pg.db);
  await setConfig(pg.db, APP, 'agent.guest_daily_quota', 1);
  await setConfig(pg.db, APP, 'agent.guest_ip_daily_quota', 1);
  await consent(pg.db, caller);
  const runtime = await rig(pg.db, { tools, inputCheck });
  try {
    const sessionId = await openSession(runtime, caller);
    const reply = await send(runtime, caller, sessionId, message(input().text));
    expect(reply.jsons).toEqual([]);
    expect(shared.mock.calls.length).toBeGreaterThan(localAssemblyCount);
    const production = framesOf(reply.chunks);
    expect(production.map((frame) => frame.event)).toEqual(['meta', 'card', 'done']);
    expect(production.at(-1)).toMatchObject({ data: { finish_reason: 'fallback', quota_left: 0 } });
    expect(normalized(local.frames)).toEqual(normalized(production));
    expect(live.model).not.toHaveBeenCalled();
    expect(live.tool).not.toHaveBeenCalled();
  } finally {
    await runtime.runtime.close();
  }
}, 60_000);
