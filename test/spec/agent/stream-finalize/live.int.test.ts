// B3-03g: RunManager on the PG ports (design §3.1 S3–S7, §6.2 run/** change, §7.2 r4-3 and
// 活进程发 PG 帧): the ending is written inside choose() without waiting for a pending card fact,
// and the frame sent is the one stored (agent_runs.final_event), not the locally chosen one.
// Waits go through a scheduler that never fires on its own: only the body ends the run.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import type { Scheduler } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createRunManager,
  type RunBody,
  type RunSink,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  FakeCards,
  FakeGuard,
  META,
  fixtureCardFrame,
  framesOf,
  texts as runTexts,
  unnumbered,
} from '../stream-run/kit.ts';
import {
  APP,
  START_MS,
  accepted,
  instance,
  limits,
  member,
  newSession,
  request,
  runRow,
  stored,
  usePg,
  type Inst,
} from './kit.ts';

const pg = usePg(createTestDatabase);

const idle: Scheduler = {
  now: () => 0,
  sleep: (_ms, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
};

class Sink implements RunSink {
  readonly chunks: string[] = [];
  #onCard: (() => void) | null = null;
  readonly cardWritten = new Promise<void>((resolve) => (this.#onCard = resolve));
  write(chunk: string): void {
    this.chunks.push(chunk);
    if (chunk.startsWith('event: card\n')) this.#onCard?.();
  }
  onClose(): void {
    // never closes in these tests
  }
}

function manager(inst: Inst) {
  return createRunManager({
    admission: inst.ports.admission,
    registry: inst.ports.registry,
    cards: new FakeCards(),
    texts: runTexts,
    guard: new FakeGuard(),
    clock: inst.clock,
    scheduler: idle,
    config: {
      maxRunMs: 20_000,
      heartbeatMs: 15_000,
      disconnectGraceMs: 60_000,
      guardPollMs: 5_000,
      signalPollMs: 500,
    },
  });
}

it('[AC-B3-03g#45] choose() 即发 S4、不等在途 S3：S3 挂在语句前时 S4 已提交（stop、card_delivered=true），S3 放行后 0 行；发出的终止帧 = final_event', async () => {
  const a = instance(pg.db);
  const session = await newSession(pg.db);
  const { ticket } = accepted(await a.ports.admission.admit(request(member(), session), limits()));
  let s3Reached!: () => void;
  let releaseS3!: () => void;
  const atS3 = new Promise<void>((resolve) => (s3Reached = resolve));
  const s3Gate = new Promise<void>((resolve) => (releaseS3 = resolve));
  a.hooks.onSql('facts', async () => {
    s3Reached();
    await s3Gate;
  });
  let s4Done!: () => void;
  const s4Committed = new Promise<void>((resolve) => (s4Done = resolve));
  a.hooks.onAfterCommit('ending', () => {
    s4Done();
    return Promise.resolve();
  });
  const sink = new Sink();
  const body: RunBody = async (ctx) => {
    void ctx.card(unnumbered(fixtureCardFrame('rebate_quote'))).catch(() => undefined);
    await sink.cardWritten;
    return { kind: 'done', finishReason: 'stop' };
  };
  const run = manager(a).start(
    { ticket, ownerKey: 'u:x', limits: limits(), meta: META, sink },
    body,
  );
  try {
    await atS3;
    await s4Committed;
    const mid = await runRow(pg.db, ticket.runId);
    expect(mid).toMatchObject({ end_reason: 'stop', card_delivered: true, final_event: null });
  } finally {
    releaseS3();
  }
  await run;
  const row = await runRow(pg.db, ticket.runId);
  expect(row).toMatchObject({ end_reason: 'stop', card_delivered: true, settle_result: 'counted' });
  const terminal = framesOf(sink.chunks).at(-1)!;
  expect(stored({ event: terminal.event, data: terminal.data } as never)).toEqual(
    row['final_event'],
  );
  expect(terminal).toMatchObject({
    event: 'done',
    data: { finish_reason: 'stop', quota_left: 99 },
  });
});

it('[AC-B3-03g#46] 取消先提交、本地选了 stop：RunManager 发出的终止帧是 PG 的 done cancelled（不是本地的 stop），结算按 cancelled 计数', async () => {
  const a = instance(pg.db);
  const session = await newSession(pg.db);
  const { ticket } = accepted(await a.ports.admission.admit(request(member(), session), limits()));
  a.clock.set(new Date(START_MS + 4_000));
  expect(await a.ports.cancel({ appId: APP, runId: ticket.runId })).toBe('accepted');
  a.signals.set.clear();
  const sink = new Sink();
  const body: RunBody = () => Promise.resolve({ kind: 'done', finishReason: 'stop' });
  await manager(a).start({ ticket, ownerKey: 'u:x', limits: limits(), meta: META, sink }, body);
  const row = await runRow(pg.db, ticket.runId);
  expect(row).toMatchObject({ end_reason: 'cancelled', settle_result: 'counted' });
  const terminal = framesOf(sink.chunks).at(-1)!;
  expect(terminal.event).toBe('done');
  expect(terminal.data).toEqual({ finish_reason: 'cancelled', quota_left: 99 });
  expect(row['final_event']).toEqual({ type: 'done', data: terminal.data });
});
