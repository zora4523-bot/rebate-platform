// PG entry is the shared stream test kit; never executed on the Codex host.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createAgentStreamRuntime,
  createProductionStreamAssembly,
  type AgentStreamAssembly,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type { StreamReviewOptions } from '../../../../apps/api/src/modules/agent/stream/mount/review.ts';
import { fixture as businessFixture, LINK } from '../stream-assembly/kit.ts';
import {
  contentReaderFor,
  fileText,
  framesOf,
  message,
  openSession,
  send,
  runsOf,
  usePgEach,
  until,
} from '../stream-mount/kit.ts';
import { credentials, endpoint, transport, type Answer } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(
  answers: readonly Answer[] = ['none'],
  patch: Partial<StreamReviewOptions> = {},
) {
  const f = await businessFixture(pg.db);
  const wire = transport(answers);
  const safety: StreamReviewOptions = {
    appEnv: 'staging',
    credentials,
    endpoint,
    fetch: wire.fetch,
    nonce: () => 'synthetic-mount-nonce',
    ...patch,
  };
  let assembly: AgentStreamAssembly | undefined;
  const body = vi.spyOn(core, 'createAgentRunBody');
  const runtime = createAgentStreamRuntime(
    {
      db: pg.db,
      clock: f.time.clock,
      logger: f.logs.logger,
      contentReader: contentReaderFor(pg.db, f.time.clock),
      consentReader: f.consentReader,
      assembly(context) {
        assembly = createProductionStreamAssembly({
          ...context,
          safety,
          ports: {
            platforms: f.deps.ports.search.platforms,
            searchProducts: f.searchProducts,
            readProduct: f.readProduct,
            parsing: f.deps.ports.parsing,
            cards: f.cards,
          },
        });
        return assembly;
      },
    },
    { schedule: f.time.scheduler },
  );
  return { ...f, ...wire, runtime, body, assembly };
}

it.each([
  { credentials: undefined },
  { credentials: { ...credentials, accessKeyId: '' } },
  { credentials: { ...credentials, accessKeySecret: '' } },
  { endpoint: undefined },
  { appEnv: 'local' },
  { appEnv: 'test' },
] satisfies Partial<StreamReviewOptions>[])(
  '[AC-B3-03m#16][BR-AI-18] 生产装配缺配置/非生产环境拒绝，零网络无卡并退款：%j',
  async (patch) => {
    const r = await mount(['none'], patch);
    try {
      expect(r.assembly?.safety).toBeDefined();
      const session = await openSession(r, r.caller);
      for (const text of ['保温杯', '感冒该吃什么药', LINK]) {
        const reply = await send(r, r.caller, session, message(text));
        const frames = framesOf(reply.chunks);
        expect(
          frames
            .filter((frame) => frame.event === 'text.delta')
            .map((frame) => frame.data['delta'])
            .join(''),
        ).toBe(fileText('agent.refuse.safety_unavailable'));
        expect(frames.at(-1)).toMatchObject({ event: 'done', data: { finish_reason: 'safety' } });
        expect(frames.filter((frame) => frame.event === 'card')).toEqual([]);
      }
      expect(await runsOf(pg.db, session)).toHaveLength(3);
      for (const row of await runsOf(pg.db, session))
        expect(row).toMatchObject({
          end_reason: 'input_review_timeout',
          settle_result: 'refunded',
          card_delivered: false,
        });
      expect(r.fetch).not.toHaveBeenCalled();
      expect(r.unexpectedFetch).not.toHaveBeenCalled();
      expect(r.searchProducts).not.toHaveBeenCalled();
      expect(r.readProduct).not.toHaveBeenCalled();
      expect(r.resolveLink).not.toHaveBeenCalled();
      expect(r.cards).not.toHaveBeenCalled();
    } finally {
      await r.runtime.close();
    }
  },
  120_000,
);

