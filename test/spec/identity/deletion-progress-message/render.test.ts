// B1-15i: the DELETION_PROGRESS renderer (08 BR-TEXT-23 细则模板表, BR-TEXT-11 未来时间格式,
// BR-TEXT-10 金额, BR-TEXT-09 细则标题表; brief §9.1). Pure: no database.
// {cancel_deadline}: Asia/Shanghai (+08:00), 24-hour clock, "MM-DD HH:mm" in the +08:00 year of the
// clock's now and "YYYY-MM-DD HH:mm" otherwise (BR-TEXT-11: future times never use a relative
// word; as RISK_STATE_CHANGED {frozen_until}, B1-12g). The oracle of the property is Intl.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderDeletionProgressMessage } from '../../../../apps/api/src/modules/notification/application/deletion-progress-message.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { AMOUNTS, CANCELLED_BODY, TITLE, negativeBody, requestedBody } from './texts.ts';

const SUBJECT = {
  app_id: 'couli',
  user_id: '019a3c00-0000-7000-8000-000000000001',
  deletion_request_id: '019a3c00-0000-7000-8000-0000000000aa',
} as const;
const COOLING_MS = 7 * 24 * 60 * 60 * 1000;

function requested(now: string, deadline: string) {
  return renderDeletionProgressMessage(
    { ...SUBJECT, variant: 'requested', cancel_deadline: new Date(deadline) },
    null,
    new FixedClock(now),
  );
}

describe('defaults', () => {
  it('[AC-B1-15i#1] requested：服务类、只站内信、标题「注销进度」、正文照抄模板（cancel_deadline +08:00）', () => {
    expect(requested('2026-10-16T02:00:00.000Z', '2026-10-23T02:00:00.000Z')).toEqual({
      code: 'DELETION_PROGRESS',
      variant: 'requested',
      category: 'service',
      channels: ['inbox'],
      title: TITLE,
      body: requestedBody('10-23 10:00'),
      route: null,
    });
  });

  it('[AC-B1-15i#2] cancelled：正文「已撤回注销申请，账号恢复正常使用。」', () => {
    const message = renderDeletionProgressMessage(
      { ...SUBJECT, variant: 'cancelled' },
      null,
      new FixedClock('2026-10-16T02:00:00.000Z'),
    );
    expect(message).toEqual({
      code: 'DELETION_PROGRESS',
      variant: 'cancelled',
      category: 'service',
      channels: ['inbox'],
      title: TITLE,
      body: CANCELLED_BODY,
      route: null,
    });
  });

  it.each(AMOUNTS)(
    '[AC-B1-15i#3] cancelled_negative：待扣回 %s 分 → {amount}=%s（BR-TEXT-10）',
    (fen, text) => {
      const message = renderDeletionProgressMessage(
        { ...SUBJECT, variant: 'cancelled_negative', amount_fen: fen },
        null,
        new FixedClock('2026-10-21T04:00:00.000Z'),
      );
      expect(message).toEqual({
        code: 'DELETION_PROGRESS',
        variant: 'cancelled_negative',
        category: 'service',
        channels: ['inbox'],
        title: TITLE,
        body: negativeBody(text),
        route: null,
      });
    },
  );
});

