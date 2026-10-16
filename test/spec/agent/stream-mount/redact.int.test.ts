// B3-03f 第 9 节 4：脱敏接线（B3-05a，BR-AI-14 / BR-AI-19；followup 22）。
// 存储形态：消息含手机号与 12 位长数字时，agent_runs.user_text 与用户那条 agent_messages.text 是 B3-05a 存储形态
//   （长数字只留后 4 位），原值不出现在任何 app.agent_* 表的任何列里。
// 模型形态：测试缝的 tools 记下降级口交给 searchKeyword 的计划，关键词里是 <num_k> 占位、没有原值（plan U-3）。
// traceMask：runtime.traceMask(args, 占位表) = maskForTrace(restorePlaceholders(args, 表))——结果不含原值，也不等于
//   原样返回的输入。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { createAgentRedactor } from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import {
  APP,
  PassInputCheck,
  RecordingTools,
  agentTablesText,
  consent,
  framesOf,
  message,
  newMember,
  openAgent,
  openSession,
  rig,
  runRow,
  send,
  usePgEach,
} from './kit.ts';
import { sql } from 'kysely';

const pg = usePgEach(createTestDatabase);

// Synthetic values (not a real person's phone or order).
const PHONE = '13800138000';
const LONG = '987654321012';
const TEXT = `我手机${PHONE}，订单号${LONG}帮我找同款保温杯`;

it('[AC-B3-03f#6][BR-AI-19][BR-AI-14] 存储形态：agent_runs.user_text 与用户消息文本为 B3-05a 存储形态（长数字只留后 4 位），原值不出现在任何 agent_* 表；模型形态：searchKeyword 的关键词里是 <num_k>、没有原值', async () => {
  const caller = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, caller);
  const tools = new RecordingTools();
  const r = await rig(pg.db, { inputCheck: new PassInputCheck(), tools });
  const sessionId = await openSession(r, caller);

  const reply = await send(r, caller, sessionId, message(TEXT));
  expect(reply.jsons).toEqual([]);
  const frames = framesOf(reply.chunks);
  expect(frames[frames.length - 1]!.event).toBe('done');
  const runId = frames[0]!.data['run_id'] as string;

  const stored = (await createAgentRedactor().redact(APP, TEXT)) as string;
  expect(stored).toContain(LONG.slice(-4));
  expect(stored).not.toContain(LONG);
  expect((await runRow(pg.db, runId))['user_text']).toBe(stored);
  const userMessages = await sql<{ text: string | null }>`SELECT text FROM app.agent_messages
    WHERE session_id = ${sessionId} AND role = 'user'`.execute(pg.db);
  expect(userMessages.rows.map((m) => m.text)).toEqual([stored]);

  const everything = await agentTablesText(pg.db);
  expect(everything).not.toContain(PHONE);
  expect(everything).not.toContain(LONG);

  expect(tools.plans).toHaveLength(1);
  const q = tools.plans[0]!.q;
  expect(q).toMatch(/<num_[1-9]\d*>/);
  expect(q).not.toContain(LONG);
  expect(q).not.toContain(PHONE);
}, 60_000);

it('[AC-B3-03f#7][BR-AI-19] runtime.traceMask 先还原占位再转存储形态：结果不含原值，也不等于原样返回的输入', async () => {
  const r = await rig(pg.db);
  const args = { q: '<num_1>', platform: 'taobao' };
  const table = { '<num_1>': LONG };
  const masked = r.runtime.traceMask(args, table);
  expect(JSON.stringify(masked)).not.toContain(LONG);
  expect(masked).not.toEqual(args);
  expect(JSON.stringify(masked)).toContain(LONG.slice(-4));
  expect((masked as Record<string, unknown>)['platform']).toBe('taobao');
  // The inputs are not changed.
  expect(args).toEqual({ q: '<num_1>', platform: 'taobao' });
  expect(table).toEqual({ '<num_1>': LONG });
}, 60_000);