it.each(['high', 'medium', 'low', 'http', 'code', 'json', 'throw', 'unknown'] satisfies Answer[])(
  '[AC-B3-03m#17][BR-AI-18] 生产装配输入 %s 拒绝，命中计额度、不可用退还',
  async (answer) => {
    const r = await mount([answer]);
    try {
      expect(r.assembly?.safety).toBeDefined();
      const session = await openSession(r, r.caller);
      const frames = framesOf((await send(r, r.caller, session, message('保温杯'))).chunks);
      const blocked = ['high', 'medium', 'low'].includes(answer);
      expect(
        frames
          .filter((frame) => frame.event === 'text.delta')
          .map((frame) => frame.data['delta'])
          .join(''),
      ).toBe(fileText(`agent.refuse.${blocked ? 'unsafe' : 'safety_unavailable'}`));
      expect(frames.at(-1)).toMatchObject({ event: 'done', data: { finish_reason: 'safety' } });
      expect(frames.filter((frame) => frame.event === 'card')).toEqual([]);
      const rows = await runsOf(pg.db, session);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        settle_result: blocked ? 'counted' : 'refunded',
        card_delivered: false,
      });
      if (!blocked) expect(rows[0]?.['end_reason']).toBe('input_review_timeout');
      expect(r.fetch).toHaveBeenCalledTimes(1);
      expect(r.searchProducts).not.toHaveBeenCalled();
      expect(r.readProduct).not.toHaveBeenCalled();
      expect(r.cards).not.toHaveBeenCalled();
    } finally {
      await r.runtime.close();
    }
  },
  120_000,
);

it.each(['保温杯', LINK])(
  '[AC-B3-03m#18] 生产 runtime 消费真实审核端口，输入 none 进入业务路径：%s',
  async (text) => {
    const r = await mount();
    try {
      expect(r.assembly?.safety).toBeDefined();
      const deps = r.body.mock.calls.at(-1)?.[0];
      expect(deps?.inputCheck).toBe(r.assembly?.safety?.inputCheck);
      expect(deps?.review).toBe(r.assembly?.safety?.review);
      const session = await openSession(r, r.caller);
      const frames = framesOf((await send(r, r.caller, session, message(text))).chunks);
      expect(r.fetch).toHaveBeenCalled();
      expect(frames.filter((frame) => frame.event === 'card').length).toBeGreaterThan(0);
      expect(frames.at(-1)?.data['finish_reason']).not.toBe('safety');
      if (text === LINK) {
        expect(r.resolveLink).toHaveBeenCalled();
        expect(frames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: 'card',
              data: expect.objectContaining({
                type: 'notice',
                data: expect.objectContaining({ text_key: 'error.30132' }),
              }),
            }),
          ]),
        );
        expect(r.searchProducts).not.toHaveBeenCalled();
      } else expect(r.searchProducts).toHaveBeenCalledTimes(1);
      expect((await runsOf(pg.db, session))[0]).toMatchObject({
        settle_result: 'counted',
        card_delivered: text !== LINK,
      });
    } finally {
      await r.runtime.close();
    }
  },
  120_000,
);

it('[AC-B3-03m#19] 生产装配输入请求挂起，到配置时限退款且终止请求', async () => {
  const r = await mount(['hang'], { timeoutMs: 250 });
  try {
    expect(r.assembly?.safety).toBeDefined();
    const session = await openSession(r, r.caller);
    const pending = send(r, r.caller, session, message('保温杯'));
    await until('synthetic review requested', () => r.calls.length === 1);
    await r.time.to(250);
    const frames = framesOf((await pending).chunks);
    expect(
      frames
        .filter((frame) => frame.event === 'text.delta')
        .map((frame) => frame.data['delta'])
        .join(''),
    ).toBe(fileText('agent.refuse.safety_unavailable'));
    expect(frames.at(-1)).toMatchObject({ event: 'done', data: { finish_reason: 'safety' } });
    expect((await runsOf(pg.db, session))[0]).toMatchObject({
      end_reason: 'input_review_timeout',
      settle_result: 'refunded',
      card_delivered: false,
    });
    expect(r.calls[0]?.init.signal.aborted).toBe(true);
    expect(r.searchProducts).not.toHaveBeenCalled();
    expect(r.cards).not.toHaveBeenCalled();
  } finally {
    await r.runtime.close();
  }
}, 120_000);