describe('{cancel_deadline}', () => {
  it.each([
    ['同年、整点', '2026-10-16T02:00:00.000Z', '2026-10-23T02:00:00.000Z', '10-23 10:00'],
    [
      'UTC 下午、+08:00 已是次日',
      '2026-10-16T17:30:00.000Z',
      '2026-10-23T17:30:00.000Z',
      '10-24 01:30',
    ],
    ['+08:00 零点后、补零', '2026-10-09T16:05:00.000Z', '2026-10-16T16:05:00.000Z', '10-17 00:05'],
    ['秒与毫秒不进位', '2026-10-16T02:00:59.999Z', '2026-10-23T02:00:59.999Z', '10-23 10:00'],
    [
      '+08:00 跨年（UTC 仍同年）带年份',
      '2026-12-24T16:30:00.000Z',
      '2026-12-31T16:30:00.000Z',
      '2027-01-01 00:30',
    ],
    [
      'now 的 +08:00 已是新年 → 同年不带年份',
      '2026-12-31T16:30:00.000Z',
      '2027-01-07T16:30:00.000Z',
      '01-08 00:30',
    ],
    ['跨年带年份', '2026-12-28T03:00:00.000Z', '2027-01-04T03:00:00.000Z', '2027-01-04 11:00'],
  ] as const)('[AC-B1-15i#4] %s：%s 申请 → %s 截止 → 「%s」', (_name, now, deadline, text) => {
    expect(requested(now, deadline).body).toBe(requestedBody(text));
  });

  it('[AC-B1-15i#5] 任意申请时刻：截止 = +08:00 的 MM-DD HH:mm（同年）或 YYYY-MM-DD HH:mm（跨年），无相对词', () => {
    const parts = (at: Date) => {
      const out: Record<string, string> = {};
      for (const part of new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(at)) {
        out[part.type] = part.value;
      }
      return out;
    };
    const from = Date.parse('2020-01-01T00:00:00.000Z');
    const to = Date.parse('2035-12-31T00:00:00.000Z');
    fc.assert(
      fc.property(fc.integer({ min: from, max: to }), (applyMs) => {
        const now = new Date(applyMs);
        const deadline = new Date(applyMs + COOLING_MS);
        const at = parts(deadline);
        const time = `${at['month']}-${at['day']} ${at['hour']}:${at['minute']}`;
        const expected = at['year'] === parts(now)['year'] ? time : `${at['year']}-${time}`;
        expect(requested(now.toISOString(), deadline.toISOString()).body).toBe(
          requestedBody(expected),
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe('notify_templates overrides (title and body apply independently, variables unchanged)', () => {
  const clock = () => new FixedClock('2026-10-16T02:00:00.000Z');
  const input = {
    ...SUBJECT,
    variant: 'requested',
    cancel_deadline: new Date('2026-10-23T02:00:00.000Z'),
  } as const;

  it('[AC-B1-15i#6] 只改标题 → 新标题 + 默认正文；只改正文 → 默认标题 + 新正文（变量照填，多处都填）', () => {
    expect(
      renderDeletionProgressMessage(
        input,
        { title_override: '注销提醒', body_override: null },
        clock(),
      ),
    ).toMatchObject({ title: '注销提醒', body: requestedBody('10-23 10:00') });
    expect(
      renderDeletionProgressMessage(
        input,
        {
          title_override: null,
          body_override: '{cancel_deadline} 前可撤回；截止 {cancel_deadline}。',
        },
        clock(),
      ),
    ).toMatchObject({ title: TITLE, body: '10-23 10:00 前可撤回；截止 10-23 10:00。' });
    expect(
      renderDeletionProgressMessage(
        input,
        { title_override: '注销提醒', body_override: '截止 {cancel_deadline}。' },
        clock(),
      ),
    ).toMatchObject({
      code: 'DELETION_PROGRESS',
      variant: 'requested',
      category: 'service',
      channels: ['inbox'],
      title: '注销提醒',
      body: '截止 10-23 10:00。',
      route: null,
    });
  });

  it('[AC-B1-15i#7] cancelled_negative 覆盖正文里的 {amount} 照 BR-TEXT-10 填；替换文字按字面（$ 不作替换模式）', () => {
    const message = renderDeletionProgressMessage(
      { ...SUBJECT, variant: 'cancelled_negative', amount_fen: 1234n },
      {
        title_override: null,
        body_override: '待扣回 {amount}（$& $1 $$），{amount} 抵扣后可再申请。',
      },
      clock(),
    );
    expect(message).toMatchObject({
      title: TITLE,
      body: '待扣回 ¥12.34（$& $1 $$），¥12.34 抵扣后可再申请。',
    });
  });

  it('[AC-B1-15i#8] cancelled 覆盖：标题与正文都用覆盖', () => {
    const message = renderDeletionProgressMessage(
      { ...SUBJECT, variant: 'cancelled' },
      { title_override: '注销已撤回', body_override: '你已撤回注销。' },
      clock(),
    );
    expect(message).toEqual({
      code: 'DELETION_PROGRESS',
      variant: 'cancelled',
      category: 'service',
      channels: ['inbox'],
      title: '注销已撤回',
      body: '你已撤回注销。',
      route: null,
    });
  });
});
