import { expect, it } from 'vitest';
import { judgeDrill, type DrillJobView } from '../../../../infra/drills/queue/drill.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

function view(id: string, over: Partial<DrillJobView> = {}): DrillJobView {
  return { id, state: 'completed', deliveries: 1, effects: 1, ...over };
}

it('[02 §11 至少一次投递] 重复投递但业务效果各一次：判定通过，并计出重投数', () => {
  const verdict = judgeDrill([A, B, C], {
    jobs: [view(A), view(B, { deliveries: 3 }), view(C, { state: 'absent', deliveries: 2 })],
  });
  expect(verdict).toEqual({ problems: [], redelivered: 2 });
});

it('[02 §18 消费端去重] 同一任务产生第二次业务效果：duplicate_effect', () => {
  const verdict = judgeDrill([A, B], { jobs: [view(A), view(B, { deliveries: 2, effects: 2 })] });
  expect(verdict.problems).toEqual([{ code: 'duplicate_effect', id: B, step: null }]);
  expect(verdict.redelivered).toBe(1);
});

it('[QA-05 任务不丢] 已入队任务没有业务效果（含快照里查不到）：lost', () => {
  const verdict = judgeDrill([A, B, C], {
    jobs: [view(A, { effects: 0 }), view(B, { state: 'absent', effects: 0 })],
  });
  expect(verdict.problems).toEqual([
    { code: 'lost', id: A, step: null },
    { code: 'lost', id: B, step: null },
    { code: 'lost', id: C, step: null },
  ]);
});

it('[02 §11 任一队列 failed >0] 任务终态 failed 单独报出，与 lost 按固定顺序并列', () => {
  const verdict = judgeDrill([A, B], {
    jobs: [view(A, { state: 'failed', effects: 0 }), view(B, { state: 'failed' })],
  });
  expect(verdict.problems).toEqual([
    { code: 'lost', id: A, step: null },
    { code: 'failed', id: A, step: null },
    { code: 'failed', id: B, step: null },
  ]);
});

it.each(['created', 'retry', 'active'] as const)(
  '[QA-05 排空] 状态 %s 的任务只报 not_drained，不同时报 lost',
  (state) => {
    const verdict = judgeDrill([A], { jobs: [view(A, { state, effects: 0 })] });
    expect(verdict.problems).toEqual([{ code: 'not_drained', id: A, step: null }]);
  },
);

it('[02 §14 Redis 行 不补投] 快照中出现未发送的任务：unexpected_job，排在已发送任务的问题之后并按 id 升序', () => {
  const verdict = judgeDrill([B], {
    jobs: [view(C), view(B, { effects: 0 }), view(A)],
  });
  expect(verdict.problems).toEqual([
    { code: 'lost', id: B, step: null },
    { code: 'unexpected_job', id: A, step: null },
    { code: 'unexpected_job', id: C, step: null },
  ]);
  expect(verdict.redelivered).toBe(0);
});
