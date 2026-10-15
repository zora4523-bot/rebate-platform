// B3-03i 第 9 节 7（HTTP 部分）：发消息被受理后，runs.start 收到的 RunStart 多一个 appId = caller.appId
// （规划 B3-05-plan §1.3 G-1，供 RunManager 按 run 取守卫），其余字段与 B3-03d 相同（ticket、ownerKey、
// limits、meta、sink）。B3-03d 的测试与 kit（test/spec/agent/stream-http/**）照用、不改。
import { expect, it } from 'vitest';

import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import {
  LABELS,
  SOURCE_LIMITS,
  expectStream,
  guest,
  member,
  message,
  modelLabelOf,
  ownerKeyOf,
  rig,
  send,
} from '../stream-http/kit.ts';

/** A brand other than the stream-http kit's default app, so a constant cannot pass. */
const BRAND_B = 'couli-brand-b';

it('[AC-B3-03i#27][BR-AI-13][BR-AI-12] 受理后 runs.start 收到 appId = caller.appId（游客、未绑手机、已绑手机，两个品牌）；其余字段不变：ticket、ownerKey、limits、meta、sink，不多不少', async () => {
  const r = rig();
  const callers: AgentCaller[] = [
    { ...guest(), appId: BRAND_B },
    { ...member({ phoneBound: false }), appId: BRAND_B },
    member({ phoneBound: true }),
    guest(),
  ];
  for (const [i, caller] of callers.entries()) {
    const label = `${caller.appId}/${caller.userId === null ? 'guest' : String(caller.phoneBound)}`;
    const sessionId = r.sessions.add(caller);
    const reply = await send(r, caller, sessionId, message());
    expectStream(reply);
    expect(r.starts, label).toHaveLength(i + 1);
    const start = r.starts[i]!;
    const req = r.admission.admits[i]!.req;
    expect(Object.keys(start).sort(), label).toEqual([
      'appId',
      'limits',
      'meta',
      'ownerKey',
      'sink',
      'ticket',
    ]);
    expect(start.appId, label).toBe(caller.appId);
    expect(start.ticket, label).toEqual(r.admission.tickets[i]);
    expect(start.ownerKey, label).toBe(ownerKeyOf(caller));
    expect(start.limits, label).toEqual(SOURCE_LIMITS);
    expect(start.meta, label).toEqual({
      message_id: req.reply.assistantMessageId,
      prompt_version: LABELS.promptVersion,
      model_label: modelLabelOf(LABELS.modelSnapshot),
      ai_label: LABELS.aiLabel,
    });
    expect(typeof start.sink.write, label).toBe('function');
  }
});
