// B1-03ze spec-test round 3 (money r1 S1), end to end: a resolution over HTTP publishes
// appeal.resolved on the real event bus of the admin entry; the job it sends to
// evt.notification-appeal-result is handed, as sent, to the handler the real worker assembly
// registers for that queue (test/spec/notification/appeal-result-message drives the worker the same
// way). The consumer accepts it — it never fails into retries and the dead letter queue — and writes
// one APPEAL_RESULT inbox message in BR-TEXT-23 wording (the reauthorization sentence only when the
// event says need_reauth); a second delivery adds nothing.
import { expect, it, vi } from 'vitest';
import {
  JOB_QUEUE,
  type JobQueue,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { assembled, handlersOf } from '../appeal-restore/worker-kit.ts';
import {
  EXTRA,
  appealOf,
  binding,
  resolution,
  resolvedEvents,
  seed,
  setup,
  type Decision,
  type Scenario,
} from './kit.ts';

const h = useHarness();

const ALL = ['risk.appeal', ...EXTRA];
const QUEUE = 'evt.notification-appeal-result';
const CONSUMER = 'notification-appeal-result';
// Expected wording is literal BR-TEXT-23 text, never imported from production templates.
const TITLE = '申诉结果';
const REVOKED = '你的申诉已通过，相关限制已解除。';
const REAUTH = '你的申诉已通过，相关限制已解除。购物前需重新完成淘宝授权。';
const UPHELD = '你的申诉已处理，维持原处理结果。如有疑问请联系客服。';

/** The app's inbox messages, notify logs and the consumer's processed event of `eventId`. */
async function delivered(s: Scenario, eventId: string) {
  return {
    inbox: await s.h.db
      .selectFrom('inbox_messages')
      .selectAll()
      .where('app_id', '=', s.appId)
      .execute(),
    logs: await s.h.db
      .selectFrom('notify_logs')
      .selectAll()
      .where('app_id', '=', s.appId)
      .execute(),
    processed: await s.h.db
      .selectFrom('processed_events')
      .select(['consumer', 'event_id'])
      .where('consumer', '=', CONSUMER)
      .where('event_id', '=', eventId)
      .execute(),
  };
}

it.each<[string, 'banned' | 'frozen', Decision, string]>([
  ['撤销封禁（淘宝绑定因解封改为 invalid）', 'banned', 'revoked', REAUTH],
  ['撤销冻结', 'frozen', 'revoked', REVOKED],
  ['维持封禁', 'banned', 'upheld', UPHELD],
])(
  '[AC-B1-03ze#77] %s：结案真实发布的 appeal.resolved 由 worker 的 notification-appeal-result 消费成功（无死信），写一条 APPEAL_RESULT 站内信，重投不加信',
  async (_label, kind, decision, body) => {
    const s = await setup(h, { grants: ALL });
    const { row, user } = await seed(s, kind);
    if (kind === 'banned') {
      await binding(s, user!.id, { status: 'blocked', blocked_reason: 'ban' });
    }
    const token = decision === 'revoked' ? await s.issue() : null;
    const queue = s.f.app.get<JobQueue>(JOB_QUEUE);
    const original = queue.send.bind(queue);
    const sent: Parameters<JobQueue['send']>[] = [];
    const send = vi.spyOn(queue, 'send').mockImplementation(async (...args) => {
      sent.push(args);
      return original(...args);
    });
    try {
      await appealOf(await s.resolve(row.id, resolution(decision, 0), token));
    } finally {
      send.mockRestore();
    }
    const events = await resolvedEvents(s);
    expect(events).toHaveLength(1);
    const jobs = sent.filter(([target]) => target === QUEUE);
    expect(jobs, `one job sent to ${QUEUE}`).toHaveLength(1);
    const [queueName, name, payload, options] = jobs[0]!;
    expect(name).toBe('appeal.resolved');
    expect(options.id).toBe(events[0]!.event_id);
    const job: ReceivedJob = {
      id: events[0]!.event_id,
      queue: queueName,
      name,
      payload,
      attempt: 1,
    };

    const worker = await assembled('worker', s.h.db, s.f.clock);
    try {
      const handlers = handlersOf(worker, QUEUE);
      expect(handlers).toHaveLength(1);
      // A rejected job is retried and then dead-lettered: the first delivery must succeed.
      await expect(handlers[0]!(job)).resolves.toBeUndefined();
      const first = await delivered(s, job.id);
      expect(first.inbox).toMatchObject([
        {
          app_id: s.appId,
          user_id: user!.id,
          code: 'APPEAL_RESULT',
          title: TITLE,
          body,
          route: null,
          read_at: null,
        },
      ]);
      expect(first.logs).toMatchObject([
        {
          app_id: s.appId,
          user_id: user!.id,
          code: 'APPEAL_RESULT',
          channel: 'inbox',
          status: 'success',
          dedupe_key: `appeal.resolved:${job.id}`,
        },
      ]);
      expect(first.processed).toEqual([{ consumer: CONSUMER, event_id: job.id }]);
      await expect(handlers[0]!({ ...job, attempt: 2 })).resolves.toBeUndefined();
      expect(await delivered(s, job.id)).toEqual(first);
      expect(worker.sends).not.toHaveBeenCalled();
    } finally {
      await worker.close();
    }
  },
);
